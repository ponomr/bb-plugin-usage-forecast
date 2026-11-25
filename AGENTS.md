# bb-plugin-usage-forecast — Standalone Context

BB plugin that shows every provider's usage limits with a forecast to the
window reset, the thread's context-window fill, a Compact button and an
optional auto-compact. A server part polls limits on a schedule and runs
auto-compact without open clients.

## Layout

- `server.ts` — wires storage, schedule, events, RPC contract and CLI.
- `src/shared/` — RPC contract, window table, thresholds, the forecast
  (`forecast.ts`, adapted from `claude-code-usage-quota-mod`, see `NOTICE`)
  and the window's pace state with its hold (`pace.ts`), the display
  settings (`limits-show.ts`, `reset-show.ts`), account grouping across hosts
  (`accounts.ts`: `accountGroups` is the one grouping for the sidebar card
  and the CLI; a `sharedWith` link counts from either side), the CLI's window verdict and provider headroom
  (`headroom.ts`), the plan multiplier and its text (`plan.ts`) and the
  `hiddenProviders` setting's parser (`hidden-providers.ts`), and the token
  totals' pure core: counting, trims, sums and number format (`tokens.ts`).
- `src/server/` — poller, KV storage, auto-compact, limit push notifications
  (through the `push-notifications` plugin), the token counter with its first
  collection (`token-counter.ts`), CLI.
- `src/app/` — composer band (design after `claude-code-usage-quota-mod`),
  context card section, settings section, the sidebar-footer ring
  (`indicator.ts` model, `ring-icon.tsx`, `indicator-store.ts` with its
  overlay feeder, the `store.ts` helper behind the module stores,
  `sidebar-card.tsx`), the page-header limits (`header-model.ts` model,
  `header-widget.tsx` with its popover card), the floating widget
  (`float-widget.tsx`), the cards' refresh and
  settings row (`card-actions.tsx`); UI strings in `i18n.ts`.
- `components/`, `lib/` — vendored BB UI components (only the ones `src/`
  imports); import them by relative path and keep them unchanged.

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
   setting. Every UI string, push texts included, lives in `src/app/i18n.ts`
   in both languages; that file imports nothing from the app SDK so the
   server can use it. Code, comments and docs are English.

## Commands

- Check: `npm ci && npm run typecheck && npm test && npm run build`.
- Live test from the checkout: `npm run build && bb plugin install "$PWD" --yes`,
  then `bb plugin logs usage-forecast` and `bb plugin list`.
- RPC from the shell: `bb plugin rpc call usage-forecast <method> --input-file
  <json> --json`.
- App tests need `// @vitest-environment jsdom` and `cleanup()` in `afterEach`
  (Vitest runs without globals).
- `bb plugin build` failing with `Cannot find module 'npm/package.json'` means
  the bb install has no bundled npm (seen on bb 0.49.0, macOS). Fix:
  `npm install -g --prefix ~/.bb/npm npm@11.16.0`; repeat it if a bb update
  removes the package.

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
- `plan` (checked 2026-11-16 with a throwaway plugin, `refresh: true`, one
  connected host): `claude-code` `planLabel: "Max"` with `plan: {id: "max",
  multiplier: null}`, `codex` `planLabel: "Plus"` with `{id: "plus",
  multiplier: null}`; an `unauthenticated` provider (`acp-opencode`) has no
  `plan`. No provider sent a non-null multiplier, so its type when present is
  unseen; `planLabel` carried no multiplier. The plugin reads only a finite
  number above 1.

Hosts (checked 2026-11-16 from the bb CLI on the server, a two-host install):

- `usageLimits` without `hostId` answers for one host only. Since 0.4.6 the
  plugin polls each host of `hosts.list` with `status: connected` and
  `lifecycle.phase: active` by `hostId`; data stored before belongs to the
  host in `system.config().primaryHostId` (`bb settings show` shows it), kept
  as `legacyOwner` in `limits:hosts`.
- A Mac that was offline listed as `status: disconnected` with
  `lifecycle.phase: active`. Usage for it (`bb settings usage --machine`)
  did not fail: every provider answered `status: error`, «Provider usage
  could not be loaded.». The plugin therefore does not poll disconnected
  hosts.
