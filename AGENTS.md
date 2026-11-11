# bb-plugin-usage-forecast — Standalone Context

BB plugin that shows every provider's usage limits with a forecast to the
window reset, the thread's context-window fill, a Compact button and an
optional auto-compact. A server part polls limits on a schedule and runs
auto-compact without open clients.

## Layout

- `server.ts` — wires storage, schedule, events, RPC contract and CLI.
- `src/shared/` — RPC contract, window table, thresholds and the forecast
  (`forecast.ts`, adapted from `claude-code-usage-quota-mod`, see `NOTICE`).
- `src/server/` — poller, KV storage, auto-compact, CLI.
- `src/app/` — composer band (design after `claude-code-usage-quota-mod`),
  context card section, settings section; UI strings in `i18n.ts`.
- `components/`, `lib/`, `hooks/` — vendored BB UI components; import them by
  relative path and keep them unchanged.

## Critical Rules

1. **Limits only through `bb.sdk.system.usageLimits`.** Never call provider
   APIs and never read provider credentials.
2. **No account identifiers in logs or storage.** `usageLimits` returns
   `accountEmail` and an undocumented `accountKey`; drop both before logging
   or storing anything.
3. **A window is identified by (`providerId`, `label`).** The host's
   undocumented `kind` is only a hint for the window duration (see Host facts).
4. **Auto-compact is off by default.** Turning it on by default needs the
   maintainer's approval. Do not touch or disable the built-in
   `bb--provider-usage` plugin.
5. **One KV value stays under 256 KB.** Every list is a ring buffer trimmed
   before it is written.
6. **UI text is English by default**, Russian through the `language`
   setting. Every UI string lives in `src/app/i18n.ts` in both languages;
   code, comments and docs are English.

## Commands

- Check: `npm ci && npm run typecheck && npm test && npm run build`.
- Live test from the checkout: `npm run build && bb plugin install "$PWD" --yes`,
  then `bb plugin logs usage-forecast` and `bb plugin list`.
- RPC from the shell: `bb plugin rpc call usage-forecast <method> --input-file
  <json> --json`.
- App tests need `// @vitest-environment jsdom` and `cleanup()` in `afterEach`
  (Vitest runs without globals).

## Host facts (bb 0.49.0, SDK 0.6.132, checked 2026-11-08)

Usage limits:

- `claude-code` and `codex` answer `ok`; a provider that is not installed
  (for example `acp-cursor`) answers `not_installed`. ACP agents have
  `maintenance.usage: false` and are absent from the response.
- Windows seen, with the host's undocumented `kind`:

  | providerId | label | kind | duration |
  | --- | --- | --- | --- |
  | claude-code | Current session | five-hour | 5 h |
  | claude-code | Weekly limit | weekly | 7 d |
  | claude-code | Fable | weekly (`model: "fable"`) | 7 d |
  | codex | Current session | five-hour | 5 h |
  | codex | Weekly limit | weekly | 7 d |

- Every window has `resetsAt` (ISO) and an integer `usedPercent`; none had
  `cost`. The response also carries undocumented `plan: {id, multiplier}` and
  `accountKey`.

Schedules and lifecycle:

- `bb.background.schedule` with a name already registered in this load throws
  `schedule "<name>" is already registered`; the first registration stays.
  Back-off therefore skips ticks inside one schedule, and a new interval
  applies after `bb plugin reload`.
- A tick fires about 10 s after the minute. A throwing tick shows as
  `running (schedule <name> failed: …)` in `bb plugin list`, with
  `last: error (…)` on the schedule row.
- Thread plugin metadata (`threads.updatePluginMetadata`) survives
  `bb plugin reload`.

Context window:

- `threads.context` for an active thread has only `usedTokens`,
  `modelContextWindow` and `estimated`. Codex never has more than that
  (`modelContextWindow: 258400`, `estimated: false`). After a Claude Code turn
  ends it adds
  `snapshot` with `contextWindowTokens: 150000`, `autoCompactAtTokens: 117000`
  and categories (`Autocompact buffer` is `reserved`, 33 000).
