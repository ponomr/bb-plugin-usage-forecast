---
title: Token totals per thread, day and month (UF-12)
status: draft
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
tags: [usage-forecast, UF-12]
---

# Token totals per thread, day and month (UF-12)

## Goal Capsule

The plugin counts the tokens BB threads spent, from the token-usage events BB already writes into each thread, and shows three numbers: this thread, today and this month for the provider. The numbers appear in the expanded band, in the sidebar card and in a new CLI command. The main number leaves cache reads out.

The work starts from a `main` that already contains UF-5 to UF-11. Names of files and helpers introduced by those tasks are given as planned; read the code on the branch and use what is there.

## Product Contract

### Summary

A server-side counter fed by `thread/tokenUsage/updated` thread events, hourly buckets per provider in KV, a one-time collection of the current month from existing threads, and three display places.

### Problem Frame

The limit windows say what share of the allowance is gone, not how much work was done. Competing plugins (Usage Bar, Tokenomics) show token totals from BB's own records. The owner wants the same without provider logs or keys.

### Key Decisions

- **The main number is tokens without cache reads**: new input, cache writes and output. The full sum with cache reads stays in `--json` and in the tooltip. (session-settled: owner chose «Без чтения кэша» on 2026-11-16. Measured on a real thread: 9.2 M total, of which 86 k output; cache reads are about 97 % of the total.)
- **Shown in the band, in the sidebar card and in the CLI.** (session-settled: owner chose «Полоса, карточка в подвале и CLI».)
- **The current month is collected once from existing threads, archived ones included; earlier months are not.** (session-settled: owner chose «Собрать текущий месяц».)
- **The only source is BB thread events.** No provider logs, keys or APIs. (session-settled: task text of UF-12.)

### Requirements

- R1. For each token-usage event of a thread the plugin takes the cumulative `total` and computes two cumulative values: `all` = `totalTokens`; `work` = `totalTokens` minus `cacheReadInputTokens` (when that field is absent, minus `cachedInputTokens`; never below 0).
- R2. The growth of a thread's cumulative values since the plugin last saw the thread is added to the bucket of the hour (UTC) in which the event was written, under the thread's provider. An event is never counted twice, whatever the order of live events, restarts and the first collection.
- R3. If a thread's cumulative value is lower than the one remembered, the plugin remembers the new value and adds nothing.
- R4. The first time the plugin meets a thread (live, or in the first collection) it reads all of that thread's token-usage events in order and applies R2 to each, so the thread's earlier hours land in the right buckets. Hours older than the retention of R6 only advance the remembered value.
- R5. First collection: once after the update, in the background, the plugin walks all threads, archived included, and applies R4 to each. It runs one thread at a time, survives a thread that fails to read (skips it, logs the thread id and the error class, continues), records completion in storage and does not run again. A plugin reload before completion restarts it; R2 keeps the result the same.
- R6. Storage: hourly buckets for the last 40 days, and a table of threads (provider, remembered cumulative values, last update). A thread leaves the table only when its last update is older than the 40 days of the buckets, so everything it had counted is already outside the buckets and meeting it again as new (R4) cannot count an hour twice. Each KV value stays under 256 KB and is trimmed before it is written. If the table still exceeds the byte limit, the least recently updated threads are dropped and the latest `updatedAt` among all threads ever dropped this way is stored as `evictedBefore`; for a thread that is not in the table, events written at or before `evictedBefore` only advance the remembered value and add nothing. This can undercount such a thread and never counts twice. The first collection starts with no `evictedBefore`.
- R7. "Today" and "this month" are local calendar periods. The app sends the start of the local day and month and the server sums the buckets from those hours. The CLI uses the server process's time zone and prints its name. A time zone with a half-hour offset is rounded to the UTC hour bucket; this is accepted.
- R8. Band: the expanded band of a thread shows one line, "Tokens: thread 86k · today 310k · month 4.2M", where "thread" is this thread's `work` total and "today" and "month" are the thread's provider across all its BB threads. The tooltip of the line gives the full sums with cache reads and says the count covers BB threads only. The line is absent when the thread has no token data and the provider has no buckets (Hermes ACP agents write no such events).
- R9. Sidebar card (UF-8): each provider shown in the card gets "today 310k · month 4.2M"; a provider without buckets gets no token text. Providers hidden by UF-11 stay out of the card as that task defines.
- R10. CLI: `bb usage-forecast tokens [--json]` prints, per provider, today and this month (`work`, and `all` in brackets), then the 10 most recently updated threads with thread id, provider and lifetime `work`. `--json` gives `{timeZone, dayStart, monthStart, providers: [{providerId, today: {work, all}, month: {work, all}}], threads: [{threadId, providerId, work, all, updatedAt}], backfill: {done, threadsRead, threadsFailed}}`.
- R11. Numbers are formatted compactly: below 1 000 as is, then "12.3k", "310k", "4.2M", "1.25B"; the Russian UI uses «тыс.» and «млн» ("310 тыс.", "4,2 млн").
- R12. Counting never delays or breaks auto-compact, polling or the band: every failure in the counter is caught and logged, and the token line disappears instead of showing an error.
- R13. Storage and logs hold thread ids, provider ids and numbers only: no message text, no account identifier. Every new UI string is in `src/app/i18n.ts` in English and Russian.

