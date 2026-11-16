# Changelog

Every release is a `vX.Y.Z` tag on the merge commit. Versions before 0.3.0 were
developed under the name `usage-limits` in a private repository and are not
listed here.

## 0.4.19 — 2026-11-16

- Removed the «Sidebar ring and card» setting of 0.4.18: bb keeps the footer
  button anyway, so the switch only emptied it. The ring is hidden through
  More → Customize footer. «Band above the composer» stays.

## 0.4.18 — 2026-11-16

- Two settings, both on by default: «Band above the composer» and «Sidebar
  ring and card». Switched off, the band or the ring is not drawn and asks
  the server for nothing. bb keeps the ring's empty button in the footer.

## 0.4.17 — 2026-11-16

- `bb usage-forecast status` and `headroom` no longer list a shared account
  twice while one of its hosts is offline. The sidebar card and the CLI now
  group accounts with the same code (`accountGroups`).

## 0.4.16 — 2026-11-16

- The poller no longer stores a sample of every window on every poll
  (`limits:samples:*`): nothing read them. Samples stored by earlier versions
  are deleted when the plugin loads; forecasts and the learned pace use the
  closed windows, as before.
- Cleanup with no change in behaviour: unused vendored UI components and 13
  unused dev dependencies are gone, as are the plans of shipped features in
  `docs/plans/`.

## 0.4.15 — 2026-11-16

- Sidebar card: an account shared with a host that went offline was listed
  twice under the host still answering. The offline host keeps its link to
  the account while the answering one drops its own; the card now reads the
  link from either side.

## 0.4.14 — 2026-11-16

- Sidebar card: a reset shown as a time («Tue 10:00 AM») no longer wraps
  onto three lines; its column is wider in that mode and never wraps.

## 0.4.13 — 2026-11-16

- The sidebar card fits bb's footer popover: tighter lines, the run-out note
  on one line («runs out at 3:39 PM»), a provider's token sums as two numbers
  in its heading line («310k · 4.2M», today and month; the words are the
  tooltip), and the other hosts of a shared account in the name's tooltip.
  A card that still does not fit scrolls instead of being cut off.

## 0.4.12 — 2026-11-16

- The sidebar card shows one host at a time: with more than one host the
  hosts are tabs above the list, and the card opens on the host of the ring's
  worst window. An account shared by several hosts is listed in each of
  their tabs, and so are a provider's token sums.

## 0.4.11 — 2026-11-16

- The sidebar card is compact: a window is one line with a short label
  («5H», «W»; a label with no short form, such as «Fable», stays whole), the
  bar, the percent and the reset. The window's note moved into the line's
  tooltip; a window that runs out before its reset still shows it in the
  window's colour. The plan is a badge at the right of the provider's name,
  and providers are divided by a rule.

## 0.4.10 — 2026-11-16

- Token totals (UF-12). The server counts tokens from bb's
  `thread/tokenUsage/updated` events, per thread and per provider in hourly
  buckets kept for 40 days (`tokens:hours`, `tokens:threads`, each trimmed
  under 200 KB). It counts a thread when it goes idle, and once after the
  first start walks every thread, archived and hidden included, one at a
  time; a thread that fails is skipped and logged by error class only. The
  main number leaves cache reads out, the full `totalTokens` is in brackets
  or the tooltip. The expanded band shows «Tokens: thread 86k · today 310k ·
  month 4.2M» below the limit windows (no line without data), the sidebar
  card «today 310k · month 4.2M» per provider, and the new CLI command
  `bb usage-forecast tokens [--json]` the provider sums for the server's day
  and month and the ten latest threads. New RPC query `tokens`. Because bb
  keeps only a thread's newest token event and Claude Code restarts its
  count with each runtime run, the totals are approximate: the first
  collection books each thread's last total in the hour of its last turn, so
  a thread's lifetime total is a lower bound, while the day and month of the
  first collection also hold what such a thread spent earlier.

## 0.4.9 — 2026-11-16

- Plan multiplier (UF-11). When bb's usage limits carry a plan multiplier
  above 1 (`plan.multiplier`), the band header, the expanded provider
  headers, the sidebar card and the CLI `status` and `headroom` text show it
  after the plan name («Claude Code · Max 5×», `claude-code (Max 5×)`); a
  label that already names one is left as it is. The JSON of `status` and
  `headroom` gains `planMultiplier` (`null` without one). Only the number is
  stored, not the plan object. On bb 0.49.0 no provider sent a multiplier.
