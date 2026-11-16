---
title: CLI for agents — verdict per window and provider headroom (UF-10)
status: draft
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
tags: [usage-forecast, UF-10]
---

# CLI for agents: verdict per window and provider headroom (UF-10)

## Goal Capsule

An agent can ask one short command which provider has headroom, and `status --json` says for every window whether it lasts to the reset, when it runs out, how far it is from an even pace and what its state is. The plugin's agent skill explains both.

The work starts from a `main` that already contains UF-5 (per-host snapshot), UF-6 (main projection, early phase) and UF-7 (pace state).

## Product Contract

### Summary

A new command `bb usage-forecast headroom` that ranks providers from the freest to the tightest with a one-word verdict, and a `verdict` object on every window in `status --json`.

### Problem Frame

Checked on 2026-11-16: `bb usage-forecast status --json` prints the stored snapshot. Per window it has `usedPercent`, `resetsAt`, `durationMs` and `forecast` (`current` and `learned` with `projectedPercent` and `runOutAt`, `warning`). An agent has to derive "will it last" itself, there is no distance from an even pace, and nothing compares providers. An agent choosing where to send a long job reads the whole snapshot and does its own arithmetic.

### Key Decisions

- **A separate command for the provider answer, plus new fields per window in `status --json`.** (session-settled: owner chose «Отдельная команда» on 2026-11-16.)
- **A provider's verdict is the state of its tightest window; it has headroom when all its windows are calm. Among equals the one with the lower projection at reset ranks higher.** (session-settled: owner chose «По худшему окну» on 2026-11-16.)
- **First check what the CLI already prints.** Done; see Problem Frame. (session-settled: task text of UF-10.)

### Requirements

- R1. In `status --json` every window has a `verdict` object:
  - `state`: `calm`, `tight`, `short`, `critical`, `hit` (the UF-7 shown state), or `early` (first part of the window, no pace yet), or `unknown` (no forecast possible).
  - `lasts`: `true` for calm and tight, `false` for short, critical and hit, `null` for early and unknown.
  - `runsOutAt`: epoch ms when the main projection says the window runs out before the reset, else `null`. For `hit` it is `null`. For a `short` or `critical` state that is only held (UF-7 hold) while the current projection no longer runs out it is `null` too, and `lasts` stays `false`.
  - `projectedPercent`: the main projection at reset, or `null`.
  - `paceDeviationPercent`: used percent minus the percent an even spend would have reached by now (positive = spending faster than even), one decimal; `null` when the window length or reset is unknown.
  - `resetsInMs`: time to the reset, or `null`.
- R2. Every existing field of `status --json` stays as it is; the new object is additive.
- R3. `bb usage-forecast headroom` prints one entry per provider account: the provider, its host or hosts, the plan label, a verdict, and the tightest window with its used percent, projection, reset and run-out time.
- R4. Provider verdicts: `headroom` (all windows calm), `tight`, `short`, `critical`, `hit`, `unknown` (provider not `ok`, or no window that counts). A window in state `early` or `unknown` counts by its used percent: `hit` at 100 %, `tight` from 75 %, else calm. A window whose reset time has passed does not count at all: its stored percent belongs to the finished window.
- R5. Order: `headroom`, `tight`, `short`, `critical`, `hit`, `unknown`. Inside one verdict the lower projection at reset of the tightest window comes first; a missing projection uses the used percent.
- R6. A `hit` entry says when the provider is available again: the latest reset among its used-up windows.
- R7. An account shared by several hosts (UF-5 `sharedWith`) is one entry that lists all its hosts; its windows are those UF-5 prints for the group in `status` (the member that answered most recently, the primary host on a tie).
- R8. `--host <id or name>` limits the answer to one host; `--thread <threadId>` limits it to that thread's host, resolved as UF-5 resolves it. `--host` decides which accounts are included; a shared account that includes the host is listed with all its hosts. An unknown host is an error with a clear message and a non-zero exit code. A thread whose host cannot be resolved is an error only when there is more than one host; with one host the answer is that host's. Without either option all hosts are listed.
- R9. `--json` prints the same entries as JSON with `polledAt`, `ageMs` and `stale`; `--refresh` polls first, as in `status`.
- R10. Data older than 30 minutes is marked: `stale: true` in JSON and a line in the text output. The verdicts are still printed.
- R11. No account identifier in any output.
- R12. The text of `status` (without `--json`) does not change in this task.
- R13. `skills/usage-forecast/SKILL.md` documents `headroom`, the `verdict` fields and when an agent should use them: before a long or parallel job; prefer a provider with `headroom`; when the provider in use is `short`, `critical` or `hit`, tell the user and name the alternatives instead of switching providers on its own.
- R14. README and CHANGELOG ("Unreleased") describe the command and the fields.

