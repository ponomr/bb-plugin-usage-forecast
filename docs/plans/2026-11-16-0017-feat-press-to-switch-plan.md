---
title: Press to switch reset time and used/left (UF-9)
status: draft
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
tags: [usage-forecast, UF-9]
---

# Press to switch reset time and used/left (UF-9)

## Goal Capsule

Pressing a window's reset time switches every row between the countdown ("4h 12m") and the exact local time ("Sat 19:59"). Pressing a window's percent switches every row between used and left. Both choices are stored on the server as plugin settings, so a press on the phone changes the Mac too.

The work starts from a `main` that already contains UF-5, UF-6 and UF-7 (UF-6 rewrote the rows' wording).

## Product Contract

### Summary

Two display choices, each changed by one press in the limits band and each kept as a plugin setting: `limitsShow` (exists, today changed only on the settings page) and a new `resetShow`.

### Problem Frame

A countdown answers "how long must I wait", an exact time answers "when can I plan the heavy task". Today the band shows only the countdown, and switching used/left needs a trip to the settings page.

### Key Decisions

- **The choice is shared by all devices and stored on the server.** (session-settled: owner chose «Общий + расход/остаток» on 2026-11-16.)
- **The press on the percent for used/left is part of this task; the setting stays and the press changes it.** (session-settled: same answer.)
- **One press changes all rows, not one row.** (session-settled: task text of UF-9.)

### Requirements

- R1. A new plugin setting `resetShow` with the values `countdown` (default) and `time`, shown on the settings page next to `limitsShow`.
- R2. In `time` mode every place in the band that shows a window's time to reset shows the local time of the reset instead: the time alone when the reset is today ("19:59"), the short weekday and the time otherwise ("Sat 19:59", «сб 19:59»). In a sentence it reads "resets at 19:59" / "resets Sat 19:59" («сброс в 19:59» / «сброс в сб 19:59»). Time format follows the UI language's locale, as `formatTime` does today.
- R3. Pressing a window's reset time changes `resetShow` for all rows and all providers. Press targets: the reset time in the collapsed row, and the note line under a window in the expanded list when that note contains the reset time. After UF-6 the note of a window that will not last names the run-out time and has no reset time; such a note is not a press target, and the reset press for that window is in the collapsed row.
- R4. Pressing a window's percent changes `limitsShow` between `used` and `remaining` for all rows. Press targets: the percent in the collapsed row and in the expanded list. The context percent is not a press target, and neither are the percents in the one-line summary of another provider (`OtherProvider`), which sits inside the disclosure button.
- R5. A press shows its result at once on the pressing device and reaches other open devices without a page reload, at the latest on their next settings refresh.
- R6. The settings page and the press are two ways to change the same values; changing one is reflected by the other.
- R7. If saving fails, the row returns to the previous value. No error banner is added.
- R8. Press targets are real buttons: reachable by keyboard, with an accessible label saying what the press will do ("Show reset time", "Show countdown", "Show percent left", "Show percent used"), with no visual change to the row except a pointer cursor and the focus ring.
- R9. Only the reset time changes with `resetShow`. Spans that are not the reset time stay as they are: the UF-6 run-out wording ("runs out Sat 7:59 PM", "2d 16h before reset", the budget line) and "5m ago".
- R10. Every new string is in `src/app/i18n.ts` in English and Russian.
- R11. The CLI output does not change.

### Acceptance Examples

- AE1. Collapsed row shows "Week 1d 6h ▬ 57%". Press "1d 6h": it shows "Week Tue 19:59 ▬ 57%" and the session window in the same row shows its time too.
- AE2. Expanded note reads "… resets in 1d 6h". Press the note: it reads "… resets Tue 19:59". The settings page now shows `Reset shows: Exact time`.
- AE3. Press "57%" with `limitsShow = used`: every window shows the percent left ("43%") and the bars follow, exactly as the setting does today.
- AE4. A reset later today, in `time` mode: "19:59", sentence form "resets at 19:59".
- AE5. The save call fails: the row shows the previous form again within the same interaction.
- AE6. Change `resetShow` on the settings page while the band is open: the band follows without a reload.
- AE7. A window without `resetsAt` shows no reset time in either mode and has no reset press target.

### Scope Boundaries

- No per-row or per-provider choice.
- No change to the headline (`resetName` already names an exact time), to tooltips, to push texts or to the CLI.
- No change to the context bar.
- The sidebar card of UF-8 gets the behaviour only through the shared row components; nothing is built for it here.

### Dependencies / Assumptions

- `PluginSettingsHandle.experimental_set` (SDK 0.6.132) lets the plugin's server write its own settings. Unverified live: that `useSettings()` in the app follows such a write without a reload. U1 checks it.
- The collapsed row and the expanded window list are not inside a button (the expand toggle is a separate chevron), so buttons inside them are valid. The `OtherProvider` summary is inside a button and gets no press target.

### Sources

- UF-9 in BB Tasks; report item 11 in `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`.
- `server.ts` (settings declaration), `src/shared/limits-show.ts`, `src/app/banner.tsx` (`CollapsedRow`, `WindowList`, `WindowPercent`), `src/app/model.ts` (`windowNote`), `src/app/format.ts` (`formatResetIn`, `formatTime`).

Product Contract preservation: the Product Contract above is the brainstorm's outcome and is unchanged by planning.

## Planning Contract

### Key Technical Decisions

- KTD1. **Setting.** `src/shared/reset-show.ts` mirrors `limits-show.ts`: `RESET_SHOW = ["countdown", "time"]`, `ResetShow`, `DEFAULT_RESET_SHOW`, `parseResetShow`. Declared in `server.ts` as a `select` with option labels ("Countdown", "Exact time").
- KTD2. **One RPC mutation `setDisplay`.** Input `{limitsShow?: LimitsShow, resetShow?: ResetShow}` (zod, at least one key, unknown values rejected); the handler calls `settingsHandle.experimental_set` with the given keys and returns the two effective values. It invalidates nothing in the limits data.
- KTD3. **Shared optimistic value in the app.** `src/app/hooks.ts` keeps one module-level override (`useSyncExternalStore`) per setting. `useLimitsShow()` and the new `useResetShow()` return the override when set, else the settings value. `useSetDisplay()` sets the override, calls `setDisplay`, and clears the override when the settings value equals it, or at once on failure (R7). All rows read the same store, so one press changes them together.
- KTD4. **Formatting.** `format.ts` gains `formatResetAt(s, resetsAt, now)` (compact form of R2) and `formatResetIn` gains an optional `mode` parameter that picks the sentence form and defaults to the countdown, so the push notifier (`src/server/limit-notifier.ts`), which calls it without a mode, keeps its text; `i18n.ts` gains `resetsAt(time, weekday | null)`. The band's callers (`CollapsedRow`, `windowNote`) pass the mode from `useResetShow()`; `windowNote` takes it as a parameter next to `show`. Weekday names reuse the tables `i18n.ts` already has.
- KTD5. **Press targets.** `WindowPercent` becomes a button when given an `onPress`; the collapsed reset span and the expanded note line are wrapped in a plain `<button type="button">` with inherited font and colour. No vendored component is edited.
- KTD6. **Fallback if settings do not follow live** (U1): after a successful `setDisplay` the app keeps the override, remembers the settings value it saw at the press, and drops the override as soon as the settings value differs from that remembered value (so a later change on the settings page or from another device wins); other devices pick the value up on their next settings load. If `experimental_set` itself is unavailable or throws on this host, stop and report; a KV-backed copy of the settings is not built without the owner's word.
- KTD7. No version bump; the entry goes under "Unreleased" in `CHANGELOG.md`. The RPC addition is additive.

### Sequencing

U1 first (it can stop the work), then U2, U3, U4.

## Implementation Units

### U1. Setting, RPC and the live check of the write path

- Goal: the server side, and proof that a server-side settings write reaches the app.
- Requirements: R1, R5, R6.
- Dependencies: none.
- Files: `src/shared/reset-show.ts`, `src/shared/contract.ts`, `src/server/rpc.ts`, `server.ts`, `test/plugin.test.ts`, `test/helpers.ts` (settings fake gains `experimental_set` if it lacks it).
- Approach: KTD1, KTD2. The plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). Check the write path with a separate throwaway plugin with its own id (`uf-settings-spike`) in a temporary directory outside the repository: one select setting, one RPC mutation that calls `experimental_set`, and a composer banner that prints the `useSettings()` value. Install it from its path, open a thread in a browser session, call the mutation with `bb plugin rpc call uf-settings-spike …` and watch whether the printed value changes without a reload. Then run `bb plugin remove uf-settings-spike`, delete its directory and confirm with `bb plugin list` that it is gone and `usage-forecast` is still `running`. Record the result as a Host facts line in `AGENTS.md`.
- Test scenarios: `setDisplay` writes one key and leaves the other; rejects an unknown value and an empty input; returns the effective values; the settings page descriptor for `resetShow` has the default `countdown`.
- Verification: `npm run typecheck && npm test`; the live observation is written down. Stop conditions per KTD6.