- Hidden providers (UF-11). A new setting «Hidden providers» (`hiddenProviders`,
  ids separated by commas or spaces, empty by default) leaves providers out of
  the band's other providers, the sidebar ring and card, limit pushes and
  `bb usage-forecast headroom`. A thread's own provider is always shown, and
  `headroom --thread` keeps it. A hidden provider's push steps are still
  tracked, so showing it again sends nothing late. Each other provider in the
  expanded band has a Hide button (new RPC method `hideProvider`) that adds it
  to the setting. `status` marks hidden providers `[hidden]` and its JSON
  gains `hidden` per provider; `headroom` JSON gains `hidden` (the ids left
  out) and its text a last line `hidden: <ids>`, and an empty ranking says
  «No providers to rank.». Polling, storage and the snapshot do not change.

## 0.4.8 — 2026-11-16

- Press to switch (UF-9). A press on a reset time in the band switches every
  row between the countdown («3d», «resets in 3d») and the local time of the
  reset («Thu 19:59», «resets at 19:59» today, «resets Thu 19:59»); a press on
  a window's percent switches every window between used and left. Both
  choices are plugin settings, the new «Reset shows» (countdown by default)
  and «Limits show», saved on the server through the new RPC method
  `setDisplay`, so a press on one device reaches the others. The band shows
  the press at once and returns to the previous form if the save fails. The
  run-out wording, the budget line, the context bar, push texts and the CLI
  are unchanged.
- CLI for agents (UF-10). `bb usage-forecast headroom` ranks provider
  accounts from the most headroom to the tightest, one line each with the
  tightest window: `headroom` (every window calm), `tight`, `short`,
  `critical`, `hit` (with when it is available again) or `unknown`. Options
  `--json`, `--refresh`, `--host <id or name>` and `--thread <threadId>`;
  data polled more than 30 minutes ago is marked stale, and so is one
  account measured that long ago (a host that is not connected). In
  `status --json` every window gains a `verdict` object (`state`, `lasts`,
  `runsOutAt`, `projectedPercent`, `paceDeviationPercent`, `resetsInMs`),
  computed at the moment of the call; the other fields and the text of
  `status` are unchanged. The agent skill says when to use them.
- Limits ring in the sidebar footer (UF-8). A ring next to bb's footer
  buttons shows the worst window across every host, filled to its used
  percent and coloured by its pace state; its tooltip names the window.
  Pressing it opens a card with every provider's windows, grouped by host
  when there are several, with a shared account listed once and hosts that
  cannot be read named at the bottom; a window whose reset has passed does
  not count. To hide it, use More → Customize footer in the sidebar.

## 0.4.7 — 2026-11-16

- Pace-based status and colour (UF-7). Each window with a current pace has
  a state: calm (projection below 85 %), tight (85–100 %), will not last
  (above 100 %), critical (runs out within a tenth of the window from now)
  or used up. Colour follows the state instead of the used percent: calm is
  normal, tight and will not last amber, critical and used up red, so 80 %
  on an even pace is no longer amber and 92 % that lasts is no longer red. A
  worse state applies at once, a calmer one after ten minutes of calmer
  polls (the worst of them). The headline adds «Tight. At this pace about N%
  will be used by …» and «At this pace you'll run out in 20m.»; a tight
  window's note starts with «Tight». Early windows and windows without a
  forecast keep the used-percent colours. `bb usage-forecast status` prints
  the state after the percent (`60% [will not last]`). The snapshot window
  gains `pace` (null for older stored values). Push notifications are
  unchanged.
- Worded forecast (UF-6). The current pace is now the main forecast; the
  usual pace from past windows speaks only in the first 5 % of a window, as
  «Too early to judge – usually ends at about N%», and such a window never
  warns. A window that runs out says the local time it runs out and how long
  before the reset («At this pace runs out Thu 4:00 AM – 8h before reset»),
  with a budget line that would last («to last: up to 13% a day»); one that
  lasts says «At this pace lasts to reset – about N% used». The warning flag,
  colour, tick, headline and the CLI's `[over 100%]` follow the main forecast
  only, so a high usual pace alone no longer warns. The tooltip marks the main
  pace. `bb usage-forecast status` prints the same facts (`at this pace runs
  out 2026-11-11 04:00 UTC (8h before reset), budget 13%/day`; `usual pace`
  replaces `learned pace`). The window forecast gains `main` and `early`
  (defaults for older stored values).

## 0.4.6 — 2026-11-16