### Acceptance Examples

- AE1. Codex: session calm (projection 21 %), weekly calm (69 %). Claude Code: session tight (95 %), weekly calm (64 %). `headroom` prints Codex first as `headroom` with the weekly window, then Claude Code as `tight` with the session window.
- AE2. Two providers are both `headroom`; tightest-window projections 69 % and 40 %. The 40 % one is first.
- AE3. A provider's session window is at 100 %, its weekly window calm. Verdict `hit`, "available again" is the session reset.
- AE4. A 7-day window, 3 days in, 60 % used: even spend would be about 42.9 %, so `paceDeviationPercent` is 17.1.
- AE5. A window 5 minutes into 5 hours at 3 %: `state: "early"`, `lasts: null`, `runsOutAt: null`; for the provider verdict it counts as calm.
- AE6. A provider with status `error` and no windows: verdict `unknown`, listed last with the status word.
- AE7. `headroom --thread thr_x` on an install with two hosts lists only the providers of the thread's host.
- AE8. Last poll 45 minutes ago: text output has a "data is 45m old" line, JSON has `stale: true`.

### Scope Boundaries

- The plugin does not pick or switch a provider; it only reports.
- No new RPC method and no UI change.
- No plan multiplier or capacity comparison between plans (UF-11).
- No token or cost figures (UF-12).
- No change to the text of `status`.

### Dependencies / Assumptions

- UF-5: `snapshot.hosts`, `sharedWith`, thread → host resolution in the service.
- UF-6: `forecast.main`, `forecast.early`.
- UF-7: `rawPaceState`, the held `window.pace`, the "worse of the two" rule.
- The exact names in the merged code win over the names in this plan.

### Sources

- UF-10 in BB Tasks; report item 12 in `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`.
- `src/server/cli.ts`, `src/shared/contract.ts`, `skills/usage-forecast/SKILL.md`.

Product Contract preservation: the Product Contract above is the brainstorm's outcome and is unchanged by planning.

## Planning Contract

### Key Technical Decisions

- KTD1. **Pure module `src/shared/headroom.ts`.** `windowVerdict(window, now)` returns the R1 object; `providerHeadroom(snapshot, now, {hostId?})` returns the ordered R3 entries. It groups shared accounts through the same helper `formatStatus` uses after UF-5; if UF-5 left that grouping private to `cli.ts`, move it to a shared module and use it from both, so `status` and `headroom` never disagree about one account. No SDK, no clock. The shown state is the worse of `rawPaceState(window, now)` and `window.pace`, exactly as the app's view computes it; if UF-7 left that combination inside `src/app/model.ts`, move the small combining function to `src/shared/pace.ts` and make the app import it, rather than writing it twice.
- KTD2. **`early` and `unknown`.** No pace state and `forecast.early` true → `early`; no pace state otherwise → `unknown`. A used percent of 100 or more is `hit` when `resetsAt` is null or in the future. A window whose `resetsAt` has passed is `unknown` with `resetsInMs: 0`, `lasts: null`, and is skipped by the provider verdict.
- KTD3. **Even pace.** `elapsed = durationMs - (resetsAt - now)`, clamped to `[0, durationMs]`; `paceDeviationPercent = usedPercent - 100 * elapsed / durationMs`, rounded to one decimal.
- KTD4. **`verdict` is added at print time**, in `src/server/cli.ts`, by mapping the snapshot through `windowVerdict` with the CLI's `now`. It is not stored and not added to the RPC snapshot, because it depends on the moment of the call.
- KTD5. **`headroom` command** in `createCli`: options `--json`, `--refresh`, `--host`, `--thread`. `--host` matches a host id exactly, else a host name case-insensitively. `--thread` uses the service's thread state (`hostId` from UF-5). Both given → error. Text format, one line per entry:

  ```text
  Headroom, polled 2026-11-16 00:10 UTC (1m ago)
    1. codex on Clovis (Plus): headroom – Weekly limit 57%, on pace for 69% at reset in 1d 6h
    2. claude-code on Clovis, Sky Blue M4 (Max): tight – Current session 62%, on pace for 95% at reset in 1h 40m
    3. acp-x on Clovis: unknown – not installed
  ```

  `short` and `critical` lines say `runs out in <span>` when `runsOutAt` is set, and `will not last to the reset` when it is null (a held state whose current projection no longer runs out); `hit` lines say `limit reached, available again in <span>`. With one host the "on <host>" part is omitted.
