---
name: usage-forecast
description: Read provider usage limits and their reset forecasts, check a thread's context fill, compact a thread, or set per-thread auto-compact with the Usage Forecast plugin's `bb usage-forecast` CLI. Use when asked how much of a Claude Code or Codex limit is left, when a window resets, whether a thread needs compacting, or why auto-compact did or did not run.
---

# Usage Forecast

The plugin polls `system.usageLimits` on the bb server and keeps a history of
each limit window, so forecasts work while no client is open. A window is
identified by provider and label (`claude-code` / `Current session`).

## Commands

- `bb usage-forecast status [--refresh] [--json]` — every provider and window:
  percent used, time to reset, forecast at reset from the current pace and,
  after enough history, from past windows (`learned pace N% (K windows)`). `[over 100%]` means
  the window runs out before it resets. `--refresh` polls now.
- `bb usage-forecast thread <threadId> [--json]` — context fill (tokens and % of the working limit), the limit and its source
  (this thread, the provider setting, where the provider compacts on its own, the global setting, or the model window),
  whether the agent is answering, the effective auto-compact policy and its
  source (settings or this thread), the cooldown.
- `bb usage-forecast compact <threadId>` — compact now. It queues a `/compact`
  turn, so it refuses while the thread is answering.
- `bb usage-forecast override <threadId> inherit|off|on [--threshold 50-95] [--limit <tokens>]` —
  per-thread auto-compact. `inherit` follows the settings. `--limit` sets the
  thread's working context limit in tokens (10 000–2 000 000; `0` returns to
  the provider and global limits); without it the stored limit is kept.

The current thread id is in `bb status` or `$BB_THREAD_ID`.

## Settings

`bb plugin config usage-forecast` shows them; change them in Settings → Plugins →
Usage Forecast.

| Setting | Default | Range |
| --- | --- | --- |
| `contextLimitTokens` | 150 000 | 10 000–2 000 000 (global limit; used when no provider limit or reported compaction point applies) |
| `claudeCodeContextLimitTokens` | 0 (auto) | 0, 10 000–2 000 000 (auto: where Claude Code compacts on its own, as bb reports it) |
| `codexContextLimitTokens` | 0 (auto) | 0, 10 000–2 000 000 (bb reports no compaction point for Codex; auto uses the global limit) |
| `autoCompactEnabled` | `false` | — |
| `autoCompactThresholdPercent` | 80 | 50–95 |
| `pollIntervalMinutes` | 2 | 1–10 |
| `language` | `en` | `en`, `ru` (UI language) |
| `limitsShow` | `used` | `used`, `remaining` (band only; CLI output stays in percent used) |

The thread's working limit is, in order: the thread's own limit, the provider
setting, the point where the provider compacts on its own (Claude Code reports
it after a turn, e.g. 167 000 of a 200 000 window; the plugin reuses the last
reported value for the same window while a turn runs), the global limit. A
smaller model window caps it. The fill percent and the threshold are of this
limit.

Do not turn `autoCompactEnabled` on unless the user asks for it.

## How auto-compact decides

- It runs only on `thread.idle`, when the context is at or above the
  threshold, and never for an answering thread.
- When the limit lies above the point where the provider compacts on its own,
  the threshold is capped 2 % of the window below that point so the compact
  happens between turns. Codex reports no such point: keep its limit at or
  below its own auto-compact limit.
- After a compact, or a failed attempt, the thread waits 10 minutes.
- Every attempt is logged with the fill before and after; `status` shows the
  last five.
- After a failed poll the next one waits 5 minutes, after two failures in a row
  15 minutes; `bb plugin list` shows the last error on the `poll-limits`
  schedule.

## Troubleshooting

- No numbers for a provider: `status` shows `not installed`, `not signed in`,
  `session expired` or the error. Sign in to the provider in bb; the plugin
  never reads provider credentials.
- Errors: `bb plugin list` (schedule row) and `bb plugin logs usage-forecast`.
- To stop everything: `bb plugin disable usage-forecast`. Threads, providers and
  the stored history stay unchanged.
