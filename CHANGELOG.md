# Changelog

Every release is a `vX.Y.Z` tag on the merge commit. Versions before 0.3.0 were
developed under the name `usage-limits` in a private repository and are not
listed here.

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
