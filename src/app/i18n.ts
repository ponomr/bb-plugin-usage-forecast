// UI text in English (default) and Russian, chosen by the `language` setting.
// Every user-visible string of the app and of the server's push notifications
// lives here; formatters take the table. No app imports, so the server can use it.

import type { CompactLogEntry, ContextLimitSource, ProviderStatus, ThreadOverride } from "../shared/contract";
import type { Lang } from "../shared/language";
import type { PaceState } from "../shared/pace";
import type { PercentMode } from "../shared/percent-mode";
import { SUMMARY_MARKER } from "../shared/summary";

export interface Strings {
  lang: Lang;
  /** BCP 47 locale for clock times. */
  locale: string;
  /**
   * What limit percents show, from the `percentMode` setting; set by
   * `useStrings` and the push texts. The bare tables leave it out and show
   * the share used.
   */
  percentMode?: PercentMode;
  /** A percent left in a title or label: "59% left". */
  percentLeft(percent: string): string;
  /** Duration units: "2d 20h", "4h 17m", "23m". */
  unit: { d: string; h: string; m: string };

  // Headline
  limitReached(resumesAt: string | null): string;
  willRunOut(resetName: string): string;
  /** A window that runs out within a tenth of its length: the span until then. */
  runOutIn(span: string): string;
  /** A window that lasts with little to spare: the projected percent used at the reset. */
  tightHeadline(percent: number, resetName: string, left: boolean): string;
  onTrack(resetName: string): string;
  /** A reset less than a day away: "the 4:30 PM reset". */
  resetAtTime(time: string): string;
  /** A reset further away: "Wednesday's reset". */
  resetOnDay(weekday: number): string;
  /** When usage resumes: "4:30 PM" today, else "Wednesday 4:30 PM". */
  resumesAt(time: string, weekday: number | null): string;

  // Windows
  shortWindow: Readonly<Record<string, string>>;
  fullWindow: Readonly<Record<string, string>>;
  hitNote(resetIn: string | null): string;
  /** When the limit runs out: the local time, the short weekday when not today, and the span before the reset. */
  runsOut(time: string, weekday: string | null, beforeReset: string): string;
  /** The sidebar card's one-line form of `runsOut`. */
  runsOutShort(time: string, weekday: string | null): string;
  /** The header's forecast for a window that runs out today: "out 14:20". */
  headerOut(time: string): string;
  /** The header's forecast for a window that runs out on a later day: how long before the reset. */
  headerShort(span: string): string;
  /** A provider's label in the header when bb has no icon for it. */
  providerShort: Readonly<Record<string, string>>;
  /** A provider's name in the floating widget's lines: "Claude". */
  providerBrief: Readonly<Record<string, string>>;
  /** The floating panel's tooltip: a press folds it. */
  floatFold: string;
  /** The floating badge's tooltip: a press opens the panel. */
  floatOpen: string;
  /** A window that lasts, with the projected percent used at the reset. */
  lastsUsed(percent: number, resetIn: string | null, left: boolean): string;
  /** A window that lasts with little to spare. */
  tightUsed(percent: number, resetIn: string | null, left: boolean): string;
  /** Too early in the window; `usual` from usuallyUsed, or null without past windows. */
  tooEarly(usual: string | null, resetIn: string | null): string;
  usuallyUsed(percent: number, left: boolean): string;
  /** The rate that lasts to the reset; for `rest`, the percent left until it. */
  budget(percent: number, per: "day" | "hour" | "rest"): string;
  resetsIn(span: string): string;
  resetNow: string;
  noReset: string;
  noForecast: string;
  currentPace(percent: string, left: boolean): string;
  usualPace(percent: string, windows: number, left: boolean): string;
  /** Marks the tooltip line of the projection the band speaks from. */
  mainPace(line: string): string;
  cost(used: string, limit: string): string;
  dataFrom(clock: string): string;
  noWindows: string;
  noProviders: string;
  provider: string;
  status: Record<Exclude<ProviderStatus, "ok">, string>;
  statusError(message: string): string;

