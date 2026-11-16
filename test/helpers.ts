// Shared fakes for the server tests. Storage uses the fake host's kv, which
// enforces the real 256 KB value cap.

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Storage } from "../src/server/storage";
import type { PluginSettings, ThreadsSdk } from "../src/server/threads";
import { HOUR_MS } from "../src/shared/windows";

export const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
export const MIN = 60_000;

export function makeStorage(): Storage {
  return new Storage(createFakePluginHost({ pluginId: "usage-forecast" }).bb.storage.kv);
}

export function settingsOf(over: Partial<PluginSettings> = {}): () => Promise<PluginSettings> {
  const value: PluginSettings = {
    autoCompactEnabled: true,
    summaryClearEnabled: false,
    autoCompactThresholdPercent: 80,
    pollIntervalMinutes: 2,
    contextLimitTokens: 150_000,
    providerLimitTokens: { "claude-code": 0, codex: 0 },
    limitNotifyEnabled: true,
    limitNotifyPercent: 90,
    language: "en",
    ...over,
  };
  return async () => value;
}

export class Clock {
  constructor(public value = NOW) {}
  now = () => this.value;
  advance(ms: number) {
    this.value += ms;
  }
}

/**
 * A Claude Code `threads.context` answer after a turn: by default a 150 000
 * window with its own compact at 117 000 (bb 0.49 reports the window minus
 * 33 000); a 200 000 window reports 167 000.
 */
export function claudeContext(usedTokens: number, windowTokens = 150_000, autoCompactAtTokens = windowTokens - 33_000) {
  return {
    usage: {
      usedTokens,
      modelContextWindow: windowTokens,
      estimated: false,
      snapshot: {
        contextWindowTokens: windowTokens,
        autoCompactAtTokens,
        usedTokens,
        categories: [{ id: "messages", label: "Messages", tokens: usedTokens, kind: "used" }],
      },
    },
  };
}

/** A Claude Code answer while a turn runs: no snapshot. */
export function claudeActiveContext(usedTokens: number, windowTokens = 200_000) {
  return { usage: { usedTokens, modelContextWindow: windowTokens, estimated: true } };
}

/** A Codex answer: no snapshot and no compaction point; window 258 400 by default. */
export function codexContext(usedTokens: number, windowTokens = 258_400) {
  return { usage: { usedTokens, modelContextWindow: windowTokens, estimated: false } };
}

type ContextAnswer = unknown | (() => unknown);

/** Mutable stand-in for `bb.sdk.threads`. */
export class FakeThreads implements ThreadsSdk {
  status = new Map<string, string>();
  providers = new Map<string, string>();
  /** Answers of `context`, consumed in order; the last one repeats. */
  contexts = new Map<string, ContextAnswer[]>();
  metadata = new Map<string, Record<string, unknown>>();
  compactCalls: string[] = [];
  contextCalls: string[] = [];
  compactError: Error | null = null;
  /** Runs inside `get`, e.g. to flip the status between two reads. */
  onGet: ((threadId: string, call: number) => void) | null = null;
  private getCalls = new Map<string, number>();

  thread(threadId: string, providerId: string, context: ContextAnswer, status = "idle"): this {
    this.providers.set(threadId, providerId);
    this.status.set(threadId, status);
    this.contexts.set(threadId, [context]);
    return this;
  }

  async get({ threadId }: { threadId: string }) {
    const call = (this.getCalls.get(threadId) ?? 0) + 1;
    this.getCalls.set(threadId, call);
    this.onGet?.(threadId, call);
    return {
      id: threadId,
      providerId: this.providers.get(threadId) ?? null,
      status: this.status.get(threadId) ?? "idle",
      environmentId: this.environments.get(threadId) ?? null,
    };
  }

  async context({ threadId }: { threadId: string }) {
    this.contextCalls.push(threadId);
    const list = this.contexts.get(threadId) ?? [{ usage: null }];
    const next = list.length > 1 ? list.shift() : list[0];
    return typeof next === "function" ? (next as () => unknown)() : next;
  }

  async getPluginMetadata({ threadId }: { threadId: string }) {
    return this.metadata.get(threadId) ?? {};
  }

  async updatePluginMetadata({ threadId, set, remove }: { threadId: string; set?: Record<string, unknown>; remove?: string[] }) {
    const next = { ...(this.metadata.get(threadId) ?? {}), ...(set ?? {}) };
    for (const key of remove ?? []) delete next[key];
    this.metadata.set(threadId, next);
    return next;
  }

  async compact({ threadId }: { threadId: string }) {
    this.compactCalls.push(threadId);
    if (this.compactError) throw this.compactError;
    return { ok: true };
  }

  /** Every `send`, in order. */
  sends: Array<{ threadId: string; text: string; mode: string }> = [];
  /** Errors thrown by the next `send` calls, consumed in order; null sends. */
  sendErrors: Array<Error | null> = [];
  /** Runs inside `send`, e.g. to play the turn's active and idle events. */
  onSend: ((threadId: string, text: string) => void) | null = null;
  /** The answer of `output`. */
  outputs = new Map<string, unknown>();
  clearCalls: string[] = [];
  clearError: Error | null = null;

  async send({ threadId, input, mode }: { threadId: string; input: Array<{ type: "text"; text: string }>; mode: string }) {
    const text = input.map((i) => i.text).join("\n");
    this.sends.push({ threadId, text, mode });
    const error = this.sendErrors.shift() ?? null;
    if (error) throw error;
    this.onSend?.(threadId, text);
    return { ok: true };
  }

  async output({ threadId }: { threadId: string }) {
    return this.outputs.get(threadId) ?? { output: "" };
  }

  async clearContext({ threadId }: { threadId: string }) {
    this.clearCalls.push(threadId);
    if (this.clearError) throw this.clearError;
    return { ok: true };
  }

  /** Thread id → environment id, and environment id → host id. */
  environments = new Map<string, string>();
  environmentHosts = new Map<string, string>();
  environmentError: Error | null = null;

  /** Places a thread on a host through an environment of its own. */
  onHost(threadId: string, hostId: string): this {
    this.environments.set(threadId, `env_${threadId}`);
    this.environmentHosts.set(`env_${threadId}`, hostId);
    return this;
  }

  async environment({ environmentId }: { environmentId: string }) {
    if (this.environmentError) throw this.environmentError;
    const hostId = this.environmentHosts.get(environmentId);
    if (hostId === undefined) throw new Error(`Environment ${environmentId} not found`);
    return { id: environmentId, hostId };
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A `system.usageLimits` answer with one Claude Code provider. */
export function claudeLimits(session: number, weekly: number, sessionResetsAt = NOW + 2 * HOUR_MS) {
  return {
    "claude-code": {
      status: "ok",
      accountEmail: "owner@example.com",
      accountKey: "secret-account-key",
      planLabel: "Max",
      windows: [
        { label: "Current session", usedPercent: session, resetsAt: iso(sessionResetsAt), kind: "five-hour" },
        { label: "Weekly limit", usedPercent: weekly, resetsAt: iso(NOW + 3 * 24 * HOUR_MS), kind: "weekly" },
      ],
    },
  };
}