### U2. Formatting and model

- Goal: the two forms of the reset time.
- Requirements: R2, R9, R10.
- Dependencies: U1 (types).
- Files: `src/app/format.ts`, `src/app/model.ts`, `src/app/i18n.ts`, `test/banner.test.tsx` or a new `test/format.test.ts`.
- Approach: KTD4. Keep every other span untouched (R9).
- Test scenarios: reset today → time only; reset on another day → weekday and time, English and Russian; reset already passed → the existing "resets now" text in both modes; `resetsAt` null → null; `windowNote` in each status with `mode = time` contains the exact time and leaves the UF-6 run-out wording unchanged; write the assertions against the wording actually on the branch.
- Verification: `npm test`.

### U3. Press targets in the band

- Goal: the presses.
- Requirements: R3, R4, R5, R7, R8, AE7.
- Dependencies: U1, U2.
- Files: `src/app/hooks.ts`, `src/app/banner.tsx`, `src/app/i18n.ts`, `test/banner.test.tsx`, `test/app-fixtures.tsx`.
- Approach: KTD3, KTD5. A press must not toggle the band's expanded state.
- Test scenarios (jsdom): AE1, AE2 (text part), AE3, AE5 (mutation rejects → previous form), AE7; pressing in the collapsed row changes the expanded list after expanding; the buttons have the accessible labels in both languages; the context percent and the `OtherProvider` summary percents are not buttons; a note without a reset time is not a button; a settings value that changes after a press replaces the override.
- Verification: `npm run typecheck && npm test`.

### U4. Docs and live look

- Goal: record and check.
- Requirements: all AEs live where possible.
- Dependencies: U3.
- Files: `README.md`, `CHANGELOG.md` ("Unreleased"), `AGENTS.md` (Layout line for `reset-show.ts`).
- Approach: `npm ci && npm run typecheck && npm test && npm run build`. The real plugin is not replaced (see U1), so the presses are checked by the jsdom tests and AE6 by the spike of U1; the coordinating thread presses both targets on the Mac and the phone after the release.
- Verification: the check command is green; `bb plugin list` shows `usage-forecast` still `running` from the marketplace source; the report lists per AE whether it was seen in a test or in the spike.

## Verification Contract

- `npm ci && npm run typecheck && npm test && npm run build` passes.
- Tests cover AE1–AE5 and AE7; AE6 is checked in the U1 spike.
- No account identifier in code, logs, screenshots or the report. Vendored `components/`, `lib/`, `hooks/` unchanged.

## Definition of Done

- R1–R11 met, or a stop condition reported with the facts from U1.
- All commits local on the child's branch; nothing pushed, no PR, no tag.
- Final report: branch, worktree path, commits, check result, spike observations, deviations.
