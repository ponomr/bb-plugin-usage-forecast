---
title: Worded Forecast - Plan
type: feat
date: 2026-11-15
topic: worded-forecast
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Worded Forecast - Plan

## Goal Capsule

- **Objective:** A window's forecast reads as a sentence the user can act on: when the limit runs out and how far short of the reset that is, or that it lasts; and, when it will not last, the spending rate that would make it last.
- **Tracker task:** UF-6.
- **Open blockers:** None.
- **Means:** One main projection per window chosen by a single rule in the shared forecast, carried over RPC, and worded by the app and the CLI from the same fields (KTD1, KTD2).
- **Authority:** `AGENTS.md` Critical Rules override this plan; the Product Contract overrides the Planning Contract and the units.
- **Execution profile:** One branch from `main`, test-first for the shared forecast, commits per unit. The executor commits locally and does not push, open a PR, tag, bump the version or release; the coordinating thread reviews, merges and releases.
- **Stop conditions:** Stop and report instead of working around it when a requirement cannot be met without changing how limits are polled or stored, or when the wording does not fit the band on the phone width the existing tests cover.

## Product Contract

### Summary

The plugin already computes when a limit runs out, but shows only "Limit will hit in 2d 4h" or a percent at the reset. This change words the forecast: the clock time the limit runs out and how long before the reset that is, or that the limit lasts; a spending budget when it will not last; and "too early to judge" at the start of a window. One rule decides which of the two projections speaks, so the text, the colour and the warning never disagree.

### Problem Frame