  // Band states
  loading: string;
  unavailable(message: string): string;
  noDataYet: string;
  /** The thread's host is disconnected or its last poll failed. */
  hostStale(clock: string): string;
  /** In the sidebar card: hosts that cannot be read and have no data to show. */
  hostsUnavailable(hosts: string): string;
  /** The thread's host could not be determined, or has no data yet. */
  hostUnknown: string;
  pollFailed(message: string): string;
  updated(ago: string): string;
  justNow: string;
  ago(span: string): string;
  showDetails: string;
  hideDetails: string;
  /** The button that hides another provider in the band, the sign and pushes. */
  hideProvider: string;
  hideProviderLabel(provider: string): string;
  collapse: string;
  recentCompactsCount(n: number): string;

  // Context
  context: string;
  /** The context label in the collapsed row. */
  contextShort: string;
  /** The tooltip of the collapsed row's context item. */
  contextTitle(limitTokens: number, windowTokens: number): string;
  contextUsed(percent: string): string;
  freeOf(free: string, limit: string): string;
  notMeasured: string;
  categories: { messages: string; tools: string; other: string };
  contextBreakdown: string;
  /** The working limit and where it comes from; `window` only when the limit is below the model window. */
  limitLine(limit: string, source: ContextLimitSource, provider: string, window: string | null): string;
  limitLabel: string;
  limitRange(minK: number, maxK: number): string;
  providerCompactsAt(tokens: string, percentOfWindow: string): string;
  compactUnsupported: string;
  /** Shown instead of `compactUnsupported` when the summary fallback is on. */
  summaryClearNote: string;

  // Compact and auto compact
  compact: string;
  compacting: string;
  compactTitle: string;
  compactBusyTitle: string;
  compactDidNotStart: string;
  /** The button's title when it summarises and clears. */
  summaryClearTitle: string;
  autoCompact: string;
  autoCompactAt(percent: string): string;
  autoCompactHint: string;
  thresholdLabel: string;
  thresholdShort: string;
  thresholdRange(min: number, max: number): string;
  threadAutoCompact: string;
  apply: string;
  mode: Record<ThreadOverride["autoCompact"], string>;
  autoOff(forThread: boolean): string;
  autoOn(at: string, actsAt: string | null, atTokens: string | null, forThread: boolean, pausedFor: string | null): string;
  askPast(percent: string, threshold: string): string;
  now: string;
  afterNextReply: string;

  // Compact log
  recentCompacts: string;
  trigger: Record<CompactLogEntry["trigger"], string>;
  result: Record<CompactLogEntry["result"], string>;
  /** Appended to a log entry made by summary and clear. */
  viaSummary: string;

  // Messages the plugin sends into a thread whose provider cannot compact
  /** Asks the agent for a summary that opens with SUMMARY_MARKER. */
  summaryRequest: string;
  /** Gives the summary back after the context was cleared. */
  summaryRestore(summary: string): string;

  // Sidebar indicator
  /** The footer item's label and the ring's accessible name. */
  indicatorLabel: string;
  /** A pace state in a few words, for the ring's title. */
  paceStateName: Record<PaceState, string>;
  noLimitsData: string;
  /** Next to a shared account's provider: the other hosts signed in to it. */
  alsoOn(hosts: string): string;

  // Token totals (UF-12)
  /** The band's line: "Tokens: thread 86k · today 310k · month 4.2M"; null parts are left out. */
  tokensLine(thread: string | null, today: string | null, month: string | null): string;
  /** The card's text per provider: "today 310k · month 4.2M". */
  tokensTodayMonth(today: string, month: string): string;
  /** The line's tooltip: full sums without cache reads, with them in brackets; null parts are left out. */
  tokensTitle(thread: string | null, today: string | null, month: string | null): string;