- KTD6. **JSON shape of `headroom`:** `{polledAt, ageMs, stale, entries: [{providerId, planLabel, hosts: [{hostId, hostName}], verdict, availableAt, worstWindow: {label, model, usedPercent, resetsAt} & the R1 verdict fields | null, status}]}`.
- KTD7. `STALE_AFTER_MS = 30 * 60_000`, a constant in `headroom.ts`.
- KTD8. No version bump; CHANGELOG "Unreleased".

### Sequencing

U1, then U2 and U3 in either order, then U4.

## Implementation Units

### U1. Verdict and headroom module

- Goal: the pure logic.
- Requirements: R1, R4, R5, R6, R7.
- Dependencies: UF-5, UF-6, UF-7 code on the branch.
- Files: `src/shared/headroom.ts`, `test/headroom.test.ts`; `src/shared/pace.ts` and `src/app/model.ts` only if KTD1's move is needed.
- Approach: KTD1, KTD2, KTD3, KTD7.
- Test scenarios: AE1–AE6; each pace state maps to the right `lasts`; held `window.pace` worse than the raw state wins; `paceDeviationPercent` negative when under the even pace, null without `durationMs` or `resetsAt`; a shared account is one entry with two hosts and the windows of the most recently answering member; host filter keeps a shared account with all its hosts; a provider whose windows are all `unknown` at 95 % is `tight`; a window at 100 % whose reset has passed does not make the provider `hit`; a held `short` with a calm current projection has `lasts: false` and `runsOutAt: null`; a provider with windows kept from an earlier good answer but status not `ok` → `unknown` with the status; tie on verdict and projection keeps the snapshot order.
- Verification: `npm run typecheck && npm test`.

### U2. `status --json` fields

- Goal: R1 and R2 in the CLI.
- Requirements: R1, R2, R11, R12.
- Dependencies: U1.
- Files: `src/server/cli.ts`, `test/cli.test.ts`.
- Approach: KTD4. The text branch of `status` is untouched.
- Test scenarios: every window in the JSON has `verdict`; all former keys are still present with the same values; the text output for the same snapshot is byte-for-byte what it was before this unit; no key containing `account` or `email` anywhere in the JSON.
- Verification: `npm test`.

### U3. `headroom` command

- Goal: the command.
- Requirements: R3, R5, R6, R7, R8, R9, R10, R11.
- Dependencies: U1.
- Files: `src/server/cli.ts`, `test/cli.test.ts`.
- Approach: KTD5, KTD6.
- Test scenarios: the text of AE1 and AE3; one host omits the host part; `--json` shape; `--host` by id and by name, unknown host → error with code and non-zero exit; `--thread` (AE7), an unresolvable thread with two hosts → error, with one host → that host's list; a held `short` line reads `will not last to the reset`; both options → error; `--refresh` calls the service's refresh; AE8; snapshot never polled → "not polled yet" and an empty list.
- Verification: `npm test`.

### U4. Skill, docs and live check

- Goal: agents know the command.
- Requirements: R13, R14.
- Dependencies: U2, U3.
- Files: `skills/usage-forecast/SKILL.md`, `README.md`, `CHANGELOG.md`, `AGENTS.md` (Layout line for `headroom.ts`).
- Approach: in the skill, add `headroom` to the commands list, a short table of the `verdict` fields, and the R13 guidance in three or four lines; extend the frontmatter `description` with "which provider has headroom". Keep the skill's existing sections. Then `npm ci && npm run typecheck && npm test && npm run build`. The plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). Take the real snapshot with `bb plugin rpc call usage-forecast snapshot`, run it through this branch's `headroom` and `status --json` formatting in a test or script, and compare the verdicts by hand with the windows. The coordinating thread runs the real commands after the release.
- Verification: the check command is green; `bb plugin list` shows `usage-forecast` still `running` from the marketplace source; the report quotes the output on the real snapshot with plan labels but without any account identifier.

## Verification Contract

- `npm ci && npm run typecheck && npm test && npm run build` passes.
- Tests cover AE1–AE8.
- On the real snapshot `headroom` and `status --json` agree with each other.
- No account identifier in code, logs or the report. Vendored `components/`, `lib/`, `hooks/` unchanged.

## Definition of Done

- R1–R14 met.
- All commits local on the child's branch; nothing pushed, no PR, no tag.
- Final report: branch, worktree path, commits, check result, live output, deviations from the plan.