Each window has two projections: `current` (the window's own pace) and `learned` (the median peak of past windows). They differ: on 2026-11-15 the Claude Code week showed 60 % by the current pace and 73 % by the learned one. Today the band and the note use `current`, else `learned`; the `warning` flag and the CLI's `[over 100%]` fire when either is above 100 %; the tooltip shows both with no word on which one counts. In the first 5 % of a window there is no current pace, and the user sees either a learned number with no caveat or "No forecast yet".

The competitor review (report item 2) found that a run-out time, the shortfall before the reset and a daily budget are what users of such tools read first.

### Key Decisions

- **The current pace is the main projection.** The learned projection speaks only in the first 5 % of a window, labelled as "too early to judge, usually ends at N %", and otherwise stays a reference in the tooltip and the CLI. Text, colour, warning and the bar's tick all come from the main projection. (session-settled: user-directed — chosen over "the worse of the two" and over "no number at all while it is early".)
- **The budget is shown only when the limit will not last.** When the main projection runs out before the reset, the window also says the rate that would last to the reset. When the limit lasts, no budget is shown. (session-settled: user-directed — chosen over "always" and over "CLI and tooltip only".)
- **An early window never warns.** While it is too early to judge, a window is not coloured as running out and raises no warning, whatever the learned number is; a window already at 100 % is still "limit reached".

### Requirements

**Main projection**

- R1. Each window with a forecast has one main projection: the current pace once 5 % of the window has passed; before that, the learned projection when past windows exist; otherwise none.
- R2. The window's status, colour, warning flag, bar tick, the band's headline and the CLI's over-100 mark are all derived from the main projection only. In the early phase the window does not warn.
- R3. The tooltip and the CLI keep showing both projections, and say which one is the main one.

**Wording in the band**

- R4. A window whose main projection runs out before the reset says the local clock time it runs out (with the weekday when it is not today) and how long before the reset that is, for example "At this pace runs out Sat 7:59 PM – 2d 16h before reset" / «При текущем темпе кончится в сб 19:59 — за 2 д 16 ч до сброса».
- R5. The same window also states the budget that would last to the reset: the remaining percent divided by the remaining time, per day for a window of two days or longer and per hour for a shorter one, for example "to last: up to 11% a day" / «чтобы хватило — не больше 11 % в день». When less than one such unit remains, it states the percent left for the rest of the window instead.
- R6. A window whose main projection lasts says so with the "at this pace" caveat and keeps the projected percent at the reset, in the used or left form the `show` setting selects, and the time to the reset as today.
- R7. In the early phase the window says "too early to judge"; with past windows it adds what the window usually ends at, with none it adds nothing. The time to the reset stays.
- R8. A window at 100 % and a window with no forecast (unknown duration or no reset time) read as they do today.
- R9. Every new string exists in English and Russian in `src/app/i18n.ts`. Percent values follow the existing rounding rule.

**CLI**

- R10. `bb usage-forecast status` prints the same facts per window: the run-out time and the shortfall before the reset, or that the limit lasts; the budget when it will not last; "too early to judge" in the early phase; and which projection is the main one. CLI text stays English and UTC, as it is now.

**Compatibility**

- R11. The RPC keeps the existing forecast fields; the new ones are additions. Stored data does not change.

### Acceptance Examples

- AE1. Covers R1, R4, R5. A 7-day window at 60 % with 3 days left, used at an even pace since the window began (15 % a day, so it runs out in 2 days 16 hours): the note gives the run-out clock time with its weekday, "8h before reset", and a budget of 13 % a day; the window is coloured as running out.
- AE2. Covers R2. A window whose current pace ends at 80 % while its learned projection is 120 %: it reads as lasting, has the normal colour, raises no warning, and the CLI prints no over-100 mark. Today this window warns.
- AE3. Covers R1, R7. A 5-hour window 10 minutes old at 3 % with eight past windows whose median peak is 40 %: "Too early to judge – usually ends at about 40 %". The same window with no past windows: "Too early to judge".
- AE4. Covers R2, R7. A window 2 % into its duration whose learned projection is 110 %: no warning colour, no "will run out" headline.
- AE5. Covers R5. A 5-hour window at 95 % with 30 minutes left (about 21 % an hour, so it runs out in about 14 minutes): the budget line says 5 % is left until the reset, not a rate per hour.
- AE6. Covers R6. A window on pace for 57 % with `show` set to "left": "At this pace lasts to reset – about 43% left".
- AE7. Covers R10. The CLI line for the window of AE1 contains the run-out time in UTC, "8h before reset" and "budget 13%/day".

### Scope Boundaries

- No change to how the two projections are computed, to the 5 % threshold or to the colour thresholds.
- Colour and status from the pace relative to elapsed time is UF-7. A countdown and exact-time toggle for the reset is UF-9. Machine-readable CLI fields for agents are UF-10.
- No new setting.
- Push notification texts and their trigger (a used-percent threshold) do not change.
- Considered and not built: blending the two projections into one number; a budget shown when the limit lasts.

### Dependencies / Assumptions

- UF-5 (per-host limits) is being implemented in parallel on another branch and touches `src/server/cli.ts`, `src/app/model.ts`, `src/app/banner.tsx`, `src/shared/contract.ts` and `src/app/i18n.ts`. This plan keeps its edits to those files small and local so the coordinating thread can merge both.

### Sources / Research

- `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`, item 2 (outside the repository).
- `src/shared/forecast.ts` — `forecastWindow`, `MIN_ELAPSED_FRACTION`, `warning` computed from either projection.
- `src/app/model.ts` — `windowView` (already `current ?? learned`), `windowNote`, `paceDetails`, `headline`.
- `src/server/cli.ts` — `formatWindow`.
- `src/app/format.ts` — `formatSpan`, `formatClock`, `formatTime`.
- `test/forecast.test.ts`, `test/banner.test.tsx`, `test/cli.test.ts`, `test/app-fixtures.tsx`.

Product Contract preservation: Product Contract unchanged.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The shared forecast names the main projection.** `WindowForecast` gains `main: "current" | "learned" | null` and `early: boolean`. `early` is true when the window is running and less than `MIN_ELAPSED_FRACTION` of it has passed. `main` is `"current"` when `current` exists, `"learned"` when `early` and `learned` exists, else null. `warning` becomes: the limit is hit, or not early and the main projection is above 100 %. A window whose reset is further away than one duration (elapsed unknown) is treated as early. Governs R1, R2.
- KTD2. **The budget is a pure shared function, not a stored field.** `lastingBudget({ usedPercent, resetsAt, durationMs, now })` in `src/shared/forecast.ts` returns `{ percent, per: "day" | "hour" | "rest" }` or null: `per` is `day` for a duration of two days or more, else `hour`; when the remaining time is shorter than that unit, `per` is `rest` and `percent` is the percent left. The app and the CLI both call it, so the RPC needs no budget field and the number cannot go stale between polls. Governs R5, R10.
- KTD3. **`windowView` follows `main`, and gains an `early` status.** `WindowStatus` adds `"early"`; an early window has tone from the used percent only, no tick and no run-out. `windowView` reads the projection `forecast.main` names instead of `current ?? learned`. `headline` treats `early` like `idle`. A forecast from an older server without `main` is read as before (`current ?? learned`, not early), so a stale snapshot during an upgrade still renders. Governs R2, R7, R11.
- KTD4. **The note stays one string per window; the budget is a second short line under it.** `windowNote` returns the main sentence; a new `windowBudget` returns the budget line or null and is rendered under the note in the expanded band only where the note is rendered today. The collapsed band and the headline do not grow. Governs R4, R5.
- KTD5. **Run-out time uses the existing clock formatter plus a weekday.** In the app: the time alone when it is today, else short weekday and time, through `toLocaleString(s.locale, …)` as `formatClock` does. In the CLI: the existing UTC time format. Governs R4, R10.
- KTD6. **Contract additions are optional-with-default.** `windowForecastSchema` adds `main` and `early` with zod defaults (null, false) so a value stored before the upgrade still parses. Governs R11.

### Sequencing

U1, then U2 and U3 (independent of each other), then U4.

---

## Implementation Units

### U1. Main projection and budget in the shared forecast

- **Goal:** The forecast names its main projection and whether it is early, warns from the main one only, and exposes the budget function.
- **Requirements:** R1, R2, R5, R11.
- **Dependencies:** none.
- **Files:** `src/shared/forecast.ts`, `src/shared/contract.ts`, `test/forecast.test.ts`.
- **Approach:** KTD1, KTD2, KTD6. Keep `current`, `learned` and their computation unchanged. Update the file's header comment where it describes the warning.
- **Test scenarios:**
  - Past 5 % with both projections: `main` is `current`, `early` false.
  - Before 5 % with history: `main` is `learned`, `early` true, `warning` false even when the learned projection is above 100 %.
  - Before 5 % without history: `main` null, `early` true.
  - Covers AE2. Current 80 %, learned 120 %: `warning` false. Current 120 %, learned 80 %: `warning` true.
  - Hit window: `warning` true, `early` false.
  - Reset further away than one duration: `early` true, `main` follows the learned projection.
  - Covers AE1. `lastingBudget` for a 7-day window at 60 % with 3 days left: 13.3 per day.
  - `lastingBudget` for a 5-hour window at 50 % with 2 hours left: 25 per hour.
  - Covers AE5. Less than one unit left: `per` is `rest` and `percent` is the percent left.
  - `lastingBudget` with no reset, a passed reset, unknown duration or 100 % used: null.
  - A forecast object without `main` and `early` parses through the schema with the defaults.
- **Verification:** `npm run typecheck && npm test`.

### U2. Wording in the band

- **Goal:** The window note, budget line, tooltip and headline read as the Product Contract says.
- **Requirements:** R2, R3, R4, R5, R6, R7, R8, R9.
- **Dependencies:** U1.
- **Files:** `src/app/model.ts`, `src/app/format.ts`, `src/app/i18n.ts`, `src/app/banner.tsx`, `test/banner.test.tsx`, `test/app-fixtures.tsx`, plus a model-level test file if `test/banner.test.tsx` has none for `windowNote`.
- **Approach:** KTD3, KTD4, KTD5. New strings replace `willHitIn`, `onPaceFor` and `leftAtReset` where their wording changes; remove strings that end up unused. `paceDetails` marks the main line. Keep each banner edit local to the window list item.
- **Test scenarios:**
  - Covers AE1. Note and budget line in English and in Russian for the running-out window, with the weekday because the run-out is not today; and time only when it is today.
  - Covers AE6. Lasting window with `show` "used" and with "left".
  - Covers AE3. Early window with and without past windows.
  - Covers AE4. Early window with a learned projection above 100 %: normal tone, headline is not "will run out".
  - Covers AE5. Budget line in the `rest` form.
  - Lasting window: no budget line is rendered.
  - Hit window and no-forecast window: text equal to today's.
  - Tooltip names the main projection; with only one projection it shows one line.
  - A forecast without `main` renders as it did before this change.
- **Verification:** `npm run typecheck && npm test`.

### U3. Wording in the CLI

- **Goal:** `bb usage-forecast status` prints the same facts.
- **Requirements:** R3, R10.
- **Dependencies:** U1.
- **Files:** `src/server/cli.ts`, `test/cli.test.ts`.
- **Approach:** Change `formatWindow` only. Shape: `Weekly limit: 60%, resets in 3d 0h, at this pace runs out 2026-11-21 19:59 UTC (8h before reset), budget 13%/day; usual pace 73% (8 windows)`; lasting: `at this pace lasts to reset (57% at reset)`; early: `too early to judge; usual pace 40% (8 windows)`. The `[over 100%]` mark follows `warning`. "Runs out" wording and the budget are printed on the same condition as the app's `out` status (main projection strictly above 100 %), never on `runOutAt` alone: a projection of exactly 100 % reads as lasting in both places.
- **Test scenarios:**
  - Covers AE7. The running-out window line.
  - Lasting window line; early line with and without history.
  - Covers AE2. Current 80 %, learned 120 %: no over-100 mark, the learned number still printed.
  - Hit window and unknown-duration window lines equal today's.
  - Main projection exactly 100 %: the line says it lasts and prints no budget, as the band does.
- **Verification:** `npm run typecheck && npm test`.

### U4. Documentation and live look

- **Goal:** The repository describes the wording and the result is seen on the real server.
- **Requirements:** R4, R10.
- **Dependencies:** U2, U3.
- **Files:** `README.md`, `CHANGELOG.md` (an entry under an "Unreleased" heading; no version bump), `skills/` usage text if it quotes the old CLI line.
- **Approach:** Install from the branch checkout with `npm run build && bb plugin install "$PWD" --yes`, run `bb usage-forecast status`, and open the band of one thread through a screenshot or the RPC `snapshot`. Record what was seen in the final report.
- **Test scenarios:** Test expectation: none -- documentation and live verification.
- **Verification:** `npm ci && npm run typecheck && npm test && npm run build`; `bb plugin list` shows the plugin `running`; `bb plugin logs usage-forecast` shows no error.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Types | `npm run typecheck` | every unit |
| Tests | `npm test` | U1 to U3 |
| Full check | `npm ci && npm run typecheck && npm test && npm run build` | before the final report |
| Both languages | every new key exists in the English and the Russian table (the `Strings` type enforces it) | U2 |
| Live | the checks of U4 | U4 |

## Definition of Done

- Every requirement R1 to R11 is covered by a passing test or by an observation recorded from U4.
- The full check passes on the branch.
- Text, colour, warning, tick, headline and the CLI mark come from one projection in every tested case.
- UI strings exist in English and Russian in `src/app/i18n.ts`; code, comments and docs are English.
- Vendored `components/`, `lib/`, `hooks/` are unchanged.
- No unused string, abandoned experiment or debug output remains in the diff.
- Work is committed locally on its branch, not pushed; the final report lists the commits, the test results, what the live look showed and anything that differed from this plan.