- Limits per bb host (UF-5). Every connected host is polled with
  `usageLimits({hostId})` in parallel, with a 30 s timeout and back-off per
  host; a removed or destroyed host is dropped with its keys. A thread's band
  shows only the limits of the host it runs on (thread → environment → host),
  marks them stale with their time when that host is disconnected or its poll
  failed, and says the host is unknown rather than show another host. The
  CLI status and the limit pushes go once per account: hosts that bb reports
  on the same account for a provider are grouped (`sharedWith`, host ids
  only), and push titles name the hosts when more than one is known. Data
  stored before keeps its keys and belongs to bb's primary host
  (`limits:hosts` records it); other hosts get keys with their host id. The
  RPC snapshot carries `hosts` instead of a top-level `providers`, and the
  thread state gains `hostId`. Remembered pushes go from 50 to 200.

## 0.4.5 — 2026-11-15

- Summary and clear for providers that cannot compact (UF-4). New setting
  «Summarise and clear when a provider cannot compact», off by default. When
  it is on, Compact and auto-compact on a provider whose compact fails as
  unsupported (custom ACP agents such as Hermes) ask the agent for a summary
  that starts with `[context-summary]`, wait for that turn (at most 10
  minutes), clear the context with `threads.clearContext` and send the summary
  back as the next message. Nothing is cleared without a summary, after a
  failed turn or once the user started a new turn. The Compact button stays
  visible for such threads, and log entries carry `method: "summary"`
  («summary and clear»). The thread state gains `summaryClear`.

## 0.4.4 — 2026-11-15

- Push notifications before a limit runs out (UF-2): after each poll the
  server sends one push through bb's `push-notifications` plugin when a limit
  window reaches the threshold (90 % by default, 50–100), and one more at
  100 %. New settings «Limit push notifications» (on by default) and «Limit
  push threshold, %». Sent pushes are kept in KV (`notify:sent`), so a
  restart does not repeat them.
- The UI string tables in `src/app/i18n.ts` no longer import the app SDK;
  `useStrings` moved to `src/app/hooks.ts`, so the server reads the push texts
  from the same tables.

## 0.4.3 — 2026-11-12

- The «Thread limit, k tokens» field in the context card is 144 px wide instead
  of 80, so its «as in settings» placeholder fits (#7).
- README screenshots refreshed for this version (#8).

## 0.4.2 — 2026-11-12

- The threshold field is gone from the composer band: it silently created a
  per-thread override and switched auto-compact on for that thread. The band
  keeps the thread's auto-compact switch, labelled with the point where it will
  fire («Auto compact at 76%»), and the Compact button. The threshold changes
  in the plugin settings or, for one thread, in the context card (#6).
- README, `PLUGIN_OVERVIEW.md` and the skill explain large context windows:
  without a provider limit of its own the threshold comes very late.
- No contract change; `^0.4.0` covers this release.

## 0.4.1 — 2026-11-12

- The working context limit follows the provider. Order: the thread's limit →
  the provider setting (`claudeCodeContextLimitTokens`,
  `codexContextLimitTokens`, 0 = auto) → the point where the provider compacts
  on its own, as bb reports it (Claude Code: the window minus 33 000; Codex
  reports none) → the general `contextLimitTokens` (#5).
- No contract change; `^0.4.0` covers this release.

## 0.4.0 — 2026-11-11

- The context bar, its percentage and the auto-compact threshold are measured
  against a working limit in tokens (default 150 000, setting «Context limit,
  tokens», 10 000–2 000 000) that caps the model window (#3).
- A thread can have its own limit: the «Thread limit, k tokens» field in the
  context card or `bb usage-forecast override <id> <mode> --limit <tokens>`;
  0 returns to the settings.
- An estimated fill is marked `~`; the collapsed band shows «used / limit»; the
  threshold is also reported in tokens.
- **Contract change.** The RPC contract changed, so the marketplace entry moved
  to `^0.4.0` (get-bb/marketplace#928). A host installed from the `^0.3.0`
  source does not pick this version up: run `bb plugin install usage-forecast`
  again.
- Docs brought in line with the release (#4).

## 0.3.1 — 2026-11-11

- The server subscribes to thread events and refreshes the context in the band
  right after a turn or a compaction, at most once per 2 s per thread; polling
  an active thread is a 30 s fallback (#2). The approach follows
  [Hazihell/bb-plugin-context-meter](https://github.com/Hazihell/bb-plugin-context-meter).

## 0.3.0 — 2026-11-09

- First public release under the name Usage Forecast (id `usage-forecast`):
  CLI `bb usage-forecast`, settings at `/settings/plugins/usage-forecast`.
  Accepted into the BB Community marketplace (get-bb/marketplace#904).
- README screenshots of the band (#1).
