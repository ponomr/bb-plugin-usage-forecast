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
    autoCompactThresholdPercent: 80,
    pollIntervalMinutes: 2,
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

/** A Claude Code `threads.context` answer: 150 000 window, own compact at 117 000 (78 %). */
export function claudeContext(usedTokens: number) {
  return {
    usage: {
      usedTokens,
      modelContextWindow: 150_000,
      estimated: false,
      snapshot: {
        contextWindowTokens: 150_000,
        autoCompactAtTokens: 117_000,
        usedTokens,
        categories: [{ id: "messages", label: "Messages", tokens: usedTokens, kind: "used" }],
      },
    },
  };
}

/** A Codex answer: no snapshot, window 258 400. */
export function codexContext(usedTokens: number) {
  return { usage: { usedTokens, modelContextWindow: 258_400, estimated: false } };
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
    return { id: threadId, providerId: this.providers.get(threadId) ?? null, status: this.status.get(threadId) ?? "idle" };
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