  // Settings section
  /** `claude` and `codex` are null when their limit is auto. */
  settingsSummary(enabled: boolean, threshold: number, interval: number, limit: string, claude: string | null, codex: string | null): string;
  settingsHint: string;
  notPolledYet: string;
  lastPoll(ago: string): string;
  refresh: string;
  refreshing: string;
  /** The card's refresh button. */
  refreshLimits: string;
  /** The card's button that opens the plugin settings. */
  openSettings: string;
  pollError(message: string): string;
  providerUsageNote: string;

  // Preview section: what each display setting shows, live.
  previewHeader: string;
  previewSidebar: string;
  previewBand: string;
  previewFloat: string;
  previewCard: string;
  /** After a part's name when its setting turns it off. */
  previewOff: string;

  /** Push title when a limit window crosses the notify threshold or runs out. */
  pushTitle(provider: string, window: string, percent: string, left: boolean): string;
  pushReachedTitle(provider: string, window: string): string;
  /** A push title with the hosts it is about, when more than one host is known. */
  pushOnHosts(title: string, hosts: string): string;
  /** Push body: the reset span from formatResetIn, or null when unknown. */
  pushBody(resetIn: string | null): string;
}

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const en: Strings = {
  lang: "en",
  locale: "en-US",
  percentLeft: (p) => `${p} left`,
  unit: { d: "d", h: "h", m: "m" },

  limitReached: (at) => (at === null ? "Limit reached." : `Limit reached. Back ${at}.`),
  willRunOut: (reset) => `Runs out before ${reset}.`,
  runOutIn: (span) => `Runs out in ${span}.`,
  tightHeadline: (p, reset, left) => `Tight: ~${p}%${left ? " left" : ""} by ${reset}.`,
  onTrack: (reset) => `On track to ${reset}.`,
  resetAtTime: (time) => `the ${time} reset`,
  resetOnDay: (day) => `${EN_WEEKDAYS[day]}'s reset`,
  resumesAt: (time, day) => (day === null ? time : `${EN_WEEKDAYS[day]} ${time}`),

  shortWindow: { "Current session": "5H", "Weekly limit": "W" },
  fullWindow: { "Current session": "5 Hour", "Weekly limit": "Weekly" },
  hitNote: (reset) => (reset === null ? "Limit reached" : `Limit reached – ${reset}`),
  runsOutShort: (time, day) => `runs out ${day === null ? `at ${time}` : `${day} ${time}`}`,
  headerOut: (time) => `out ${time}`,
  headerShort: (span) => `short by ${span}`,
  providerShort: { "claude-code": "CC", codex: "CX" },
  providerBrief: { "claude-code": "Claude", codex: "Codex" },
  floatFold: "Press to fold, drag to move",
  floatOpen: "Press to show the limits, drag to move",
  runsOut: (time, day, before) => `Runs out ${day === null ? `at ${time}` : `${day} ${time}`}, ${before} before reset`,
  lastsUsed: (p, reset, left) => `Lasts, ~${p}% ${left ? "left" : "used"}${reset === null ? "" : `, ${reset}`}`,
  tightUsed: (p, reset, left) => `Tight, ~${p}% ${left ? "left" : "used"}${reset === null ? "" : `, ${reset}`}`,
  tooEarly: (usual, reset) =>
    `Too early${usual === null ? "" : `, ${usual}`}${reset === null ? "" : `, ${reset}`}`,
  usuallyUsed: (p, left) => `usually ~${p}%${left ? " left" : ""}`,
  budget: (p, per) => (per === "rest" ? `${p}% left` : `≤${p}% ${per === "day" ? "a day" : "an hour"} to last`),
  resetsIn: (span) => `resets in ${span}`,
  resetNow: "resets now",
  noReset: "No reset time",
  noForecast: "No forecast yet",
  currentPace: (p, left) => `Current pace: ${p}${left ? " left" : ""} by reset`,
  usualPace: (p, n, left) => `Usual pace (${n} past windows): ${p}${left ? " left" : ""}`,
  mainPace: (line) => `${line} (main forecast)`,
  cost: (used, limit) => `${used} of ${limit}`,
  dataFrom: (clock) => `data from ${clock}`,
  noWindows: "no limit windows",
  noProviders: "No providers with limits",
  provider: "Provider",
  status: {
    not_installed: "not installed",
    unauthenticated: "not signed in",
    expired: "sign-in expired",
    error: "error",
  },
  statusError: (m) => `error: ${m}`,

  loading: "Loading limits",
  unavailable: (m) => `Limits unavailable: ${m}`,
  noDataYet: "No limit data yet",
  hostStale: (clock) => `Host unavailable, data from ${clock}`,
  hostsUnavailable: (hosts) => `Unavailable: ${hosts}`,
  hostUnknown: "No data for this host",
  pollFailed: (m) => `Poll failed: ${m}`,
  updated: (ago) => `Updated ${ago}`,
  justNow: "just now",
  ago: (span) => `${span} ago`,
  showDetails: "Show details",
  hideDetails: "Hide details",
  hideProvider: "Hide",
  hideProviderLabel: (provider) => `Hide ${provider} here and in notifications`,
  collapse: "Collapse",
  recentCompactsCount: (n) => `Recent compacts (${n})`,

  context: "Context",
  contextShort: "Ctx",
  contextTitle: (limit, window) =>
    limit < window ? `Context: used of the ${limit.toLocaleString("en-US")} limit (window ${window.toLocaleString("en-US")})` : "Context",
  contextUsed: (p) => `${p} used`,
  freeOf: (free, limit) => `${free} free of ${limit}`,
  notMeasured: "not measured yet",
  categories: { messages: "Messages", tools: "Tools", other: "Other" },
  contextBreakdown: "Context breakdown",
  limitLine: (limit, source, provider, window) =>
    `${
      {
        thread: `Limit ${limit} (this thread)`,
        provider: `Limit ${limit} (${provider} setting)`,
        reported: `Limit ${limit}: where ${provider} compacts on its own`,
        settings: `Limit ${limit} (global setting)`,
        window: `Limit ${limit}: the model window`,
      }[source]
    }${window === null ? "" : `, window ${window}`}`,
  limitLabel: "Thread limit, k tokens",
  limitRange: (min, max) => `Limit ${min}–${max}k tokens, blank for the provider's or global limit`,
  providerCompactsAt: (t, p) => `The provider compacts on its own at ${t} (${p} of the window)`,
  compactUnsupported: "Provider cannot compact",
  summaryClearNote: "Provider cannot compact: Compact asks for a summary, clears the context and sends the summary back",

  compact: "Compact",
  compacting: "Compacting…",
  compactTitle: "Compact the thread context (/compact)",
  compactBusyTitle: "Agent is replying",
  compactDidNotStart: "Compact did not start",
  summaryClearTitle: "Ask the agent for a summary, clear the context and send the summary back",
  autoCompact: "Auto compact",
  autoCompactAt: (p) => `Auto compact at ${p}`,
  autoCompactHint: "Auto compact for this thread. Threshold: settings or context card.",
  thresholdLabel: "Auto compact threshold, %",
  thresholdShort: "Threshold, %",
  thresholdRange: (min, max) => `Threshold ${min}–${max}%`,
  threadAutoCompact: "Thread auto compact",
  apply: "Apply",
  mode: { inherit: "as in settings", off: "off", on: "on" },
  autoOff: (thread) => `Auto compact: off${thread ? " (this thread)" : ""}`,
  autoOn: (at, actsAt, atTokens, thread, paused) =>
    `Auto compact: on at ${at}${actsAt === null ? "" : `, acts at ${actsAt}`}${atTokens === null ? "" : ` (${atTokens})`}${
      thread ? " (this thread)" : ""
    }${paused === null ? "" : `, paused for ${paused}`}`,
  askPast: (p, t) => `Context is already at ${p}, past ${t}. Auto compact:`,
  now: "Now",
  afterNextReply: "After the next reply",

  recentCompacts: "Recent compacts",
  trigger: { auto: "auto", manual: "manual" },
  result: { compacted: "compacted", failed: "failed", unsupported: "unsupported", cancelled: "cancelled" },
  viaSummary: " (summary and clear)",

  summaryRequest:
    "The Ultimate Usage Widgets plugin (usage-forecast) is about to clear this thread's context to free the context window. " +
    "Write a summary of the conversation so far that lets you continue the work after the clear: the goal, " +
    "decisions made, the current state, open questions, next steps, and the exact names you will need " +
    "(files, commands, identifiers, values). Do not call tools and do not change files. " +
    `Start your answer with the line ${SUMMARY_MARKER}.`,
  summaryRestore: (summary) =>
    "The Ultimate Usage Widgets plugin (usage-forecast) cleared this thread's context to free the context window. Below is the summary " +
    "you wrote just before the clear; treat it as the conversation so far and continue from it. " +
    "Do not start any work now: reply with one short line that you have it.\n\n" +
    `${SUMMARY_MARKER}\n${summary}`,

  indicatorLabel: "Usage limits",
  paceStateName: { calm: "on track", tight: "tight", short: "runs out before reset", critical: "critical", hit: "limit reached" },
  noLimitsData: "No limits data",
  alsoOn: (hosts) => `also ${hosts}`,

  tokensLine: (thread, today, month) =>
    `Tokens: ${[thread === null ? null : `thread ${thread}`, today === null ? null : `today ${today}`, month === null ? null : `month ${month}`]
      .filter((p) => p !== null)
      .join(" · ")}`,
  tokensTodayMonth: (today, month) => `today ${today} · month ${month}`,
  tokensTitle: (thread, today, month) =>
    [
      "Tokens without cache reads (with them in brackets).",
      thread === null ? null : `This thread: ${thread}.`,
      today === null ? null : `The provider today: ${today}.`,
      month === null ? null : `The provider this month: ${month}.`,
      "Counts BB threads only; use of the same account outside BB is not included.",
    ]
      .filter((p) => p !== null)
      .join("\n"),

  settingsSummary: (on, t, i, limit, claude, codex) =>
    `Context limit: Claude Code ${claude ?? "auto"}, Codex ${codex ?? "auto"}, otherwise ${limit} tokens. Auto compact: ${
      on ? `on, threshold ${t}% of the limit` : "off"
    }. Limits polled every ${i} min.`,
  settingsHint:
    "Context limit order: thread, provider, the provider's own compact point (Claude Code reports it), global. A thread's limit and auto compact: its context card or the band.",
  notPolledYet: "Limits not polled yet",
  lastPoll: (ago) => `Last poll: ${ago}`,
  refresh: "Refresh now",
  refreshing: "Refreshing…",
  refreshLimits: "Refresh limits",
  openSettings: "Plugin settings",
  pollError: (m) => `Poll error: ${m}`,
  providerUsageNote: "The built-in «Provider usage» plugin can stay on.",

  previewHeader: "Header",
  previewSidebar: "Sidebar icon",
  previewBand: "Band above the composer",
  previewFloat: "Floating widget",
  previewCard: "Limits card",
  previewOff: "off",

  pushTitle: (provider, window, percent, left) =>
    left ? `${provider}: ${window} limit, ${percent} left` : `${provider}: ${window} limit at ${percent}`,
  pushReachedTitle: (provider, window) => `${provider}: ${window} limit reached`,
  pushOnHosts: (title, hosts) => `${title} on ${hosts}`,
  pushBody: (resetIn) => (resetIn === null ? "Usage limit is close." : `The limit ${resetIn}.`),
};

