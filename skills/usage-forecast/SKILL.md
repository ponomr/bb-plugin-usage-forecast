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
  percent used, time to reset and the forecast from the current pace: either
  `at this pace lasts to reset (N% at reset)` or `at this pace runs out <UTC time>
  (<span> before reset), budget N%/day` (`/hour` for five-hour windows,
  `N% until reset` when less than one day or hour is left). In the first 5 %
  of a window it says `too early to judge`. After enough history it adds the
  past windows as a reference (`usual pace N% (K windows)`). `[over 100%]` means
  the current pace runs out before the reset. The bracket after the percent is
  the pace state: `[calm]`, `[tight]` (85–100 % at reset), `[will not last]`,
  `[critical]` (runs out within a tenth of the window) or `[used up]`; early
  windows have none. `--refresh` polls now. With more than
  one bb host each block names its host (`codex (Plus) on MacBook: ok`); hosts
  signed in to one account share a block, and a host that is not connected
  says from when its data is. `--json` has the same data per host in `hosts`.
- `bb usage-forecast thread <threadId> [--json]` — context fill (tokens and % of the working limit), the limit and its source
  (this thread, the provider setting, where the provider compacts on its own, the global setting, or the model window),
  whether the agent is answering, the effective auto-compact policy and its
  source (settings or this thread), the cooldown.
- `bb usage-forecast compact <threadId>` — compact now. It queues a `/compact`
  turn, so it refuses while the thread is answering. For a provider that
  cannot compact, with `summaryClearEnabled` on, it starts summary and clear
  instead and returns at once.
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
| `summaryClearEnabled` | `false` | — (summary and clear for providers that cannot compact) |
| `limitNotifyEnabled` | `true` | — (push through the `push-notifications` plugin) |
| `limitNotifyPercent` | 90 | 50–100 |
| `pollIntervalMinutes` | 2 | 1–10 |
| `language` | `en` | `en`, `ru` (UI language) |
| `limitsShow` | `used` | `used`, `remaining` (band only; CLI output stays in percent used) |
| `resetShow` | `countdown` | `countdown`, `time` (band only: the reset as a countdown or as the local time) |

The thread's working limit is, in order: the thread's own limit, the provider
setting, the point where the provider compacts on its own (Claude Code reports
it after a turn, e.g. 167 000 of a 200 000 window; the plugin reuses the last
reported value for the same window while a turn runs), the global limit. A
smaller model window caps it. The fill percent and the threshold are of this
limit.

Do not turn `autoCompactEnabled` or `summaryClearEnabled` on unless the user
asks for it.

## How auto-compact decides

- It runs only on `thread.idle`, when the context is at or above the
  threshold, and never for an answering thread.
- When the limit lies above the point where the provider compacts on its own,
  the threshold is capped 2 % of the window below that point so the compact
  happens between turns. Codex reports no such point: keep its limit at or
  below its own auto-compact limit.
- With a large model window (for example 1M tokens) the provider's own point
  comes very late, so the threshold does too. A user who wants earlier
  compacts sets `claudeCodeContextLimitTokens` or `codexContextLimitTokens`
  to the size they want to work with.
- After a compact, or a failed attempt, the thread waits 10 minutes.
- A provider whose compact fails as unsupported (custom ACP agents) is
  skipped for 24 hours, unless `summaryClearEnabled` is on: then the plugin
  sends the agent a request for a summary starting with `[context-summary]`,
  waits up to 10 minutes for that turn, clears the context
  (`threads.clearContext`) and sends the summary back as the next message.
  No summary, a failed turn or a new user turn means no clear. Log entries
  of this kind say «summary and clear».
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
