// RPC contract `usage-forecast.v1` and the shapes shared by server, app and CLI.
// Account identifiers (`accountEmail`, `accountKey`) never appear here: the
// server drops them before anything is stored or returned.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const LIMITS_TAG = "limits";
export const threadTag = (threadId: string) => `thread:${threadId}`;

export const THRESHOLD_MIN_PERCENT = 50;
export const THRESHOLD_MAX_PERCENT = 95;
export const THRESHOLD_DEFAULT_PERCENT = 80;
export const POLL_MIN_MINUTES = 1;
export const POLL_MAX_MINUTES = 10;
export const POLL_DEFAULT_MINUTES = 2;
/**
 * The working context limit in tokens: the point the context bar and the
 * auto-compact threshold are measured against, capped by the model window.
 * Quality drops well before a large window is full, so the default follows
 * bb-plugin-context-meter: 150 000 tokens.
 */
export const CONTEXT_LIMIT_MIN_TOKENS = 10_000;
export const CONTEXT_LIMIT_MAX_TOKENS = 2_000_000;
export const CONTEXT_LIMIT_DEFAULT_TOKENS = 150_000;
/**
 * Providers with their own working-limit setting. `0` (the default) means
 * auto: the provider's own compaction point when bb reports it, else the
 * global `contextLimitTokens`.
 */
export const PROVIDER_LIMIT_SETTINGS = {
  "claude-code": "claudeCodeContextLimitTokens",
  codex: "codexContextLimitTokens",
} as const;
export const PROVIDER_LIMIT_AUTO = 0;
/** Auto-compact entries shown in the banner and in `status`. */
export const RECENT_COMPACTIONS = 5;

export const threadIdSchema = z.string().min(1).max(128);
export const thresholdSchema = z.number().int().min(THRESHOLD_MIN_PERCENT).max(THRESHOLD_MAX_PERCENT);
export const pollIntervalSchema = z.number().int().min(POLL_MIN_MINUTES).max(POLL_MAX_MINUTES);
export const contextLimitSchema = z.number().int().min(CONTEXT_LIMIT_MIN_TOKENS).max(CONTEXT_LIMIT_MAX_TOKENS);
/** A per-provider limit: `0` for auto, else a working limit in tokens. */
export const providerLimitSchema = z.union([z.literal(PROVIDER_LIMIT_AUTO), contextLimitSchema]);

// --- Limits -----------------------------------------------------------------

const projectionSchema = z.object({
  projectedPercent: z.number(),
  runOutAt: z.number().nullable(),
});

export const windowForecastSchema = z.object({
  status: z.enum(["hit", "running"]),
  current: projectionSchema.nullable(),
  learned: projectionSchema.extend({ basedOnWindows: z.number().int() }).nullable(),
  warning: z.boolean(),
});

export const costSchema = z.object({ usedUsdCents: z.number(), limitUsdCents: z.number() });

export const limitWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  /** Epoch ms, or null when the host gives no reset time. */
  resetsAt: z.number().nullable(),
  /** The host's undocumented per-model tag, e.g. `fable`. */
  model: z.string().nullable(),
  cost: costSchema.nullable(),
  /** Null for a window whose duration is unknown: it then has no forecast. */
  durationMs: z.number().nullable(),
  forecast: windowForecastSchema.nullable(),
});
export type LimitWindow = z.infer<typeof limitWindowSchema>;

export const PROVIDER_STATUSES = ["ok", "not_installed", "unauthenticated", "expired", "error"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const providerLimitsSchema = z.object({
  providerId: z.string(),
  /** Status of the latest poll. */
  status: z.enum(PROVIDER_STATUSES),
  /** Error text when `status` is `error`. */
  message: z.string().nullable(),
  planLabel: z.string().nullable(),
  /** Epoch ms of the latest poll that reached this provider. */
  checkedAt: z.number(),
  /** Epoch ms of the latest `ok` answer; `windows` come from it. */
  measuredAt: z.number().nullable(),
  /** From the latest `ok` answer, kept while later polls fail. */
  windows: z.array(limitWindowSchema),
});
export type ProviderLimits = z.infer<typeof providerLimitsSchema>;

// --- Auto-compact log --------------------------------------------------------

export const COMPACT_RESULTS = ["compacted", "failed", "unsupported", "cancelled"] as const;

export const compactLogEntrySchema = z.object({
  threadId: z.string(),
  providerId: z.string().nullable(),
  at: z.number(),
  trigger: z.enum(["auto", "manual"]),
  /** Context fill before and after, in percent; null when unknown. */
  beforePercent: z.number().nullable(),
  afterPercent: z.number().nullable(),
  result: z.enum(COMPACT_RESULTS),
  message: z.string().nullable(),
});
export type CompactLogEntry = z.infer<typeof compactLogEntrySchema>;

export const snapshotSchema = z.object({
  /** Epoch ms of the latest poll, or null before the first one. */
  polledAt: z.number().nullable(),
  /** Error of the latest poll as a whole, e.g. the SDK call threw. */
  pollError: z.string().nullable(),
  providers: z.array(providerLimitsSchema),
  /** Newest first, at most RECENT_COMPACTIONS. */
  recentCompactions: z.array(compactLogEntrySchema),
});
export type LimitsSnapshot = z.infer<typeof snapshotSchema>;

// --- Thread ------------------------------------------------------------------

export const overrideSchema = z.object({
  autoCompact: z.enum(["inherit", "off", "on"]),
  /** Used only with `on`; the server drops it otherwise. */
  thresholdPercent: thresholdSchema.optional(),
  /** This thread's working context limit in tokens; absent means the settings' limit. */
  limitTokens: contextLimitSchema.optional(),
});
export type ThreadOverride = z.infer<typeof overrideSchema>;

/** The stored shape: `thresholdPercent` only with `on`, `limitTokens` only when set. */
export function normalizeOverride(override: ThreadOverride): ThreadOverride {
  const out: ThreadOverride = { autoCompact: override.autoCompact };
  if (override.autoCompact === "on" && override.thresholdPercent !== undefined) out.thresholdPercent = override.thresholdPercent;
  if (override.limitTokens !== undefined) out.limitTokens = override.limitTokens;
  return out;
}

/** True when the override changes nothing and need not be stored. */
export function isInheritOverride(override: ThreadOverride): boolean {
  return override.autoCompact === "inherit" && override.limitTokens === undefined;
}

export const contextCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  tokens: z.number(),
  kind: z.enum(["used", "free", "reserved", "deferred"]),
});