### Acceptance Examples

- AE1. A Claude Code event with `total` = {totalTokens 144 636, cacheReadInputTokens 144 015}: `work` 621, `all` 144 636. A Codex event with {totalTokens 130 671, inputTokens 130 343, cachedInputTokens 130 048, cacheReadInputTokens 130 048, outputTokens 328}: `work` 623.
- AE2. A thread's events report `all` 100, 250, 250, 400 at 10:05, 10:40, 10:41, 12:10 UTC: bucket 10:00 gets 250, bucket 12:00 gets 150. Feeding the same events again changes nothing.
- AE3. The plugin remembered `all` 400; an event reports 120: nothing is added, 120 is remembered, the next event with 200 adds 80.
- AE4. First collection over three threads, the second fails to read: the first and third are counted, `backfill.threadsFailed` is 1, completion is recorded.
- AE5. A thread idles for the first time after the update, before the first collection reached it: its whole history is read then; when the collection reaches it later nothing is added.
- AE6. Local time zone UTC+4, now 16 Nov 01:30 local: "today" sums buckets from 15 Nov 20:00 UTC, "month" from 31 Oct 20:00 UTC.
- AE7. A thread of a Hermes agent: no token line in the band, no token text in the card for that provider, and the provider is absent from `tokens`.
- AE8. 4 000 hourly entries and 500 threads in memory, 100 of them last updated more than 40 days ago: after a write the stored values hold at most 40 days of hours and the 400 threads updated inside 40 days, each value under 256 KB. With a table too large for the byte limit, the oldest threads are dropped, `evictedBefore` is their latest `updatedAt`, and a dropped thread that reports again adds only the growth of events written after `evictedBefore`.

### Scope Boundaries

