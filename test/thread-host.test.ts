// The thread state names the host the thread runs on: threads.get gives the
// environment, environments.get gives the host. A failure leaves it null.

import { describe, expect, it } from "vitest";
import { readThreadState } from "../src/server/threads";
import { claudeContext, FakeThreads, makeStorage, NOW, settingsOf } from "./helpers";

const T = "thr_a";

function setup() {
  const threads = new FakeThreads().thread(T, "claude-code", claudeContext(90_000));
  const deps = { threads, storage: makeStorage(), settings: settingsOf(), now: () => NOW };
  return { threads, read: () => readThreadState(deps, T) };
}

describe("thread host", () => {
  it("resolves the host through the thread's environment", async () => {
    const t = setup();
    t.threads.onHost(T, "host_mac");
    expect((await t.read()).hostId).toBe("host_mac");
  });

  it("is null when the thread has no environment", async () => {
    expect((await setup().read()).hostId).toBeNull();
  });

  it("is null when environments.get throws, and the context still arrives", async () => {
    const t = setup();
    t.threads.onHost(T, "host_mac");
    t.threads.environmentError = new Error("environment not found");
    const state = await t.read();
    expect(state.hostId).toBeNull();
    expect(state.context).toMatchObject({ usedTokens: 90_000 });
    expect(state.providerId).toBe("claude-code");
  });
});
