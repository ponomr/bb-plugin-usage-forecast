// Thread state for the `thread` RPC, the CLI and auto-compact: context fill
// from `threads.context`, the busy state from `threads.get`, the per-thread
// override from plugin metadata, and the effective auto-compact policy.
// Host answers are parsed here, at the boundary.

import { z } from "zod";
import {
  contextCategorySchema,
  normalizeOverride,
  overrideSchema,
  POLL_DEFAULT_MINUTES,
  POLL_MAX_MINUTES,
  POLL_MIN_MINUTES,
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type ThreadContext,
  type ThreadOverride,
  type ThreadState,
} from "../shared/contract";
import type { Storage } from "./storage";

export interface PluginSettings {
  autoCompactEnabled: boolean;
  autoCompactThresholdPercent: number;
  pollIntervalMinutes: number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Settings values are untrusted: out-of-range numbers are clamped, wrong types fall back. */
export function parseSettings(raw: Record<string, unknown> | null | undefined): PluginSettings {
  return {
    autoCompactEnabled: raw?.autoCompactEnabled === true,
    autoCompactThresholdPercent: clampInt(
      raw?.autoCompactThresholdPercent,
      THRESHOLD_MIN_PERCENT,
      THRESHOLD_MAX_PERCENT,
      THRESHOLD_DEFAULT_PERCENT,
    ),
    pollIntervalMinutes: clampInt(raw?.pollIntervalMinutes, POLL_MIN_MINUTES, POLL_MAX_MINUTES, POLL_DEFAULT_MINUTES),
  };
}

export const INHERIT: ThreadOverride = { autoCompact: "inherit" };

/** The stored override, or `inherit` when there is none or it is malformed. */
export function parseOverride(metadata: unknown): ThreadOverride {
  const value = (metadata as { override?: unknown } | null)?.override;
  const parsed = overrideSchema.safeParse(value);
  if (!parsed.success) return INHERIT;
  return normalizeOverride(parsed.data);
}

export function effectivePolicy(
  override: ThreadOverride,
  settings: PluginSettings,
): Omit<ThreadState["autoCompact"], "effectiveThresholdPercent"> {
  if (override.autoCompact === "inherit") {
    return {
      enabled: settings.autoCompactEnabled,
      thresholdPercent: settings.autoCompactThresholdPercent,
      source: "settings",
    };
  }
  return {
    enabled: override.autoCompact === "on",
    thresholdPercent: override.thresholdPercent ?? settings.autoCompactThresholdPercent,
    source: "thread",
  };
}

const usageInput = z.object({
  usedTokens: z.number(),
  modelContextWindow: z.number().nullish(),
  estimated: z.boolean().optional(),
  snapshot: z
    .object({
      contextWindowTokens: z.number(),
      autoCompactAtTokens: z.number().nullish(),
      usedTokens: z.number().optional(),
      categories: z.array(z.unknown()).optional(),
    })
    .nullish(),
});

/**
 * Context fill from a `threads.context` answer, or null when the host has no
 * measurement. Claude Code gives a snapshot with the window and a breakdown;
 * Codex gives only `usedTokens` and `modelContextWindow`.
 */
export function readContext(answer: unknown): ThreadContext | null {
  const parsed = usageInput.safeParse((answer as { usage?: unknown } | null)?.usage);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const snapshot = usage.snapshot ?? null;
  const windowTokens = snapshot?.contextWindowTokens ?? usage.modelContextWindow ?? 0;
  if (!(windowTokens > 0)) return null;
  const usedTokens = snapshot?.usedTokens ?? usage.usedTokens;
  const categories = (snapshot?.categories ?? []).flatMap((c) => {
    const one = contextCategorySchema.safeParse(c);
    return one.success ? [one.data] : [];
  });
  return {
    usedTokens,
    windowTokens,
    percent: (usedTokens / windowTokens) * 100,
    estimated: usage.estimated ?? false,
    autoCompactAtTokens: snapshot?.autoCompactAtTokens ?? null,
    categories,
  };
}

// Claude Code compacts on its own at `autoCompactAtTokens` (78 % on bb 0.49).
// A threshold at or above that never fires, so the effective threshold is
// capped PROVIDER_MARGIN_PERCENT below it: the plugin then compacts between
// turns, before the provider does it in the middle of one.
export const PROVIDER_MARGIN_PERCENT = 2;

export function providerCompactsAtPercent(context: ThreadContext | null): number | null {
  if (!context?.autoCompactAtTokens || context.windowTokens <= 0) return null;
  return (context.autoCompactAtTokens / context.windowTokens) * 100;
}

export function effectiveThreshold(thresholdPercent: number, context: ThreadContext | null): number {
  const providerAt = providerCompactsAtPercent(context);
  if (providerAt === null || thresholdPercent < providerAt - PROVIDER_MARGIN_PERCENT) return thresholdPercent;
  return Math.max(THRESHOLD_MIN_PERCENT, Math.floor(providerAt - PROVIDER_MARGIN_PERCENT));
}

const IDLE_STATUSES = new Set(["idle", "error"]);

export interface ThreadInfo {
  providerId: string | null;
  /** True while the agent is answering or the thread is starting or stopping. */
  active: boolean;
}

export function readThreadInfo(answer: unknown): ThreadInfo {
  const thread = (answer ?? {}) as { providerId?: unknown; status?: unknown };
  return {
    providerId: typeof thread.providerId === "string" ? thread.providerId : null,
    active: typeof thread.status === "string" ? !IDLE_STATUSES.has(thread.status) : false,
  };
}

export interface ThreadsSdk {
  get(args: { threadId: string }): Promise<unknown>;
  context(args: { threadId: string }): Promise<unknown>;
  getPluginMetadata(args: { threadId: string }): Promise<unknown>;
  updatePluginMetadata(args: { threadId: string; set?: Record<string, unknown>; remove?: string[] }): Promise<unknown>;
  compact(args: { threadId: string }): Promise<unknown>;
}

export interface ThreadReaderDeps {
  threads: ThreadsSdk;
  storage: Storage;
  settings: () => Promise<PluginSettings>;
  now?: () => number;
}

export async function readThreadState(deps: ThreadReaderDeps, threadId: string): Promise<ThreadState> {
  const now = (deps.now ?? Date.now)();
  const [info, context, metadata, settings, unsupported, cooldown] = await Promise.all([
    deps.threads.get({ threadId }),
    deps.threads.context({ threadId }),
    deps.threads.getPluginMetadata({ threadId }),
    deps.settings(),
    deps.storage.unsupportedProviders(now),
    deps.storage.cooldownUntil(threadId),
  ]);
  const { providerId, active } = readThreadInfo(info);
  const override = parseOverride(metadata);
  const ctx = readContext(context);
  const policy = effectivePolicy(override, settings);
  return {
    threadId,
    providerId,
    active,
    context: ctx,
    override,
    autoCompact: { ...policy, effectiveThresholdPercent: effectiveThreshold(policy.thresholdPercent, ctx) },
    compactSupported: providerId === null || !unsupported.includes(providerId),
    cooldownUntil: cooldown !== null && cooldown > now ? cooldown : null,
  };
}