- No cost in money and no price tables.
- No totals per model, per project or per host.
- No months before the current one at the time of the first collection; no charts.
- No tokens spent outside BB (a provider's own terminal or desktop app); the tooltip and the README say so.
- Deleted threads are not recovered; what was counted before the deletion stays in the buckets.
- No setting to switch the main number; `all` is available in the tooltip and `--json`.

### Dependencies / Assumptions

- Observed on bb 0.49.0 on 2026-11-16 through `bb thread log --json`: `thread/tokenUsage/updated` has `data.tokenUsage.total` and `.last` with `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheReadInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`. The event is written at the end of a turn (sometimes several in a row, some with a zero `last`). Claude Code and Codex threads have it, archived ones included; threads of Hermes ACP agents (`acp-kaya`, `acp-hera`) have none. Claude Code's `inputTokens` excludes cached tokens and its `totalTokens` includes them; Codex's `inputTokens` includes cached tokens. `total` is cumulative for the thread and can start above the first `last` (earlier turns are in `total` even when their events are missing), which is why R2 uses the growth of `total` and not the sum of `last`.
- Unverified: whether `total` ever goes down (after a context clear or a provider session restart); R3 covers it. Unverified: that `bb.sdk.threads.events.list` with `types: ["thread/tokenUsage/updated"]` returns the same events from inside the plugin, and how `bb.sdk.threads.list` pages and filters archived threads. U1 checks both.
- There is no cross-thread usage call in SDK 0.6.132; the events are read per thread.
- UF-8 (`src/app/sidebar-card.tsx`) and UF-11 are merged.

### Sources

- UF-12 in BB Tasks; report item 16 in `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`.
- `server.ts` (the `thread.idle` listener, RPC and CLI registration), `src/server/storage.ts` (KV keys, `trimToBytes`), `src/server/threads.ts` (`ThreadsSdk`), `src/app/banner.tsx`, `src/server/cli.ts`.

Product Contract preservation: the Product Contract above is the brainstorm's outcome and is unchanged by planning.

## Planning Contract

### Key Technical Decisions

- KTD1. **Pure core** in `src/shared/tokens.ts`: `tokenTotals(total): {work, all} | null` (R1, tolerant of missing fields); `applyEvents(state, threadId, providerId, events, now): state` implementing R2–R4 and the trims of R6 on plain data; `sumSince(hours, providerId, fromMs): {work, all}`; `formatTokens(n, language)` (R11, used by app and CLI). No SDK import.
- KTD2. **Storage.** Two KV keys through `src/server/storage.ts`: `tokens:hours` = `{[providerId]: [hourStartMs, work, all][]}` and `tokens:threads` = `{threads: {[threadId]: {providerId, work, all, updatedAt}}, backfill: {done, threadsRead, threadsFailed, startedAt}, evictedBefore: number | null}`. Both trimmed by the rules of R6 and then by the existing `trimToBytes`-style guard. Values of an unexpected shape are read as empty.
- KTD3. **One writer.** `src/server/token-counter.ts` owns the state: it loads both keys once, serialises every update through one promise chain (live events and the first collection never interleave inside a read-modify-write), and writes after each thread. Entry points: `onIdle(threadId)` and `backfill()`. Both call the same `ingestThread(threadId)`: if the thread is in the table, read only its newest token-usage event (`order: "desc"`, `limit: 1`); otherwise page through all of them in ascending order.
- KTD4. **Live trigger is `thread.idle`**, the listener `server.ts` already has for auto-compact: add a second, independent `void counter.onIdle(thread.id)` that never throws. The provider id comes from `threads.get`. A turn's tokens therefore appear when the turn ends.
- KTD5. **First collection.** Started with `void counter.backfill()` at the end of the plugin's load if storage does not say `done`. It lists threads through a new `list` method on the `ThreadsSdk` wrapper (`src/server/threads.ts`), not-archived then archived, paged, hidden threads included, and awaits a short pause (for example 50 ms) between threads. It never runs two at once.
- KTD6. **RPC.** A query `tokens({threadId?, dayStart, monthStart})` returning `{thread: {work, all} | null, providers: [{providerId, today, month}], backfillDone}`; `thread` is the table entry, or null. Tagged with a new `TOKENS_TAG`, invalidated after a write that changed a bucket; during the first collection at most once per 10 seconds and once when it completes. The app computes `dayStart` and `monthStart` from the browser's clock in the hook, so the query key changes only at local midnight.
- KTD7. **App.** `useTokens(threadId?)` in `src/app/hooks.ts`; a `TokensLine` component used by the expanded band, and a small per-provider text in the sidebar card. No new setting.
- KTD8. **CLI.** `tokens` is a new command in `src/server/cli.ts` on the service; day and month starts come from the process's local time (`Intl.DateTimeFormat().resolvedOptions().timeZone` for the printed name).
- KTD9. No version bump; the entry goes under "Unreleased" in `CHANGELOG.md`. RPC and CLI additions are additive.

### Sequencing

U1 (host facts) → U2 (pure core) → U3 (counter and storage) → U4 (RPC and CLI) → U5 (band and card) → U6 (docs, look on real data).

## Implementation Units

### U1. Check the two SDK calls from inside a plugin

- Goal: confirm the unverified assumptions before building on them.
- Requirements: R4, R5 (their inputs).
- Dependencies: none.
- Files: `AGENTS.md` (Host facts).
- Approach: the plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). Build a throwaway plugin with its own id (`uf-tokens-spike`) in a temporary directory outside the repository with one RPC query that (a) calls `bb.sdk.threads.list` with and without `archived: true`, with `limit` and `offset`, and returns only counts per call and per `providerId`; (b) for a thread id given in the input calls `bb.sdk.threads.events.list` with the type filter, ascending, small `limit`, following the paging cursor, and returns the number of events, the shape of the paging fields and the first and last `total.totalTokens`. It returns no titles, no message text and no account data. Install it from its path, call it for one Claude Code thread, one Codex thread, one archived thread and one Hermes thread, then `bb plugin remove uf-tokens-spike`, delete its directory and confirm with `bb plugin list` that it is gone and `usage-forecast` is still `running`. Record the paging and filter behaviour as Host facts lines.
- Test scenarios: none (observation only).
- Verification: the Host facts lines exist. If the type filter or the archived listing does not work as assumed, adapt KTD3/KTD5 to what was seen (for example filter client-side) and say so in the report; if token-usage events cannot be read from a plugin at all, stop and report.

### U2. Pure core

