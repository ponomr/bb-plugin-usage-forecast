---
title: Sidebar-footer limits indicator (UF-8)
status: draft
date: 2026-11-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
tags: [usage-forecast, UF-8]
---

# Sidebar-footer limits indicator (UF-8)

## Goal Capsule

Show the state of the tightest usage limit in the app's sidebar footer at all times, outside any thread: a small ring filled by the used percent and coloured by the pace state. Pressing it opens a card with every window of every connected host. The owner can turn the indicator off.

Depends on UF-5 (per-host records, `snapshot.hosts`, `sharedWith`), UF-6 (worded forecast in the rows) and UF-7 (`src/shared/pace.ts`, held `window.pace`, `raw` / `shown` in the view). The work starts from a `main` that already contains UF-5, UF-6 and UF-7.

## Product Contract

### Summary

A footer item registered through the SDK's sidebar-footer region. Its icon is a ring drawn by the plugin; the item is a disclosure, so the host opens a plugin-rendered card above the footer row.

### Problem Frame

The limits band lives in the composer of a thread. On the thread list, in settings or in a plugin panel nothing tells the owner that a limit is about to run out. Competing tools keep a permanent sign in a status bar.

### Key Decisions

- **Sign is a live ring icon.** Fill = used percent of the worst window, colour = that window's shown pace state. Percent, time to reset and all windows are in the card, not in the footer. (session-settled: owner chose «Живая иконка-кольцо» on 2026-11-16.)
- **Worst window across all hosts.** The indicator ranks every window of every connected host and provider; the card groups windows by host and shows a shared account once. (session-settled: owner chose «По всем хостам» on 2026-11-16.)
- **Standard SDK places first.** `app.experimental_sidebarFooter` and `app.experimental_icons`; an app overlay or a page script only when the standard places cannot show a live sign. (session-settled: task text of UF-8.)
- **Can be turned off in settings.** (session-settled: task text of UF-8.)

### Requirements

- R1. The sidebar footer shows one item of this plugin with a ring icon.
- R2. The ring's fill is the used percent of the worst window. The worst window is chosen by shown pace state (`hit` > `critical` > `short` > `tight` > `calm`), then by higher used percent, then by the nearer reset. A window with no pace state (early in the window or without a forecast) ranks as `calm`.
- R3. The ring's colour follows the UF-7 tone of the worst window's shown state: normal for calm, amber for tight and short, red for critical and hit. A window with no pace state takes the UF-7 threshold tone of its used percent (`limitTone`), so a 90 % window without a forecast outranks a calm 40 % one and is not drawn calm.
- R4. All windows of all hosts present in the snapshot take part; a window of a shared account (UF-5 `sharedWith`) is counted once.
- R5. With no data (no snapshot yet, every provider failing or not installed) the ring is an empty neutral ring; it never shows a stale colour as fresh.
- R6. Pressing the item opens a card above the footer: windows grouped by host, then provider; each row has the label, the percent as the `limitsShow` setting says, the bar, the time to reset and the UF-6 worded forecast. With one host the host heading is omitted. A shared account appears once, under the first host of its group, with the other hosts' names next to the heading.
- R7. The card's rows reuse the band's row view and wording, so a window reads the same in the band and in the card.
- R8. The item's accessible label is "Usage limits" in the UI language. Where the host lets the plugin's icon carry its own title, the title names the worst window, its percent and state; where the host's tooltip wins, the static label is enough and the detail is in the card.
- R9. A plugin setting turns the indicator off; it is on by default. When off, no item of this plugin is visible in the footer.
- R10. The indicator updates without a page reload: on the snapshot refetch interval and on the `limits` invalidation the band already uses.
- R11. Every new string is in `src/app/i18n.ts` in English and Russian.
- R12. The indicator works on the Mac; on the phone it works wherever the host shows the sidebar footer, and what was seen there is recorded.

### Acceptance Examples

- AE1. Clovis: Codex weekly 60 % `short`; Mac: Claude Code session 92 % `critical`. Ring is red, filled to 92 %. Title, where the host shows it: "Sky Blue M4 · Claude Code · Current session: 92%, critical".
- AE2. Every window calm, highest 34 %. Ring has the normal colour, filled to 34 %.
- AE3. Two windows `short`, 60 % and 71 %. The 71 % window is the worst.
- AE4. Claude Code is one account on both hosts (`sharedWith`). The card shows its windows once under the first host, heading "Claude Code · also Sky Blue M4".
- AE5. Snapshot has no host with an `ok` provider. Ring is empty and neutral; the card says there is no limits data and offers nothing else.
- AE6. The setting is off. The footer has no item of this plugin.
- AE7. A window turns `critical` between two polls (the render-time `rawPaceState` of UF-7). The ring turns red on the next minute tick of `useNow`, without a new snapshot.

### Scope Boundaries

- No percent text, countdown or badge in the footer itself.
- No choice of which window the ring follows, no per-host or per-provider filter.
- No new push notifications and no change to the band, the context card or the CLI.
- No change to polling or storage.
- Non-goal: hiding providers (UF-11).