- A thread's host: `threads.get` has `environmentId`, the environment
  (`environments.get`) has `hostId` (`bb thread show`, `bb environment show`).

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
- A server-side settings write (`settingsHandle.experimental_set`, checked
  2026-11-16 with a throwaway plugin) fires `onChange` and then the realtime
  event `system:changed` with `changes: ["plugins-changed"]` within a few ms.
  In the bb 0.49.0 web client that event invalidates the `plugin-settings`
  query behind `useSettings()` (read in the bundle, not watched in a browser:
  the headless browser could not start on the server), so open pages follow
  without a reload.

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
  failure. For a provider without manual compaction the host answers 409
  `Provider "<id>" does not support manual context compaction`. Custom ACP
  agents (the Hermes `kaya`, `hera`, `porfyry`) have no
  `supportsManualCompaction` and get it; OpenCode and Grok ACP can compact.
  An ACP thread's `threads.context` has `usedTokens` and
  `modelContextWindow` only (200 000 for OpenCode, 500 000 for Hermes).
- `threads.clearContext({threadId})` (checked 2026-11-15 on an OpenCode
  thread) needs an idle or errored thread with no pending interaction, else
  409. It stops the provider runtime and writes a `system/operation` event
  `context_clear`; the history stays visible. Until the next turn
  `threads.context` returns `usage: null`. After it the agent did not know
  a code word from before the clear, and knew it again once a message with
  the summary was sent.
- Summary and clear on Hermes Porfyry (`acp-porfyry`, 2026-11-15, a dev copy
  of 0.4.5): the manual compact (the compact failed as unsupported, then the
  fallback) and auto-compact on `thread.idle` each took about 30 s from the
  request to the logged after-fill. The agent kept the facts from before the
  clear. A Hermes thread starts at about 18 600 tokens, so on an almost empty
  thread the fill after is a little higher than before.
- `threads.send` needs `mentions: []` on every text item;
  `threads.output({threadId})` returns `{output}`, the last answer's text.

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

Token usage (checked 2026-11-16 with a throwaway plugin over 105 threads):

- `threads.list` without `archived` returns active and archived threads but
  no hidden ones; `archived: true` returns only archived ones;
  `includeHidden: true` returns all of them (as `bb thread list
  --include-archived --include-hidden`). `limit` (1000 accepted) and
  `offset` pages do not overlap.
- `threads.events.list` with `types: ["thread/tokenUsage/updated"]` filters
  as asked. `limit` is a string and at most `"100"` (more answers HTTP 400
  «Thread event limit cannot exceed 100»); there is no cursor, the next page
  is `afterSeq: String(<last seq>)`. `order: "desc", limit: "1"` gives the
  newest event.
- The host keeps only the newest `thread/tokenUsage/updated` event of a
  thread: every one of the 105 threads, idle or archived, had at most one.
  It is written at the end of a turn; a thread in its first turn has none.
  Threads of Hermes ACP agents (`acp-kaya`, `acp-hera`, `acp-porfyry`,
  `acp-opencode`) have none.
- The event's `scope.turnId` looks like `<run>-t<n>`. Claude Code's
  `tokenUsage.total` counts one provider runtime run, not the thread: when the
  thread's last turn is the first of a new run, `total` equals `last` (35 of
  37 such threads), so `total` drops on a restart. Codex's `total` kept
  growing across runs. Claude Code's `inputTokens` excludes cached tokens;
  Codex's includes them. Both report `cacheReadInputTokens`.

UI surfaces:

- The composer banner (`app.composer.customize`, scope `thread`) and the
  thread context segment both render an interactive button on the Mac and on
  the phone, and RPC calls work from both. Realtime signals reached the Mac;
  on the phone no thread event fired while it was open, so that is unchecked.
- `experimental_useThreadContextKind()` is `card` on the Mac and `banner` on
  the phone.

Sidebar footer (checked 2026-11-16 with a throwaway plugin in headless
Chrome against the web app, bb 0.49.0):