- Goal: R1–R4, R6 trims, R7 sums, R11.
- Requirements: R1, R2, R3, R4, R6, R7, R11.
- Dependencies: U1.
- Files: `src/shared/tokens.ts`, `test/tokens.test.ts`.
- Approach: KTD1.
- Test scenarios: AE1, AE2, AE3, AE6, AE8; an event without `cacheReadInputTokens`; a `total` with missing or non-numeric fields → ignored; events out of order in the input are sorted by sequence before use; a thread known to the table with an event equal to the remembered value → no change; hours older than 40 days advance the remembered value and create no bucket; a thread removed by age and met again adds nothing for hours outside the 40 days and counts later events once; a thread dropped by the byte limit and met again adds nothing for events at or before `evictedBefore` and the growth of later events once; `evictedBefore` only moves forward; `formatTokens` at 0, 999, 1 000, 12 345, 310 000, 4 200 000, 1 250 000 000 in both languages.
- Verification: `npm test`.

### U3. Counter and storage

- Goal: R2–R6, R12, R13 on the server.
- Requirements: R2, R3, R4, R5, R6, R12, R13.
- Dependencies: U2.
- Files: `src/server/token-counter.ts`, `src/server/storage.ts`, `src/server/threads.ts`, `server.ts`, `test/token-counter.test.ts`, `test/helpers.ts`.
- Approach: KTD2–KTD5.
- Test scenarios: AE4, AE5; `onIdle` for a known thread reads one event, for an unknown thread pages through all; `onIdle` and `backfill` running together give the same buckets as either order alone; a throwing `events.list`, `threads.get` or KV write is caught, logged without message text, and leaves earlier state intact; `backfill` does not start when storage says `done` and does not run twice concurrently; a reload mid-collection (new counter over the same fake KV) ends with the same buckets; the auto-compact idle handler still runs when the counter throws.
- Verification: `npm run typecheck && npm test`.

### U4. RPC and CLI

- Goal: R7, R10.
- Requirements: R7, R10, R11.
- Dependencies: U3.
- Files: `src/shared/contract.ts`, `src/server/rpc.ts`, `src/server/cli.ts`, `server.ts`, `test/plugin.test.ts`, `test/cli.test.ts`.
- Approach: KTD6, KTD8.
- Test scenarios: the query sums from the given starts and rejects non-finite starts; `thread` is null for an unknown thread; a provider without buckets is absent; CLI text and JSON per R10 with a fixed clock and time zone; empty storage prints one line saying no token data yet.
- Verification: `npm run typecheck && npm test`.

### U5. Band and sidebar card

- Goal: R8, R9.
- Requirements: R8, R9, R11, R13.
- Dependencies: U4.
- Files: `src/app/hooks.ts`, `src/app/banner.tsx`, `src/app/sidebar-card.tsx`, `src/app/i18n.ts`, `test/banner.test.tsx`, `test/sidebar-card.test.tsx`, `test/app-fixtures.tsx`.
- Approach: KTD7. The line sits in the expanded band only, below the limit windows; the collapsed row does not change.
- Test scenarios (jsdom): the line with all three numbers in English and Russian; thread null but provider present → "today" and "month" only; nothing at all → no line (AE7); the tooltip text holds the full sums and the BB-only note; the card shows the per-provider text and omits it for a provider without buckets; a failed query renders no line and no error.
- Verification: `npm run typecheck && npm test`.

### U6. Docs and the look on real data

- Goal: record and check.
- Requirements: all.
- Dependencies: U5.
- Files: `README.md`, `CHANGELOG.md` ("Unreleased"), `AGENTS.md` (Layout lines; the event facts from Dependencies / Assumptions as Host facts), `skills/usage-forecast/SKILL.md` (the `tokens` command).
- Approach: `npm ci && npm run typecheck && npm test && npm run build`. The real plugin is not replaced (see U1). For a look on real data, save `bb thread log <id> --json --all` of two or three real threads to files under the thread's storage, feed their token-usage events through `applyEvents` in a throwaway script and compare the thread totals with the last event's `total` by hand. The coordinating thread checks the band, the card and the first collection after the release.
- Verification: the check command is green; `bb plugin list` shows `usage-forecast` still `running` from the marketplace source.

## Verification Contract

- `npm ci && npm run typecheck && npm test && npm run build` passes.
- Tests cover AE1–AE8.
- No message text and no account identifier in code, logs, storage, the spike's output or the report. Vendored `components/`, `lib/`, `hooks/` unchanged.

## Definition of Done

- R1–R13 met, or the stop condition of U1 reported with what was seen.
- All commits local on the child's branch; nothing pushed, no PR, no tag.
- Final report: branch, worktree path, commits, check result, the U1 observations, deviations.