### Dependencies / Assumptions

- UF-5 merged: `snapshot.hosts[]` with host name, per-provider records and `sharedWith`.
- UF-6 merged: the worded forecast and `windowNote` that the card rows reuse (R6, R7).
- UF-7 merged: `PaceState`, `paceStateTone`, the view's `shown` state.
- Unverified: whether a registered icon component may use hooks and re-render with live data; whether the host lets a plugin hide or skip its footer item at run time. Both are settled by U1.

### Sources

- UF-8 in BB Tasks; report item on a permanent indicator in `~/ai-hub/outputs/2026-11-15-usage-forecast-competitors/report.md`.
- `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts`: `ExperimentalSidebarFooter`, `ExperimentalSidebarFooterDisclosureRegistration`, `ExperimentalIconRegistration`, `experimental_appOverlay`.

Product Contract preservation: the Product Contract above is the brainstorm's outcome and is unchanged by planning.

## Planning Contract

### Key Technical Decisions

- KTD1. **Registration.** `app.experimental_icons.register({name: "usage-forecast/ring", component: RingIcon})` and `app.experimental_sidebarFooter.register({kind: "disclosure", id: "limits", label: "Usage limits", icon: "usage-forecast/ring", component: LimitsCard})` in `app.tsx`.
- KTD2. **Live icon, in order of preference**, decided by the spike in U1:
  1. `RingIcon` uses the app hooks (`useSnapshot`, `useNow`, `useSettings`) directly.
  2. If hooks fail inside an icon component: a module-level store (`src/app/indicator-store.ts`, `useSyncExternalStore`) that a hook-capable mounted component feeds (the disclosure card is mounted only when open, so the feeder is an `experimental_appOverlay` component that renders `null`), and `RingIcon` subscribes to it.
  3. If the icon cannot re-render at all: the whole sign moves to an `experimental_appOverlay` component placed by the plugin. This is fragile; stop and report before building it.
- KTD3. **Pure model.** `src/app/indicator.ts`: `indicatorView(snapshot, now, show)` returns `{worst: {hostName, providerName, label, usedPercent, state, tone} | null, groups: [...]}`. It dedupes shared accounts, builds each window's view through the existing `windowView` of `src/app/model.ts`, and ranks with one exported comparator `compareWorst`. No React in this file.
- KTD4. **Ring drawing.** One inline SVG: a track circle and an arc with `stroke-dasharray` for the fill, `viewBox="0 0 16 16"`, honours `className`, track uses `currentColor` with low opacity. Calm arc uses `currentColor`; amber and red use the same colour tokens or classes the band's bar uses for its tones (read them from `src/app/ui.tsx` / `banner.tsx`; do not invent new colours). The fill is the used percent regardless of `limitsShow`; the card's numbers follow `limitsShow`.
- KTD5. **Turning off**, in order of preference, decided in U1:
  1. If setup can skip the registration from a setting or the host already lets the user hide a plugin's footer item, use that and say so in the setting's description or in the README.
  2. Otherwise a boolean plugin setting `sidebarIndicator` (default `true`) declared in `server.ts`; `RingIcon` and the card read it. If an item cannot be removed at run time and an invisible but focusable button would remain, stop and report: R9 is not met by an empty icon.
- KTD6. **Card.** `src/app/sidebar-card.tsx` renders the groups with the band's existing row component. If that component is private to `banner.tsx`, export it; do not copy it. The card has a fixed max height with scroll and closes through the host (`dismiss` is used only for an explicit close control if the host draws none).
- KTD7. **No server change** beyond the setting declaration. No contract change. Version is not bumped; the entry goes under "Unreleased" in `CHANGELOG.md`.

### Sequencing

U1 (spike) decides KTD2 and KTD5 and may stop the work. U2 is independent of U1's outcome. U3 and U4 follow U1 and U2. U5 last.

## Implementation Units

### U1. Spike: live icon and turning off

- Goal: learn what the host allows before building.
- Requirements: R1, R9, R10, R12.
- Dependencies: none.
- Files: `AGENTS.md` (Host facts entry). The spike itself is a throwaway plugin outside the repository and is not committed.
- Approach: The plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). Build a separate throwaway plugin with its own id (`uf-footer-spike`) in a temporary directory outside the repository: a server with one boolean setting and one trivial RPC query, and an app that registers an icon and a disclosure with a trivial card. The icon component uses a minute timer, `useSettings()` and `experimental_useRpcQuery` against the spike's own RPC, and draws from all three (minute as the arc, a colour that depends on whether the settings and the query loaded). KTD2 branch 1 is confirmed only if all three work inside the footer icon. Install the spike from its path, open the app in a browser session (browser-automation skill) and check: the icon renders in the footer; it re-renders on the tick; hooks do not throw (`bb plugin logs uf-footer-spike`, browser console); the card opens above the footer; what the footer looks like at a phone-width viewport; whether the host offers hiding a footer item; whether `definePluginApp` setup has any way to read a setting. At the end run `bb plugin remove uf-footer-spike`, delete its directory and confirm with `bb plugin list` that it is gone and `usage-forecast` is still `running`.
- Test scenarios: none automated; this unit produces facts.
- Verification: a short "Host facts" entry in `AGENTS.md` (sidebar footer: icon liveness, phone, hiding) and the chosen branch of KTD2 and KTD5 named in the commit message. Stop and report if KTD2 falls to branch 3 or KTD5 cannot meet R9.

