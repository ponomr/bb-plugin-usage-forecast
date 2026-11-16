---
title: Pace-Based Window Status - Plan
type: feat
date: 2026-11-16
topic: pace-status
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Pace-Based Window Status - Plan

## Goal Capsule

- **Objective:** A window's status and colour say whether the limit will last at the current pace, instead of how much of it is used.
- **Tracker task:** UF-7.
- **Open blockers:** None. The branch starts from the UF-6 branch (worded forecast), which supplies the main projection and the early flag.
- **Means:** A pace state per window, computed at poll time from the main projection with a hold before it calms down, carried over RPC and used by the band and the CLI (KTD1 to KTD3).
- **Authority:** `AGENTS.md` Critical Rules override this plan; the Product Contract overrides the Planning Contract and the units.
- **Execution profile:** One branch on top of the UF-6 branch, test-first for the shared state logic, commits per unit. The executor commits locally and does not push, open a PR, tag, bump the version or release; the coordinating thread reviews, merges and releases.
- **Stop conditions:** Stop and report instead of working around it when the UF-6 branch does not provide `forecast.main` and `forecast.early` as this plan assumes, or when a requirement would change when a push notification is sent.

## Product Contract

### Summary

Today a window turns amber at 75 % used and red at 90 %, whatever the pace. This change colours a window by its pace: calm, tight, will not last, critical, used up. Red means "act now". A window calms down only after a short hold, so the status does not flicker. At the start of a window, when no pace exists yet, the old thresholds apply.

### Problem Frame

A fixed threshold on the used percent is wrong in both directions. A window at 80 % ten minutes before its reset is amber although it will clearly last. A window at 40 % one hour into a five-hour window looks calm although it will run out long before the reset. The plugin already computes a projection at the reset; the status ignores it except for the "will run out" case, and even then the used-percent colour can override it.

### Key Decisions