- `modelContextWindow` can disagree with the snapshot (200 000 vs 150 000 in
  an idle thread); use `snapshot.contextWindowTokens` when present.
- An idle thread gets `compactionOfferAt`, one hour after it went idle.
- Claude Code compacts on its own at `autoCompactAtTokens`: the window minus
  the 33 000 buffer (117 000 of 150 000, 167 000 of 200 000; checked
  2026-11-11), not a fixed percent. An auto-compact threshold above that never
  fires for it. Some idle Claude Code threads have no snapshot at all, so the
  plugin remembers the last point per provider and window.
- Codex reports no compaction point and no `model_auto_compact_token_limit`;
  a 500K model shows `modelContextWindow: 475000` (bb reports the usable
  95 %). Its compaction point reaches the plugin only through the
  per-provider setting.
- `providers.list()` capabilities have no `supportsManualCompaction` (A5):
  the plugin tries `threads.compact` and marks the provider unsupported on
  failure.

Compaction events:

- `thread/compacted` and `thread/contextWindowUsage/updated` are thread events,
  read with `bb.sdk.threads.events.list({threadId, types, order, limit})`.
  The server hears `thread.active`, `thread.idle` and
  `experimental_thread.events`; `bb.realtime.publish` from the server reaches
  the open app (A2).
- In a Claude Code auto-compact the `thread/compacted` event was followed by
  a usage event with no numbers, one with the old value, and the new, lower
  value about 6 s later.
- Manual `threads.compact({threadId})` on an idle thread returns `{ok: true}`
  in about 0.2 s for both Claude Code and Codex. It only queues a `/compact`
  turn: the thread goes `thread.active`, then `thread.idle` (Codex about 3 s,
  Claude Code about 8 s later). Read the result after that `thread.idle`.
- Claude Code writes `thread/compacted`; between it and the new value
  `threads.context` briefly returns `usage: null`. Codex writes no
  `thread/compacted`; its compaction is an item of type `contextCompaction`
  (`item/started`, `item/completed`) and is followed by a fresh
  `thread/contextWindowUsage/updated`.
- Compacting an almost empty thread made it larger (26 346 → 28 460 tokens
  for Claude Code, 24 823 → 28 228 for Codex). The «after» value can exceed
  «before».
- On 2026-11-08 (Codex, per-thread override on at 50 %): the turn ended at
  71 % (184 625 tokens), the plugin compacted on `thread.idle` and logged
  71 % → 35 % (90 837 tokens) about 8 s later. A second, manual compact of
  that thread stayed at 35 %: Codex keeps the last user message, so a thread
  whose fill is one long prompt does not shrink further.

UI surfaces:

- The composer banner (`app.composer.customize`, scope `thread`) and the
  thread context segment both render an interactive button on the Mac and on
  the phone, and RPC calls work from both. Realtime signals reached the Mac;
  on the phone no thread event fired while it was open, so that is unchecked.
- `experimental_useThreadContextKind()` is `card` on the Mac and `banner` on
  the phone.

## Repository and release contract

- Repository: public `ponomr/bb-plugin-usage-forecast`, MIT. Submitted to the
  BB Community marketplace as `usage-forecast` with a Git source that tracks
  `^0.4.0` (get-bb/marketplace#928); a compatible release needs no new
  marketplace PR, a contract change needs a PR that moves the range.
- Checks: the command above; there is no CI yet.
- Release: bump `version` in `package.json` and `package-lock.json` in the PR,
  merge it, tag the merge commit `vX.Y.Z` and push the tag.
- Install from a checkout: check out the tag and run
  `npm ci && npm run build && bb plugin install "$PWD" --yes`;
  `bb plugin list` must show the new version as `running`.
- Recovery: check out the previous tag and reinstall, or run
  `bb plugin disable usage-forecast`. Data stays in the plugin's KV storage.