- An `experimental_icons` component used as a footer item's icon renders
  outside the plugin slot: `useSettings()` throws «plugin SDK hooks can only
  be used inside a plugin slot component» and `experimental_useRpcQuery`
  throws «plugin RPC hooks outside a plugin slot component need an explicit
  pluginId». React state, effects and `useSyncExternalStore` work, and the
  icon re-renders. The plugin therefore feeds a module store from an
  `experimental_appOverlay` component that renders `null`; a settings change
  reached the icon within seconds.
- `definePluginApp` setup is synchronous and has no settings API; a
  registration cannot depend on a setting. A registered footer item cannot
  be removed at run time: with its icon hidden the host's 32×32 button stays
  focusable.
- The host wraps the icon in a 16 px `inline-flex size-4` span inside a
  28×28 button with `overflow-hidden` and no padding (checked 2026-11-24, bb
  0.50.1). The icon draws at 26 px by negative margins when its button is
  that large. The plugin's scoped CSS does not reach it either, so its tone
  colours are inline styles.
- The host lets the user take any footer item out of the row: More →
  Customize footer → «Remove <label> from footer» moves it into the More menu
  (UI preference `sidebar.hiddenFooterItems`, key
  `plugin:<pluginId>/<itemId>`). More also offers «Hide footer».
- A disclosure item's card opens directly above the footer row and closes on
  a second press of the item.
- At a phone-width viewport (390 px) the footer sits at the bottom of the
  sidebar drawer with the live icon. The native phone app is unchecked.

Page header (checked 2026-11-24 with Playwright in headless Chrome against
the web app, bb 0.50.1):

- bb has no header slot. The visible header row is
  `[data-testid=app-page-header-content-row]`; its last child holds the
  header's own buttons. The Downshift plugin moves an element of its own
  (`bb-downshift-host`) into that row from an app overlay; this plugin does
  the same, inserting before the last child. A page without that row (home)
  uses the fixed dock `[data-bb-header-addons]` that plugins share.
- The plugin's CSS is scoped to `[data-bb-plugin=usage-forecast]`, so an
  element created outside a slot (the header host, the popover portaled to
  `body`) needs `data-bb-plugin="usage-forecast"` and `data-bb-plugin-root`.
- The SDK has no navigation and no current-thread hook. The thread comes
  from the path (`/threads/<id>`, also under `/projects/<p>/threads/<id>`);
  the plugin's settings page is `/settings/plugins/<pluginId>`, reached by
  `history.pushState` plus a `popstate` event, which the router followed.
- At 390 px the header row leaves the plugin about 100 px next to Downshift:
  one line «5H 4h 41m 97%  W 61%» (173 px) pushed bb's own buttons out, so
  below 40rem the pill stacks the windows in two lines at 11 px (99 px).

## Repository and release contract

- Repository: public `ponomr/bb-plugin-usage-forecast`, MIT. Submitted to the
  BB Community marketplace as `usage-forecast` with a Git source that tracks
  `^0.4.0` (get-bb/marketplace#928); a compatible release needs no new
  marketplace PR, a contract change needs a PR that moves the range. The
  marketplace's long description (`overview/usage-forecast.md` there) is a
  copy of `PLUGIN_OVERVIEW.md`, at most 4000 characters; after changing it,
  open a marketplace PR with the new copy (get-bb/marketplace#973 for
  0.4.19). Its screenshots are copies of `docs/screenshots/` (taken on
  0.4.20: band with the sidebar ring, expanded band, sidebar card, context
  card, settings).
- Checks: the command above; GitHub Actions (`.github/workflows/ci.yml`) runs
  it on every PR and on `main`, with the bb CLI from npm (`bb-app`).
- Release: bump `version` in `package.json` and `package-lock.json` and add
  the version to `CHANGELOG.md` in the PR, merge it, tag the merge commit `vX.Y.Z` and push the tag.
- Install from a checkout: check out the tag and run
  `npm ci && npm run build && bb plugin install "$PWD" --yes`;
  `bb plugin list` must show the new version as `running`.
- Recovery: check out the previous tag and reinstall, or run
  `bb plugin disable usage-forecast`. Data stays in the plugin's KV storage.