/** Accusative weekdays: "в среду". */
const RU_WEEKDAYS_ACC = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"] as const;

export const ru: Strings = {
  lang: "ru",
  locale: "ru-RU",
  percentLeft: (p) => `осталось ${p}`,
  unit: { d: "д", h: "ч", m: "м" },

  limitReached: (at) => (at === null ? "Лимит исчерпан." : `Лимит исчерпан. Снова ${at}.`),
  willRunOut: (reset) => `Кончится до ${reset}.`,
  runOutIn: (span) => `Кончится через ${span}.`,
  tightHeadline: (p, reset, left) => (left ? `Впритык: останется ~${p}% до ${reset}.` : `Впритык: ~${p}% до ${reset}.`),
  onTrack: (reset) => `Хватит до ${reset}.`,
  resetAtTime: (time) => `сброса в ${time}`,
  resetOnDay: (day) => `сброса ${RU_WEEKDAYS_ACC[day]}`,
  resumesAt: (time, day) => (day === null ? `в ${time}` : `${RU_WEEKDAYS_ACC[day]} в ${time}`),

  shortWindow: { "Current session": "5ч", "Weekly limit": "Нед" },
  fullWindow: { "Current session": "5 часов", "Weekly limit": "Неделя" },
  hitNote: (reset) => (reset === null ? "Лимит исчерпан" : `Лимит исчерпан – ${reset}`),
  runsOutShort: (time, day) => `кончится ${day === null ? `в ${time}` : `в ${day} ${time}`}`,
  headerOut: (time) => `кончится ${time}`,
  headerShort: (span) => `не хватит ${span}`,
  providerShort: { "claude-code": "CC", codex: "CX" },
  providerBrief: { "claude-code": "Claude", codex: "Codex" },
  floatFold: "Нажмите, чтобы свернуть; перетащите, чтобы сдвинуть",
  floatOpen: "Нажмите, чтобы показать лимиты; перетащите, чтобы сдвинуть",
  runsOut: (time, day, before) => `Кончится ${day === null ? `в ${time}` : `в ${day} ${time}`}, за ${before} до сброса`,
  lastsUsed: (p, reset, left) => `Хватит, к сбросу ${left ? "останется " : ""}~${p}%${reset === null ? "" : `, ${reset}`}`,
  tightUsed: (p, reset, left) => `Впритык, к сбросу ${left ? "останется " : ""}~${p}%${reset === null ? "" : `, ${reset}`}`,
  tooEarly: (usual, reset) =>
    `Рано судить${usual === null ? "" : `, ${usual}`}${reset === null ? "" : `, ${reset}`}`,
  usuallyUsed: (p, left) => `обычно ${left ? "остаётся " : ""}~${p}%`,
  budget: (p, per) => (per === "rest" ? `осталось ${p}%` : `≤${p}% в ${per === "day" ? "день" : "час"}, чтобы хватило`),
  resetsIn: (span) => `сброс через ${span}`,
  resetNow: "сброс сейчас",
  noReset: "Время сброса неизвестно",
  noForecast: "Прогноза пока нет",
  currentPace: (p, left) => `По текущему темпу к сбросу${left ? " останется" : ""}: ${p}`,
  usualPace: (p, n, left) => `По прошлым окнам (${n})${left ? " останется" : ""}: ${p}`,
  mainPace: (line) => `${line} (основной прогноз)`,
  cost: (used, limit) => `${used} из ${limit}`,
  dataFrom: (clock) => `данные от ${clock}`,
  noWindows: "нет окон лимитов",
  noProviders: "Нет провайдеров с лимитами",
  provider: "Провайдер",
  status: {
    not_installed: "не установлен",
    unauthenticated: "не выполнен вход",
    expired: "вход истёк",
    error: "ошибка",
  },
  statusError: (m) => `ошибка: ${m}`,

  loading: "Загрузка лимитов",
  unavailable: (m) => `Лимиты недоступны: ${m}`,
  noDataYet: "Данные ещё не получены",
  hostStale: (clock) => `Хост недоступен, данные от ${clock}`,
  hostsUnavailable: (hosts) => `Недоступны: ${hosts}`,
  hostUnknown: "Нет данных хоста",
  pollFailed: (m) => `Опрос не удался: ${m}`,
  updated: (ago) => `Обновлено ${ago}`,
  justNow: "только что",
  ago: (span) => `${span} назад`,
  showDetails: "Подробнее",
  hideDetails: "Свернуть",
  hideProvider: "Скрыть",
  hideProviderLabel: (provider) => `Скрыть ${provider} здесь и в уведомлениях`,
  collapse: "Свернуть",
  recentCompactsCount: (n) => `Последние сжатия (${n})`,

  context: "Контекст",
  contextShort: "Конт",
  contextTitle: (limit, window) =>
    limit < window ? `Контекст: занято из лимита ${limit.toLocaleString("ru-RU")} (окно ${window.toLocaleString("ru-RU")})` : "Контекст",
  contextUsed: (p) => `занято ${p}`,
  freeOf: (free, limit) => `свободно ${free} из ${limit}`,
  notMeasured: "ещё не измерен",
  categories: { messages: "Сообщения", tools: "Инструменты", other: "Прочее" },
  contextBreakdown: "Состав контекста",
  limitLine: (limit, source, provider, window) =>
    `${
      {
        thread: `Лимит ${limit} (для треда)`,
        provider: `Лимит ${limit} (настройка ${provider})`,
        reported: `Лимит ${limit}: здесь ${provider} сжимает сам`,
        settings: `Лимит ${limit} (общая настройка)`,
        window: `Лимит ${limit}: окно модели`,
      }[source]
    }${window === null ? "" : `, окно ${window}`}`,
  limitLabel: "Лимит треда, тыс. токенов",
  limitRange: (min, max) => `Лимит от ${min} до ${max} тыс. токенов, пусто — лимит провайдера или общий`,
  providerCompactsAt: (t, p) => `Провайдер сжимает сам на ${t} (${p} окна)`,
  compactUnsupported: "Провайдер не умеет сжимать",
  summaryClearNote: "Провайдер не умеет сжимать: «Сжать» просит пересказ, очищает контекст и отправляет пересказ обратно",

  compact: "Сжать",
  compacting: "Сжимаю…",
  compactTitle: "Сжать контекст треда (/compact)",
  compactBusyTitle: "Агент отвечает",
  compactDidNotStart: "Сжатие не запустилось",
  summaryClearTitle: "Попросить агента о пересказе, очистить контекст и отправить пересказ обратно",
  autoCompact: "Авто-компакт",
  autoCompactAt: (p) => `Авто-компакт на ${p}`,
  autoCompactHint: "Авто-компакт треда. Порог — в настройках или карточке контекста.",
  thresholdLabel: "Порог авто-компакта, %",
  thresholdShort: "Порог, %",
  thresholdRange: (min, max) => `Порог от ${min} до ${max}%`,
  threadAutoCompact: "Авто-компакт треда",
  apply: "Применить",
  mode: { inherit: "как в настройках", off: "выкл", on: "вкл" },
  autoOff: (thread) => `Авто-компакт: выкл${thread ? " (для треда)" : ""}`,
  autoOn: (at, actsAt, atTokens, thread, paused) =>
    `Авто-компакт: вкл на ${at}${actsAt === null ? "" : `, срабатывает на ${actsAt}`}${atTokens === null ? "" : ` (${atTokens})`}${
      thread ? " (для треда)" : ""
    }${paused === null ? "" : `, пауза ещё ${paused}`}`,
  askPast: (p, t) => `Контекст уже ${p}, выше порога ${t}. Авто-компакт:`,
  now: "Сейчас",
  afterNextReply: "После следующего ответа",

  recentCompacts: "Последние сжатия",
  trigger: { auto: "авто", manual: "вручную" },
  result: { compacted: "сжат", failed: "ошибка", unsupported: "не поддерживается", cancelled: "отменён" },
  viaSummary: " (пересказ и очистка)",

  summaryRequest:
    "Плагин Ultimate Usage Widgets (usage-forecast) сейчас очистит контекст этого треда, чтобы освободить окно контекста. " +
    "Напиши пересказ разговора, по которому ты продолжишь работу после очистки: цель, принятые решения, " +
    "текущее состояние, открытые вопросы, следующие шаги и точные названия, которые понадобятся " +
    "(файлы, команды, идентификаторы, значения). Не вызывай инструменты и не меняй файлы. " +
    `Начни ответ со строки ${SUMMARY_MARKER}.`,
  summaryRestore: (summary) =>
    "Плагин Ultimate Usage Widgets (usage-forecast) очистил контекст этого треда, чтобы освободить окно контекста. Ниже пересказ, " +
    "который ты написал перед очисткой; считай его разговором до этого места и продолжай с него. " +
    "Сейчас не начинай работу: ответь одной короткой строкой, что пересказ получен.\n\n" +
    `${SUMMARY_MARKER}\n${summary}`,

  indicatorLabel: "Лимиты",
  paceStateName: { calm: "в норме", tight: "впритык", short: "не хватит до сброса", critical: "критично", hit: "лимит исчерпан" },
  noLimitsData: "Нет данных о лимитах",
  alsoOn: (hosts) => `также ${hosts}`,

  tokensLine: (thread, today, month) =>
    `Токены: ${[thread === null ? null : `тред ${thread}`, today === null ? null : `сегодня ${today}`, month === null ? null : `месяц ${month}`]
      .filter((p) => p !== null)
      .join(" · ")}`,
  tokensTodayMonth: (today, month) => `сегодня ${today} · месяц ${month}`,
  tokensTitle: (thread, today, month) =>
    [
      "Токены без чтения кэша (с ним — в скобках).",
      thread === null ? null : `Этот тред: ${thread}.`,
      today === null ? null : `Провайдер сегодня: ${today}.`,
      month === null ? null : `Провайдер за месяц: ${month}.`,
      "Считаются только треды BB; работа с тем же аккаунтом вне BB не входит.",
    ]
      .filter((p) => p !== null)
      .join("\n"),

  settingsSummary: (on, t, i, limit, claude, codex) =>
    `Лимит контекста: Claude Code ${claude ?? "авто"}, Codex ${codex ?? "авто"}, остальные ${limit} токенов. Авто-компакт: ${
      on ? `вкл, порог ${t}% от лимита` : "выкл"
    }. Опрос лимитов каждые ${i} мин.`,
  settingsHint:
    "Порядок лимита контекста: тред, провайдер, точка сжатия провайдера (Claude Code её сообщает), общий. Лимит и авто-компакт треда — в его карточке контекста или в полосе.",
  notPolledYet: "Лимиты ещё не опрошены",
  lastPoll: (ago) => `Последний опрос: ${ago}`,
  refresh: "Обновить сейчас",
  refreshing: "Обновляю…",
  refreshLimits: "Обновить лимиты",
  openSettings: "Настройки плагина",
  pollError: (m) => `Ошибка опроса: ${m}`,
  providerUsageNote: "Встроенный плагин «Provider usage» можно не выключать.",

  previewHeader: "Шапка",
  previewSidebar: "Значок в сайдбаре",
  previewBand: "Полоса над чатом",
  previewFloat: "Плавающий виджет",
  previewCard: "Карточка лимитов",
  previewOff: "выкл.",

  pushTitle: (provider, window, percent, left) =>
    left ? `${provider}: лимит «${window}» — осталось ${percent}` : `${provider}: лимит «${window}» — ${percent}`,
  pushReachedTitle: (provider, window) => `${provider}: лимит «${window}» исчерпан`,
  pushOnHosts: (title, hosts) => `${title} на ${hosts}`,
  pushBody: (resetIn) => (resetIn === null ? "Лимит почти исчерпан." : `Лимит: ${resetIn}.`),
};

export const STRINGS: Record<Lang, Strings> = { en, ru };