/**
 * Where the working limit comes from, in order of precedence: `thread` (the
 * thread's override), `provider` (the per-provider setting), `reported` (the
 * provider's own compaction point as bb reports it), `settings` (the global
 * limit). `window` replaces any of them when the model window is smaller.
 */
export const CONTEXT_LIMIT_SOURCES = ["settings", "thread", "window", "provider", "reported"] as const;
export type ContextLimitSource = (typeof CONTEXT_LIMIT_SOURCES)[number];

export const threadContextSchema = z.object({
  usedTokens: z.number(),
  /** The model's context window. */
  windowTokens: z.number(),
  /** The working limit, capped by the window; see CONTEXT_LIMIT_SOURCES. */
  limitTokens: z.number(),
  /** Where `limitTokens` comes from; `window` when the window is smaller than the chosen limit. */
  limitSource: z.enum(CONTEXT_LIMIT_SOURCES),
  /** Used tokens as a percent of `limitTokens`; above 100 past the limit. */
  percent: z.number(),
  estimated: z.boolean(),
  /**
   * Where the provider compacts on its own, in tokens: from this thread's
   * snapshot, or the last value bb reported for the same provider and
   * window. Null when unknown (Codex reports none).
   */
  autoCompactAtTokens: z.number().nullable(),
  /** Empty when the provider gives no breakdown (Codex). */
  categories: z.array(contextCategorySchema),
});
export type ThreadContext = z.infer<typeof threadContextSchema>;

export const threadStateSchema = z.object({
  threadId: z.string(),
  providerId: z.string().nullable(),
  /** True while the agent is answering. */
  active: z.boolean(),
  /** Null when the host has no measurement yet. */
  context: threadContextSchema.nullable(),
  override: overrideSchema,
  /** Effective auto-compact for this thread: the override applied to the settings. */
  autoCompact: z.object({
    enabled: z.boolean(),
    /** From the settings or the override. */
    thresholdPercent: z.number(),
    /**
     * What auto-compact acts on, in percent of the working limit:
     * `thresholdPercent`, capped below the point where the provider compacts
     * on its own when that point is known.
     */
    effectiveThresholdPercent: z.number(),
    /** The same point in tokens, or null while the context is not measured. */
    effectiveThresholdTokens: z.number().nullable(),
    source: z.enum(["settings", "thread"]),
  }),
  /** False once a compact of this provider failed as unsupported. */
  compactSupported: z.boolean(),
  /** Epoch ms until which auto-compact skips this thread, or null. */
  cooldownUntil: z.number().nullable(),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export const compactResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().nullable(),
  entry: compactLogEntrySchema.nullable(),
});
export type CompactResult = z.infer<typeof compactResultSchema>;

// --- Contract ----------------------------------------------------------------

const threadInput = z.object({ threadId: threadIdSchema });

export const usageForecastContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: snapshotSchema,
    tags: () => [LIMITS_TAG],
  },
  thread: {
    input: threadInput,
    output: threadStateSchema,
    tags: ({ threadId }) => [threadTag(threadId)],
  },
  refresh: {
    input: z.null(),
    output: snapshotSchema,
  },
  compact: {
    input: threadInput,
    output: compactResultSchema,
  },
  setThreadOverride: {
    input: z.object({ threadId: threadIdSchema, override: overrideSchema }),
    output: z.object({ override: overrideSchema }),
  },
});
export type UsageForecastContract = typeof usageForecastContract;
