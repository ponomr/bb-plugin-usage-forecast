// Thread state for the `thread` RPC, the CLI and auto-compact: context fill
// from `threads.context`, the busy state from `threads.get`, the per-thread
// override from plugin metadata, and the effective auto-compact policy.
// Host answers are parsed here, at the boundary.

import { z } from "zod";
import {
  CONTEXT_LIMIT_DEFAULT_TOKENS,
  CONTEXT_LIMIT_MAX_TOKENS,
  CONTEXT_LIMIT_MIN_TOKENS,
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
  /** The working context limit in tokens; the thread's window caps it. */
  contextLimitTokens: number;
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
    contextLimitTokens: clampInt(
      raw?.contextLimitTokens,
      CONTEXT_LIMIT_MIN_TOKENS,
      CONTEXT_LIMIT_MAX_TOKENS,
      CONTEXT_LIMIT_DEFAULT_TOKENS,
    ),
  };
}

/** The configured working limit before the window caps it. */
export interface ContextLimit {
  tokens: number;
  source: "settings" | "thread";
}

export function contextLimitOf(override: ThreadOverride, settings: PluginSettings): ContextLimit {
  return override.limitTokens === undefined
    ? { tokens: settings.contextLimitTokens, source: "settings" }
    : { tokens: override.limitTokens, source: "thread" };
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
): Omit<ThreadState["autoCompact"], "effectiveThresholdPercent" | "effectiveThresholdTokens"> {
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
 * Codex gives only `usedTokens` and `modelContextWindow`. The percent is of
 * the working limit, which the window caps.
 */
export function readContext(answer: unknown, limit: ContextLimit): ThreadContext | null {
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
  const limitTokens = Math.min(limit.tokens, windowTokens);
  return {
    usedTokens,
    windowTokens,
    limitTokens,
    limitSource: limitTokens < limit.tokens ? "window" : limit.source,
    percent: (usedTokens / limitTokens) * 100,
    estimated: usage.estimated ?? false,
    autoCompactAtTokens: snapshot?.autoCompactAtTokens ?? null,
    categories,
  };
}

// Claude Code compacts on its own at `autoCompactAtTokens` (78 % of its
// window on bb 0.49). A threshold at or above that never fires, so the
// effective threshold is capped PROVIDER_MARGIN_PERCENT of the window below
// it: the plugin then compacts between turns, before the provider does it in
// the middle of one. The threshold is a percent of the working limit; with a
// limit well below the window the cap never applies.
export const PROVIDER_MARGIN_PERCENT = 2;

/** Where the provider compacts on its own, as a percent of its window. */
export function providerCompactsAtPercent(context: ThreadContext | null): number | null {
  if (!context?.autoCompactAtTokens || context.windowTokens <= 0) return null;
  return (context.autoCompactAtTokens / context.windowTokens) * 100;
}

/** The threshold the plugin acts on, as a percent of the working limit. */
export function effectiveThreshold(thresholdPercent: number, context: ThreadContext | null): number {
  if (!context?.autoCompactAtTokens || context.limitTokens <= 0) return thresholdPercent;
  const capTokens = context.autoCompactAtTokens - (PROVIDER_MARGIN_PERCENT / 100) * context.windowTokens;
  const capPercent = (capTokens / context.limitTokens) * 100;
  if (thresholdPercent < capPercent) return thresholdPercent;
  return Math.max(THRESHOLD_MIN_PERCENT, Math.floor(capPercent));
}

/** The same threshold in tokens, or null without a measurement. */
export function effectiveThresholdTokens(thresholdPercent: number, context: ThreadContext | null): number | null {
  if (context === null) return null;
  return Math.round((effectiveThreshold(thresholdPercent, context) / 100) * context.limitTokens);
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
  const ctx = readContext(context, contextLimitOf(override, settings));
  const policy = effectivePolicy(override, settings);
  return {
    threadId,
    providerId,
    active,
    context: ctx,
    override,
    autoCompact: {
      ...policy,
      effectiveThresholdPercent: effectiveThreshold(policy.thresholdPercent, ctx),
      effectiveThresholdTokens: effectiveThresholdTokens(policy.thresholdPercent, ctx),
    },
    compactSupported: providerId === null || !unsupported.includes(providerId),
    cooldownUntil: cooldown !== null && cooldown > now ? cooldown : null,
  };
}