- **Red is for the urgent states only.** Calm is the normal colour; tight and will-not-last are amber and differ by their text; critical and used-up are red. A weekly window that will fall short four days from now is amber, not red all week. (session-settled: user-directed — chosen over "will-not-last is red at once" and over keeping today's 130 % rule.)
- **With a known pace, the pace alone sets the colour.** The 75 % and 90 % used thresholds stay only where there is no pace: the early phase of a window and windows without a forecast. (session-settled: user-directed — chosen over "the worse of pace and threshold".)
- **Getting worse is immediate, calming down waits.** A window moves to a worse state on the poll that sees it and to a calmer one only after the calmer reading has held for ten minutes.

### Requirements

**States**

- R1. A window with a main projection from the current pace has one of five states:
  - used up: 100 % used;
  - critical: the projection is above 100 % and the limit runs out within one tenth of the window's duration from now;
  - will not last: the projection is above 100 %;
  - tight: the projection, rounded as shown, is 85 % or more;
  - calm: otherwise.
- R2. A window in the early phase or without a forecast has no pace state; it is coloured by the used percent with today's thresholds (amber from 75 %, red from 90 %). A window at 100 % is used up in every case.
- R3. A window moves to a worse state at once. It moves to a calmer state only after every poll for ten minutes has read calmer; it then takes the worst state read during that hold. A new window (after a reset) starts fresh.

**What the state drives**

- R4. Colour: calm normal; tight and will-not-last amber; critical and used-up red. The window's bar, its percent, its note and the band's collapsed indicator all use this colour.
- R5. The band's headline comes from the worst state among the provider's windows: used up (as today), critical ("runs out in 20m"), will not last (as today), tight (new: tight, with the projected percent and the reset), calm (as today).
- R6. A tight window's note says so in words; the other states keep the wording of the worded forecast.
- R7. `bb usage-forecast status` prints the state word for each window that has one.
- R8. New strings exist in English and Russian in `src/app/i18n.ts`.

**Unchanged**

- R9. Push notifications keep their trigger (the used-percent threshold and 100 %) and their texts.
- R10. The context-window colours (50 % and 80 %) do not change.
- R11. The RPC keeps existing fields; the state is an addition. A snapshot stored before the upgrade still renders.

### Acceptance Examples

- AE1. Covers R1, R4. A five-hour window at 80 %, ten minutes before its reset, on an even pace (projection about 83 %): calm, normal colour. Today it is amber.
- AE2. Covers R1, R4. A five-hour window at 40 % one hour in (projection 200 %, runs out in 1 h 30 m): will not last, amber. Thirty minutes before it runs out: critical, red.
- AE3. Covers R1. A window at 92 % five minutes before its reset on an even pace (projection about 94 %): tight, amber. Today it is red.
- AE4. Covers R3. A window read as will-not-last, then calm on the next poll two minutes later: still will-not-last. Calm on every poll for ten minutes: calm.
- AE5. Covers R3. A window read as critical, then tight for four minutes, then will-not-last for six more: after the hold it is will-not-last, not tight.
- AE6. Covers R2. A window five minutes into a five-hour window at 3 %: no pace state, normal colour. A weekly window with unknown duration at 80 %: amber by the threshold.
- AE7. Covers R9. A window crossing the push threshold while calm still sends its push; a window that is critical below the push threshold sends none.
- AE8. Covers R5. A provider with a calm session window and a tight weekly window: the headline is the tight one.

### Scope Boundaries

- No setting for the 85 % mark, the tenth-of-window mark or the hold.
- No push notification on a state change.
- The sidebar indicator that will show the worst state across providers is UF-8.
- Considered and not built: a hold proportional to the window length; a separate colour for will-not-last.

### Dependencies / Assumptions

- The UF-6 branch provides `WindowForecast.main` (`"current" | "learned" | null`), `WindowForecast.early`, a `warning` derived from the main projection, and the `early` window status in `src/app/model.ts`. The executor starts from that branch.
- The poll interval is a setting of 1 to 60 minutes. With an interval above ten minutes the hold is satisfied by the first calmer poll after ten minutes, which is the intended behaviour.
- UF-5 (per-host limits) is being implemented in parallel and rewrites much of `src/server/poller.ts`. This plan keeps its poller edit to a few lines so the two can be merged.

### Sources / Research

- `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`, item 3 (outside the repository).
- `src/shared/thresholds.ts` — `limitTone`, `paceTone`, `PACE_RED_PERCENT`, `forecastWarns`, `worseTone`.
- `src/app/model.ts` — `windowView`, `headline`, `worstProvider`.
- `src/server/poller.ts` — `ok()`, where the forecast of each window is computed and the open window (`StoredWindow`) is updated.
- `src/server/storage.ts` — `StoredWindow`.
- `src/server/limit-notifier.ts` — push trigger, not to be changed.

Product Contract preservation: Product Contract unchanged.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **The state logic is a pure module.** New `src/shared/pace.ts` exports `PaceState = "calm" | "tight" | "short" | "critical" | "hit"`, `rawPaceState(window fields, now)` returning a state or null (R1, R2), `nextPace(previous, raw, now)` applying the hold (R3), and `paceStateTone(state)`. Constants: `TIGHT_PERCENT = 85`, `CRITICAL_WINDOW_FRACTION = 0.1`, `CALM_HOLD_MS = 10 * 60_000`. No SDK, no clock. Only a main projection of `"current"` yields a state; `"learned"` and null do not.
- KTD2. **The hold state lives in the open window record.** `StoredWindow` gains optional `pace: { state, calmer: { state, since } | null }`. `nextPace` rules: no previous or raw null → raw (and no hold); raw worse or equal → raw, hold cleared; raw calmer → keep the previous state, start or continue the hold remembering the worst raw state seen in it; when `now - since >= CALM_HOLD_MS` → switch to that remembered state and clear the hold. The record is replaced when a new window starts, as today, which resets the state. The value is a few dozen bytes per window. Governs R3.
- KTD3. **The state travels on the window.** `limitWindowSchema` gains `pace` (the state or null) with a zod default of null. The poller sets it where it sets `forecast`; `toSnapshot` nulls it together with the forecast for a window whose reset has passed. The app computes `rawPaceState` itself from the window's fields at render time and combines it with `window.pace` as KTD4 says, so a snapshot stored before the upgrade (no `pace`) renders with the raw state and loses nothing. Governs R11.
- KTD4. **`windowView` maps the state to status and tone.** The view has two states: `raw`, from `rawPaceState` at render time, and `shown`, the worse of `raw` and the held `window.pace` (when `raw` is null, `shown` is null too). Every text follows `raw`, so a sentence never claims a run-out the current forecast does not have: `hit` → status `hit`; `critical` and `short` → status `out`; `tight` and `calm` → status `ok`. Colour and the ranking of windows and providers follow `shown`, through `paceStateTone`. During a hold a window can therefore be amber while its note says it lasts; that is the intended reading of "calming down waits". Computing `raw` at render time also lets a window turn critical between polls. `WindowView` gains `pace` (the shown state). With no state: the UF-6 statuses `early` and `idle` with `limitTone(used)`. `paceTone`, `PACE_RED_PERCENT` and the `worseTone(limitTone, paceTone)` mix are removed when nothing else uses them. `worstProvider` and `headline` rank by the state. Governs R4, R5.
- KTD5. **The notifier is not touched.** No file under the push path changes; a test pins that a state does not alter what `check` sends. Governs R9.

### Sequencing

U1, then U2, then U3 and U4 (independent of each other), then U5.

---

## Implementation Units

### U1. Pace state module

- **Goal:** The pure state logic with its hold.
- **Requirements:** R1, R2, R3.
- **Dependencies:** none.
- **Files:** `src/shared/pace.ts` (new), `test/pace.test.ts` (new).
- **Approach:** KTD1, KTD2. `rawPaceState` takes `usedPercent`, `durationMs` and the forecast; it uses `forecast.current` when `forecast.main === "current"`.
- **Test scenarios:**
  - Covers AE1, AE3. Projection 83 % → calm; 84.6 % (shown as 85 %) → tight; 94 % → tight; exactly 100 % → tight; 100.4 % → short.
  - Covers AE2. Projection 200 % with run-out 90 minutes away in a five-hour window → short; 30 minutes away → critical; exactly one tenth away → critical.
  - Used 100 % → hit, with or without a forecast.
  - Covers AE6. Early forecast (`main` learned or null) → null; no forecast → null.
  - Covers AE4. `nextPace`: short then calm two minutes later → short with a hold; calm through ten minutes → calm.
  - Covers AE5. critical, then tight for four minutes, then short for six → short.
  - A reading worse than or equal to the held state (the state shown before the hold began) applies at once and clears the hold; a reading calmer than the held state but worse than the one remembered in the hold only updates the remembered state.
  - Raw null after a state (window became early or lost its forecast) → null.
  - No previous state → raw at once.
- **Verification:** `npm run typecheck && npm test`.

### U2. Poller and contract

- **Goal:** Each stored window carries its held state and the snapshot exposes it.
- **Requirements:** R3, R11.
- **Dependencies:** U1.
- **Files:** `src/server/storage.ts` (`StoredWindow.pace`), `src/server/poller.ts`, `src/shared/contract.ts`, `test/poller.test.ts`.
- **Approach:** KTD2, KTD3. In `ok()`, after the forecast of a window is computed, call `rawPaceState` and `nextPace` with the previous open record's `pace`, store the result in the open record and set `pace` on the window. Keep the edit to those lines.
- **Test scenarios:**
  - Two polls two minutes apart, will-not-last then calm: the snapshot window stays `short`; a third poll past ten minutes: `calm`.
  - A reset between polls: the new window starts with the raw state, no hold carried over.
  - A window whose reset has passed: `pace` null in the snapshot.
  - A stored latest value without `pace` (written before the upgrade) parses and yields `pace` null.
  - Covers AE7. With a critical window below the push threshold the notifier sends nothing; with a calm window crossing it the push is sent.
- **Verification:** `npm run typecheck && npm test`.

### U3. Band

- **Goal:** Colour, headline and note follow the state.
- **Requirements:** R4, R5, R6, R8.
- **Dependencies:** U2.
- **Files:** `src/app/model.ts`, `src/shared/thresholds.ts`, `src/app/i18n.ts`, `src/app/banner.tsx` only if a tone is computed there, `test/banner.test.tsx`, `test/app-fixtures.tsx`.
- **Approach:** KTD4. New strings: the tight headline, the tight note and the critical headline, in both languages. Update the header comment of `src/shared/thresholds.ts`.
- **Test scenarios:**
  - Covers AE1. 80 % used with `pace: "calm"`: normal tone on bar, percent and note.
  - Covers AE3. 92 % used with `pace: "tight"`: amber, tight note.
  - Covers AE2. `short` → amber with the will-run-out wording; `critical` → red with the critical headline.
  - Covers AE6. `pace` null with an early forecast at 3 % → normal; `pace` null without a forecast at 80 % → amber; at 92 % → red.
  - Held state: `pace: "short"` with a current forecast of 80 % and no run-out time: amber, the note is the lasting wording, the headline makes no run-out claim.
  - `pace` absent (old snapshot) with a current forecast above 100 %: rendered as will-not-last from the raw state.
  - A window whose stored `pace` is `short` and whose run-out is now within a tenth of the window: red with the critical headline.
  - Covers AE8. Calm session window and tight weekly window: the tight headline.
  - Headline order: hit over critical over short over tight over calm.
  - `worstProvider` picks the provider with the worst state.
  - Both languages for each new string.
- **Verification:** `npm run typecheck && npm test`.

### U4. CLI

- **Goal:** The status command names the state.
- **Requirements:** R7.
- **Dependencies:** U2.
- **Files:** `src/server/cli.ts`, `test/cli.test.ts`.
- **Approach:** In `formatWindow`, print the state word after the percent: `Weekly limit: 60% [will not last], …`; words: `calm`, `tight`, `will not last`, `critical`, `used up`. No word when `pace` is null.
- **Test scenarios:**
  - One line per state with its word; a window with `pace` null has no bracket.
- **Verification:** `npm run typecheck && npm test`.

### U5. Documentation and live look

- **Goal:** The repository describes the states and the result is seen on the real server.
- **Requirements:** R1, R4.
- **Dependencies:** U3, U4.
- **Files:** `README.md`, `CHANGELOG.md` (under the "Unreleased" heading; no version bump), `AGENTS.md` only if the Layout list needs the new module.
- **Approach:** Install from the branch checkout with `npm run build && bb plugin install "$PWD" --yes`, run `bb usage-forecast status` after one poll, and record the lines in the final report.
- **Test scenarios:** Test expectation: none -- documentation and live verification.
- **Verification:** `npm ci && npm run typecheck && npm test && npm run build`; `bb plugin list` shows the plugin `running`; `bb plugin logs usage-forecast` shows no error.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Types | `npm run typecheck` | every unit |
| Tests | `npm test` | U1 to U4 |
| Full check | `npm ci && npm run typecheck && npm test && npm run build` | before the final report |
| Push unchanged | `test/limit-notifier.test.ts` passes with no expectation changed | U2 |
| Live | the checks of U5 | U5 |

## Definition of Done

- Every requirement R1 to R11 is covered by a passing test or by an observation recorded from U5.
- The full check passes on the branch.
- No file of the push path changed.
- UI strings exist in English and Russian in `src/app/i18n.ts`; code, comments and docs are English.
- Vendored `components/`, `lib/`, `hooks/` are unchanged.
- No unused threshold, string, abandoned experiment or debug output remains in the diff.
- Work is committed locally on its branch, not pushed; the final report lists the commits, the test results, what the live look showed and anything that differed from this plan.