### U2. Indicator model

- Goal: the pure choice of the worst window and the card's groups.
- Requirements: R2, R3, R4, R5, R6 (grouping), R8 (text parts).
- Dependencies: UF-5 and UF-7 code on the branch.
- Files: `src/app/indicator.ts`, `test/indicator.test.ts` (Vitest runs only `test/**/*.test.{ts,tsx}`; shared fixtures are in `test/app-fixtures.tsx`).
- Approach: KTD3. Hosts in the snapshot's order (primary first, as UF-5 returns them). A provider record that is not `ok` contributes no windows. A shared group is placed under its first host; the other member host names go to `alsoOn`.
- Test scenarios: AE1 (worst across hosts), AE2, AE3 (tie on state, higher percent wins), a window with no pace state at 90 % against a calm 40 % one (the 90 % wins and takes the `limitTone` colour), tie on state and percent (nearer reset wins), AE4 (shared once, `alsoOn`), AE5 (null worst, empty groups), one host (no host heading flag), a window whose raw state at `now` is worse than the held state (AE7), a provider in error next to an `ok` one.
- Verification: `npm test` green for the new file.

### U3. Ring icon and registration

- Goal: the footer item.
- Requirements: R1, R2, R3, R5, R8, R9, R10, R11.
- Dependencies: U1, U2.
- Files: `app.tsx`, `src/app/ring-icon.tsx`, `test/ring-icon.test.tsx`, `src/app/i18n.ts`, `server.ts` (setting, if KTD5 branch 2), `src/app/indicator-store.ts` (only if KTD2 branch 2).
- Approach: KTD1, KTD2, KTD4, KTD5. The label passed at registration is static ("Usage limits"); the live title of R8 is an SVG `<title>` on the ring. If the host's own tooltip always wins, keep the static label and say so in the report; R8 allows it.
- Test scenarios (jsdom, `cleanup()` in `afterEach`): arc length for 0, 34 and 100 %; over 100 % clamps to a full ring; tone class for calm, short, critical; empty neutral ring with no data; `className` is passed to the root; English and Russian title text.
- Verification: `npm run typecheck && npm test`.

### U4. Card

- Goal: the disclosure content.
- Requirements: R6, R7, R11.
- Dependencies: U2, U3.
- Files: `src/app/sidebar-card.tsx`, `test/sidebar-card.test.tsx`, `src/app/banner.tsx` (export of the row component only), `src/app/i18n.ts`.
- Approach: KTD6. Loading state while the snapshot is undefined; the no-data state of AE5; host headings only with more than one host.
- Test scenarios: two hosts with headings; one host without a heading; shared account heading with "also …"; no-data text; a row shows the same note text as `windowNote` gives for the band.
- Verification: `npm run typecheck && npm test`.

### U5. Docs and live look

- Goal: record and check.
- Requirements: R12 and all AEs that can be seen live.
- Dependencies: U3, U4.
- Files: `README.md`, `CHANGELOG.md` ("Unreleased"), `AGENTS.md` (Layout line for the new files; phone and desktop observations added to the U1 Host facts entry).
- Approach: `npm ci && npm run typecheck && npm test && npm run build`. The plugin on the owner's server is installed from the marketplace and must not be replaced: never run `bb plugin remove`, `bb plugin disable` or `bb plugin install` for `usage-forecast` (removing it deletes the owner's settings). The real plugin is therefore not looked at live in this task: feed the real snapshot from `bb plugin rpc call usage-forecast snapshot` to `indicatorView` and to a jsdom render of the ring and the card in a test or script, and quote what they show. The coordinating thread looks at the footer on the Mac and the phone after the release. The report carries no account e-mail.
- Test scenarios: none new.
- Verification: the check command is green; `bb plugin list` shows `usage-forecast` still `running` from the marketplace source; the report says what the real snapshot rendered to and which AEs were seen only in tests.

## Verification Contract

- `npm ci && npm run typecheck && npm test && npm run build` passes.
- Unit tests cover AE1–AE5 and AE7 in `test/indicator.test.ts`; AE6 is checked in the U1 spike (a hidden item) and by a render test of the off state.
- Live in this task: the spike of U1 (footer item, icon liveness, card, phone width, hiding). The real ring and card are checked by the coordinating thread after the release.
- No account identifier appears in code, logs, screenshots or the report. Vendored `components/`, `lib/`, `hooks/` are unchanged.

## Definition of Done

- R1–R12 met, or a stop condition reported with the facts from U1.
- All commits are local on the child's branch; nothing pushed, no PR, no tag.
- Final report: branch, worktree path, commits, check output summary, which branch of KTD2 and KTD5 was taken, live observations, deviations from the plan.
