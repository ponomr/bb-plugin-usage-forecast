---
title: Plan multiplier and hidden providers (UF-11)
status: draft
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
tags: [usage-forecast, UF-11]
---

# Plan multiplier and hidden providers (UF-11)

## Goal Capsule

Next to a provider's plan name the plugin shows the plan's multiplier when the host reports one ("Max 5×"). A new setting hides chosen providers from every summary of "all providers" (the band's list of other providers, the sidebar sign, push, the `headroom` command), while a thread that runs on a hidden provider still shows that provider's limits.

The work starts from a `main` that already contains UF-5 to UF-10. Names of files and helpers introduced by those tasks are given below as they are planned; read the code on the branch and use what is there.

## Product Contract

### Summary

Two small additions: the multiplier from the host's undocumented `plan: {id, multiplier}` joins the plan name the band and the CLI already show; a `hiddenProviders` setting removes providers the user does not care about from shared views.

### Problem Frame

"Max" alone does not say whether the account is 5× or 20×, and that changes how a forecast reads. A provider that is installed but unused (on the owner's server `acp-opencode` answers "not signed in") takes a row in the band, can drive the sidebar sign and can send pushes, though nobody acts on it.

### Key Decisions

- **Hidden means hidden everywhere except the provider's own threads.** A hidden provider leaves the band's list of other providers, the sidebar sign and its card, push notifications and `headroom`. In a thread that runs on that provider its limits show as before. Polling and history continue, so un-hiding loses nothing. `status` still lists it, marked hidden. (session-settled: owner chose «Везде, кроме своего треда» on 2026-11-16.)
- **The multiplier is shown only when the host reports it; nothing is guessed from the plan name.** (session-settled: task text of UF-11, «при отсутствии ничего не показывать».)
- **One list for all hosts.** A provider id hidden in the setting is hidden on every host. (session-settled: follows the owner's UF-5 answer that hosts are an owner-specific case; other users have one host.)

### Requirements

- R1. When the host's answer for a provider carries a plan multiplier that is a finite number greater than 1, every place that shows the plan name shows it with the multiplier: "Max 5×" (multiplication sign, no space before it; a fractional value keeps one decimal, "1.5×").
- R2. Nothing is added when there is no plan name, no multiplier, a multiplier of 1 or less, or a plan name that already contains a multiplier ("Max 20x", "Pro 5×").
- R3. The multiplier is kept with the provider's stored record like the plan name: a later failed poll keeps the last known value.
- R4. `status --json` gains `planMultiplier` (number or null) on each provider; the text of `status` shows "claude-code (Max 5×)".
- R5. A new plugin setting `hiddenProviders`: a text field holding provider ids separated by commas or spaces (`acp-opencode, codex`), empty by default. Ids are compared case-insensitively after trimming; an id that matches no known provider is ignored without an error.
- R6. In a thread, the band's list of other providers omits hidden providers. The thread's own provider is always shown, hidden or not.
- R7. The sidebar sign (UF-8) ignores hidden providers when it picks the worst window, and its card omits them. With every provider hidden the sign shows its empty state.
- R8. No limit push is sent for a hidden provider. Un-hiding does not send pushes for steps passed while it was hidden in the current window period; the next step sends as usual.
- R9. `headroom` (UF-10) leaves hidden providers out of its ranking and verdict. Its JSON output gains `hidden: string[]` with the ids left out; its text output ends with one line `hidden: <ids>` when the list is not empty. `headroom --thread <id>` for a thread on a hidden provider still reports that provider, as the band does.
- R10. `status` lists hidden providers with the mark `[hidden]` after the status; `status --json` gains `hidden: boolean` on each provider.
- R11. The expanded block of another provider in the band has a "Hide" text button. Pressing it adds the provider id to `hiddenProviders`; the row leaves the list at once and on other open devices at their next settings refresh. A hidden provider is brought back by editing the setting. If saving fails the row returns.
- R12. Polling, storage, forecasts and learned history do not depend on the setting.
- R13. Every new UI string is in `src/app/i18n.ts` in English and Russian. No account identifier is logged or stored; of the host's `plan` object only the multiplier is kept.

### Acceptance Examples

- AE1. Host reports `planLabel: "Max"`, `plan.multiplier: 5`: band header reads "Claude Code · Max 5×"; CLI reads "claude-code (Max 5×)"; JSON has `planMultiplier: 5`.
- AE2. Host reports `planLabel: "Plus"` and no `plan`, or `plan.multiplier: 1`: "Plus", `planMultiplier: null`.
- AE3. `hiddenProviders = "acp-opencode"`: a Claude Code thread's band lists Codex under other providers and not OpenCode; `status` prints "acp-opencode: not signed in [hidden]".
- AE4. `hiddenProviders = "codex"`, Codex weekly window is the worst of all: the sidebar sign shows the worst Claude Code window; a Codex thread's band still shows the Codex limits; no push when Codex passes the push threshold.
- AE5. `headroom --json` with Codex hidden: no Codex entry in the ranking, `hidden: ["codex"]`.
- AE6. Press "Hide" on the OpenCode block in a Claude Code thread: the block disappears; the settings page shows `acp-opencode` in the field.
- AE7. `hiddenProviders = " Codex ,, nope"`: Codex is hidden, `nope` is ignored, nothing fails.

### Scope Boundaries

- No per-host and no per-thread hiding.
- No hiding of single windows (for example only "Fable").
- No "show hidden" list or un-hide button in the band; the settings field is the way back.
- No change to polling: a hidden provider is still asked for.
- No display of the plan id, and no plan data taken from anywhere but `bb.sdk.system.usageLimits`.
- The built-in `bb--provider-usage` plugin is not touched.

### Dependencies / Assumptions

- The host's `plan: {id, multiplier}` was seen on bb 0.49.0 (`AGENTS.md`, Host facts) but its exact shape was not recorded: whether `multiplier` is a number, for which providers it is present, and whether `planLabel` already includes it. U1 records this before the display is built.
- Settings have no multi-select type (SDK 0.6.132: `string`, `boolean`, `number`, `select`, `project`), hence the text field.
- The server can write its own settings with `PluginSettingsHandle.experimental_set`; UF-9 checked that path live and recorded the result in `AGENTS.md`. R11 depends on it.
- UF-8 (`src/app/indicator.ts`, `src/app/sidebar-card.tsx`) and UF-10 (`src/shared/headroom.ts`, the `headroom` command) are merged.

### Sources

- UF-11 in BB Tasks; `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`.
- `src/server/poller.ts` (`providerInput`, `notOk`, the stored provider), `src/shared/contract.ts` (`planLabel`), `src/app/banner.tsx` (header line, `ProviderHeader`, `OtherProvider`), `src/server/cli.ts` (`formatStatus`), `src/server/limit-notifier.ts`, `server.ts` (settings declaration, `parseSettings`).

Product Contract preservation: the Product Contract above is the brainstorm's outcome and is unchanged by planning.

## Planning Contract

### Key Technical Decisions

- KTD1. **Parse leniently.** `providerInput` in `src/server/poller.ts` gains `plan: z.unknown().optional()`; a helper `planMultiplier(plan: unknown): number | null` returns the number only for an object whose `multiplier` is a finite number greater than 1 (a numeric string is parsed too if U1 shows the host sends one). An unexpected shape never fails the poll.
- KTD2. **Carry `planMultiplier: number | null` beside `planLabel`** in the stored provider and in the contract (`src/shared/contract.ts`), with the same keep-on-failure rule (`notOk`). Records written before this change have no such key: read it as null (zod `.nullable().default(null)` or the storage layer's existing way of reading old records).
- KTD3. **One formatter.** `src/shared/plan.ts` exports `planText(planLabel, planMultiplier): string | null` implementing R1 and R2; the band, the sidebar card and the CLI call it instead of reading `planLabel` directly. The "already contains a multiplier" test is `/\d\s*[x×]/i` on the label.
- KTD4. **One parser for the setting.** `src/shared/hidden-providers.ts` exports `parseHiddenProviders(raw: unknown): string[]` (split on commas and whitespace, trim, lower-case, de-duplicate) and `isHidden(hidden, providerId)`. Unknown ids need no check: they simply match nothing. `parseSettings` in `server.ts` returns `hiddenProviders: string[]`; the app reads the same raw value through `useSettings()` and the same parser.
- KTD5. **Filter where a shared view is built, not in the data.** The snapshot RPC keeps returning every provider (R12, and the thread's own provider must stay). Filters:
  - band: where the list of other providers is derived for a thread (`src/app/model.ts` or `banner.tsx`), after the own provider is taken out;
  - sidebar: the input of `indicatorView` and of the card;
  - push: for a hidden provider `LimitNotifier.check` runs its full per-window step logic and writes the sent record as usual (re-arming and deleting the record below the threshold included) and suppresses only the `send` call, so un-hiding sends nothing late (R8);
  - `headroom`: the provider list given to `providerHeadroom`, except the thread's own provider when `--thread` resolves to one.
- KTD6. **Hide button.** An RPC mutation `hideProvider({providerId})` reads the current setting, appends the id if absent and writes the joined list with `settingsHandle.experimental_set`; it returns the new list. The app keeps an optimistic set of ids hidden in this session (module store in `src/app/hooks.ts`, the pattern UF-9 introduced), cleared for an id when the mutation fails. The button is a plain `<button type="button">` inside the opened content of the other provider's `Disclosure`, never inside its summary button. If `AGENTS.md` records that `experimental_set` did not work on this host, leave R11 out, say so in the report and keep the rest.
- KTD7. **CLI.** `formatStatus` appends ` [hidden]`; the `--json` providers gain `hidden` and `planMultiplier`. Both are additive.
- KTD8. No version bump; the entry goes under "Unreleased" in `CHANGELOG.md`.

### Sequencing

U1 (host fact) first, then U2 and U3 in either order, then U4, then U5.

## Implementation Units

### U1. Record the shape of `plan`

- Goal: know what the host sends before building on it.
- Requirements: R1, R2 (their inputs).
- Dependencies: none.
- Files: `AGENTS.md` (Host facts).
- Approach: the plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). Build a throwaway plugin with its own id (`uf-plan-spike`) in a temporary directory outside the repository: one RPC query that calls `bb.sdk.system.usageLimits` the way the poller does and returns, per provider, only `providerId`, `planLabel`, and for `plan` the list of its keys with each value's type and, for `multiplier` and `id`, the value. It must not return or log `accountEmail`, `accountKey` or any other field. Install it from its path, call the query with `bb plugin rpc call uf-plan-spike …`, then `bb plugin remove uf-plan-spike`, delete its directory and confirm with `bb plugin list` that it is gone and `usage-forecast` is still `running`. Write the observed shape as a Host facts line.
- Test scenarios: none (observation only).
- Verification: the Host facts line exists. If no provider reports a `plan` at all, keep R1–R4 as written (the code shows nothing) and say so in the report.

### U2. Multiplier: parse, store, show

- Goal: R1–R4.
- Requirements: R1, R2, R3, R4, R13.
- Dependencies: U1.
- Files: `src/shared/plan.ts`, `src/server/poller.ts`, `src/shared/contract.ts`, `src/server/storage.ts` (only if old records need a read default), `src/app/banner.tsx`, `src/app/sidebar-card.tsx`, `src/server/cli.ts`, `test/plan.test.ts`, `test/poller.test.ts`, `test/cli.test.ts`, `test/banner.test.tsx`, `test/helpers.ts`, `test/app-fixtures.tsx`.
- Approach: KTD1, KTD2, KTD3.
- Test scenarios: `planText` for AE1, AE2, label null with a multiplier, multiplier 1, 0, negative, NaN, 1.5, label "Max 20x"; the poller keeps the multiplier through a failed poll and reads an old stored record without the key; `plan` of an unexpected shape (string, null, array, `multiplier: "abc"`) does not fail the poll; band header and `ProviderHeader` render "Max 5×"; `status` text and JSON per R4; the stored record and the logs contain no key of `plan` other than the multiplier.
- Verification: `npm run typecheck && npm test`.

### U3. The setting and the filters

- Goal: R5–R10, R12.
- Requirements: R5, R6, R7, R8, R9, R10, R12.
- Dependencies: none (U2 only shares files).
- Files: `src/shared/hidden-providers.ts`, `server.ts`, `src/server/settings.ts` or wherever `parseSettings` lives, `src/app/model.ts`, `src/app/banner.tsx`, `src/app/indicator.ts`, `src/app/sidebar-card.tsx`, `src/server/limit-notifier.ts`, `src/shared/headroom.ts`, `src/server/cli.ts`, `test/hidden-providers.test.ts`, `test/banner.test.tsx`, `test/indicator.test.ts`, `test/sidebar-card.test.tsx`, `test/limit-notifier.test.ts`, `test/headroom.test.ts`, `test/cli.test.ts`.
- Approach: KTD4, KTD5, KTD7. The settings entry: `type: "string"`, label "Hidden providers", description naming the format and that `bb usage-forecast status` prints the ids.
- Test scenarios: AE3, AE4, AE5, AE7; parser on empty, null, non-string, duplicates, mixed separators; the own provider of a thread stays when hidden; all providers hidden → band shows only the own provider, the sign its empty state, `headroom` an empty ranking with `hidden` filled and its existing "nothing to rank" wording; hidden provider passes the push threshold → no send, then un-hidden in the same period → no send for that step, the next step sends; `headroom --thread` on a hidden provider's thread reports it; the snapshot RPC output is the same with and without the setting.
- Verification: `npm run typecheck && npm test`.

### U4. Hide button

- Goal: R11.
- Requirements: R11, R13.
- Dependencies: U3.
- Files: `src/shared/contract.ts`, `src/server/rpc.ts`, `src/app/hooks.ts`, `src/app/banner.tsx`, `src/app/i18n.ts`, `test/plugin.test.ts`, `test/banner.test.tsx`.
- Approach: KTD6. Accessible label "Hide <provider name> here and in notifications" (both languages); visible text "Hide" / «Скрыть».
- Test scenarios: AE6 (text part); the mutation appends once and keeps the other ids; it rejects an empty id; pressing does not toggle the disclosure and the button is not a descendant of another button; a rejected mutation brings the block back; the thread's own provider block has no button.
- Verification: `npm run typecheck && npm test`.

### U5. Docs and the look on real data

- Goal: record and check.
- Requirements: all.
- Dependencies: U2, U3, U4.
- Files: `README.md`, `CHANGELOG.md` ("Unreleased"), `AGENTS.md` (Layout lines for the two new shared files), `skills/usage-forecast/SKILL.md` (`hidden`, `planMultiplier`, hidden providers are left out of `headroom`).
- Approach: `npm ci && npm run typecheck && npm test && npm run build`. The real plugin is not replaced (see U1). For a look on real data, save the output of `bb plugin rpc call usage-forecast snapshot` (use the input the contract on the branch requires) to a file under the thread's storage and feed it to the branch's `formatStatus` and `headroom` formatting in a throwaway script with `hiddenProviders = ["acp-opencode"]`; do not paste account identifiers into the report. The coordinating thread checks the band, the sign and a push after the release.
- Verification: the check command is green; `bb plugin list` shows `usage-forecast` still `running` from the marketplace source.

## Verification Contract

- `npm ci && npm run typecheck && npm test && npm run build` passes.
- Tests cover AE1–AE7.
- No account identifier in code, logs, the spike's output or the report. Vendored `components/`, `lib/`, `hooks/` unchanged.

## Definition of Done

- R1–R13 met, or R11 left out under the stop condition of KTD6 and reported.
- All commits local on the child's branch; nothing pushed, no PR, no tag.
- Final report: branch, worktree path, commits, check result, the observed `plan` shape, deviations.
