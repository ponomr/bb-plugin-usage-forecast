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
  PROVIDER_LIMIT_AUTO,
  PROVIDER_LIMIT_SETTINGS,
  POLL_DEFAULT_MINUTES,
  POLL_MAX_MINUTES,
  POLL_MIN_MINUTES,
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type ContextLimitSource,
  type ThreadContext,
  type ThreadOverride,
  type ThreadState,
} from "../shared/contract";
import type { Storage } from "./storage";

export type LimitProvider = keyof typeof PROVIDER_LIMIT_SETTINGS;

export interface PluginSettings {
  autoCompactEnabled: boolean;
  autoCompactThresholdPercent: number;
  pollIntervalMinutes: number;
  /** The global working context limit in tokens; the thread's window caps it. */
  contextLimitTokens: number;
  /** Per-provider working limit in tokens; PROVIDER_LIMIT_AUTO (0) is auto. */
  providerLimitTokens: Record<LimitProvider, number>;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A per-provider limit: zero, negative or not a number is auto; otherwise clamped to the range. */
function parseProviderLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.round(value) <= 0) return PROVIDER_LIMIT_AUTO;
  return clampInt(value, CONTEXT_LIMIT_MIN_TOKENS, CONTEXT_LIMIT_MAX_TOKENS, PROVIDER_LIMIT_AUTO);
}

const LIMIT_PROVIDERS = Object.keys(PROVIDER_LIMIT_SETTINGS) as LimitProvider[];

export function isLimitProvider(providerId: string | null): providerId is LimitProvider {
  return providerId !== null && Object.hasOwn(PROVIDER_LIMIT_SETTINGS, providerId);
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
    providerLimitTokens: Object.fromEntries(
      LIMIT_PROVIDERS.map((id) => [id, parseProviderLimit(raw?.[PROVIDER_LIMIT_SETTINGS[id]])]),
    ) as Record<LimitProvider, number>,
  };
}

/** The chosen working limit before the window caps it. */
export interface ContextLimit {
  tokens: number;
  source: Exclude<ContextLimitSource, "window">;
}

/**
 * The working limit, in order of precedence: the thread's override, the
 * per-provider setting, the provider's own compaction point (`compactAtTokens`,
 * when known), then the global setting. The window caps it later.
 */
export function contextLimitOf(
  override: ThreadOverride,
  settings: PluginSettings,
  providerId: string | null,
  compactAtTokens: number | null,
): ContextLimit {
  if (override.limitTokens !== undefined) return { tokens: override.limitTokens, source: "thread" };
  const own = isLimitProvider(providerId) ? settings.providerLimitTokens[providerId] : PROVIDER_LIMIT_AUTO;
  if (own > 0) return { tokens: own, source: "provider" };
  if (compactAtTokens !== null && compactAtTokens > 0) return { tokens: compactAtTokens, source: "reported" };
  return { tokens: settings.contextLimitTokens, source: "settings" };
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

/** A `threads.context` answer before a limit is applied. */
export interface Usage {
  usedTokens: number;
  windowTokens: number;
  estimated: boolean;
  /** Where the provider compacts on its own, from this answer's snapshot. */
  autoCompactAtTokens: number | null;
  categories: ThreadContext["categories"];
}

/**
 * The usage in a `threads.context` answer, or null when the host has no
 * measurement. Claude Code gives a snapshot (after a turn ends) with the
 * window, its own compaction point and a breakdown; Codex gives only
 * `usedTokens` and `modelContextWindow`.
 */
export function readUsage(answer: unknown): Usage | null {
  const parsed = usageInput.safeParse((answer as { usage?: unknown } | null)?.usage);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const snapshot = usage.snapshot ?? null;
  const windowTokens = snapshot?.contextWindowTokens ?? usage.modelContextWindow ?? 0;
  if (!(windowTokens > 0)) return null;
  const categories = (snapshot?.categories ?? []).flatMap((c) => {
    const one = contextCategorySchema.safeParse(c);
    return one.success ? [one.data] : [];
  });
  const compactAt = snapshot?.autoCompactAtTokens ?? null;
  return {
    usedTokens: snapshot?.usedTokens ?? usage.usedTokens,
    windowTokens,
    estimated: usage.estimated ?? false,
    autoCompactAtTokens: compactAt !== null && compactAt > 0 ? compactAt : null,
    categories,
  };
}

/**
 * The context fill against a working limit, which the window caps.
 * `autoCompactAtTokens` is the provider's own compaction point when known.
 */
export function measure(usage: Usage, limit: ContextLimit, autoCompactAtTokens: number | null = usage.autoCompactAtTokens): ThreadContext {
  const limitTokens = Math.min(limit.tokens, usage.windowTokens);
  return {
    usedTokens: usage.usedTokens,
    windowTokens: usage.windowTokens,
    limitTokens,
    limitSource: limitTokens < limit.tokens ? "window" : limit.source,
    percent: (usage.usedTokens / limitTokens) * 100,
    estimated: usage.estimated,
    autoCompactAtTokens,
    categories: usage.categories,
  };
}

/**
 * Context fill from a `threads.context` answer with the limit chosen by
 * `contextLimitOf`; `rememberedCompactAt` stands in when the answer has no
 * snapshot. Null when the host has no measurement.
 */
export function readContext(
  answer: unknown,
  override: ThreadOverride,
  settings: PluginSettings,
  providerId: string | null,
  rememberedCompactAt: number | null = null,
): ThreadContext | null {
  const usage = readUsage(answer);
  if (usage === null) return null;
  const compactAt = usage.autoCompactAtTokens ?? rememberedCompactAt;
  return measure(usage, contextLimitOf(override, settings, providerId, compactAt), compactAt);
}

/**
 * Context fill from a `threads.context` answer with the thread's limit. A
 * compaction point in the answer is remembered per provider and window; an
 * answer without one (an answering Claude Code thread, or one whose snapshot
 * is gone) uses the remembered point, so the limit does not jump between
 * turns. Null when the host has no measurement.
 */
export async function measureThread(
  storage: Storage,
  answer: unknown,
  providerId: string | null,
  override: ThreadOverride,
  settings: PluginSettings,
  now: number,
): Promise<ThreadContext | null> {
  const usage = readUsage(answer);
  if (usage === null) return null;
  let compactAt = usage.autoCompactAtTokens;
  if (providerId !== null) {
    if (compactAt !== null) {
      try {
        await storage.rememberCompactPoint(providerId, usage.windowTokens, compactAt, now);
      } catch {
        // Remembering only steadies later reads; this reading stands.
      }
    } else {
      compactAt = await storage.compactPoint(providerId, usage.windowTokens);
    }
  }
  return measure(usage, contextLimitOf(override, settings, providerId, compactAt), compactAt);
}

// A provider compacts on its own at `autoCompactAtTokens` when it reports one
// (Claude Code on bb 0.49: its window minus a 33 000-token buffer, 167 000 of
// a 200 000 window, 117 000 of a 150 000 one; Codex reports none). A
// threshold at or above that never fires, so the effective threshold is
// capped PROVIDER_MARGIN_PERCENT of the window below it: the plugin then
// compacts between turns, before the provider does it in the middle of one.
// When the limit is that point itself, the cap sits above the highest
// threshold (95 %) and never applies; it matters for a thread or
// per-provider limit above the provider's point.
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
  const ctx = await measureThread(deps.storage, context, providerId, override, settings, now);
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
