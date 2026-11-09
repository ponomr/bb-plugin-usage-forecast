// UI text in English (default) and Russian, chosen by the `language` setting.
// Every user-visible string of the app lives here; formatters take the table.

import { useSettings } from "@get-bb/plugin-sdk/app";
import type { CompactLogEntry, ProviderStatus, ThreadOverride } from "../shared/contract";
import { parseLang, type Lang } from "../shared/language";

export interface Strings {
  lang: Lang;
  /** BCP 47 locale for clock times. */
  locale: string;
  /** Duration units: "2d 20h", "4h 17m", "23m". */
  unit: { d: string; h: string; m: string };

  // Headline
  limitReached(resumesAt: string | null): string;
  willRunOut(resetName: string): string;
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
  willHitIn(hitIn: string, resetIn: string | null): string;
  onPaceFor(percent: number, resetIn: string | null): string;
  /** The pace note when the band shows what is left. */
  leftAtReset(percent: number, resetIn: string | null): string;
  /** "75% left", for the percent shown as what is left. */
  percentLeft(percent: string): string;
  resetsIn(span: string): string;
  resetNow: string;
  noReset: string;
  noForecast: string;
  currentPace(percent: string): string;
  usualPace(percent: string, windows: number): string;
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
  pollFailed(message: string): string;
  updated(ago: string): string;
  justNow: string;
  ago(span: string): string;
  showDetails: string;
  hideDetails: string;
  collapse: string;
  recentCompactsCount(n: number): string;

  // Context
  context: string;
  /** The context label in the collapsed row. */
  contextShort: string;
  contextUsed(percent: string): string;
  freeOf(free: string, total: string): string;
  notMeasured: string;
  categories: { messages: string; tools: string; other: string };
  contextBreakdown: string;
  providerCompactsAt(percent: string): string;
  compactUnsupported: string;

  // Compact and auto compact
  compact: string;
  compacting: string;
  compactTitle: string;
  compactBusyTitle: string;
  compactDidNotStart: string;
  autoCompact: string;
  thresholdLabel: string;
  thresholdShort: string;
  thresholdRange(min: number, max: number): string;
  threadAutoCompact: string;
  apply: string;
  mode: Record<ThreadOverride["autoCompact"], string>;
  autoOff(forThread: boolean): string;
  autoOn(at: string, actsAt: string | null, forThread: boolean, pausedFor: string | null): string;
  askPast(percent: string, threshold: string): string;
  now: string;
  afterNextReply: string;

  // Compact log
  recentCompacts: string;
  trigger: Record<CompactLogEntry["trigger"], string>;
  result: Record<CompactLogEntry["result"], string>;

  // Settings section
  settingsSummary(enabled: boolean, threshold: number, interval: number): string;
  settingsHint: string;
  notPolledYet: string;
  lastPoll(ago: string): string;
  refresh: string;
  refreshing: string;
  pollError(message: string): string;
  providerUsageNote: string;
}

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const en: Strings = {
  lang: "en",
  locale: "en-US",
  unit: { d: "d", h: "h", m: "m" },

  limitReached: (at) => (at === null ? "Limit reached." : `Limit reached. Usage resumes at ${at}.`),
  willRunOut: (reset) => `At this pace you'll run out before ${reset}.`,
  onTrack: (reset) => `On track. You should reach ${reset} with room to spare.`,
  resetAtTime: (time) => `the ${time} reset`,
  resetOnDay: (day) => `${EN_WEEKDAYS[day]}'s reset`,
  resumesAt: (time, day) => (day === null ? time : `${EN_WEEKDAYS[day]} ${time}`),

  shortWindow: { "Current session": "5H", "Weekly limit": "W" },
  fullWindow: { "Current session": "5 Hour", "Weekly limit": "Weekly" },
  hitNote: (reset) => (reset === null ? "Limit reached" : `Limit reached – ${reset}`),
  willHitIn: (hit, reset) => `Limit will hit in ${hit}${reset === null ? "" : ` – ${reset}`}`,
  onPaceFor: (p, reset) => `On pace for about ${p}% by reset${reset === null ? "" : ` – ${reset}`}`,
  leftAtReset: (p, reset) => `About ${p}% left at reset${reset === null ? "" : ` – ${reset}`}`,
  percentLeft: (p) => `${p} left`,
  resetsIn: (span) => `resets in ${span}`,
  resetNow: "resets now",
  noReset: "No reset time",
  noForecast: "No forecast yet",
  currentPace: (p) => `Current pace: ${p} by reset`,
  usualPace: (p, n) => `Usual pace (${n} past windows): ${p}`,
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
  pollFailed: (m) => `Last poll failed: ${m}`,
  updated: (ago) => `Updated ${ago}`,
  justNow: "just now",
  ago: (span) => `${span} ago`,
  showDetails: "Show details",
  hideDetails: "Hide details",
  collapse: "Collapse",
  recentCompactsCount: (n) => `Recent compacts (${n})`,

  context: "Context",
  contextShort: "Ctx",
  contextUsed: (p) => `${p} used`,
  freeOf: (free, total) => `${free} free of ${total}`,
  notMeasured: "not measured yet",
  categories: { messages: "Messages", tools: "Tools", other: "Other" },
  contextBreakdown: "Context breakdown",
  providerCompactsAt: (p) => `The provider compacts on its own at ${p}`,
  compactUnsupported: "The provider does not support compacting",

  compact: "Compact",
  compacting: "Compacting…",
  compactTitle: "Compact the thread context (/compact)",
  compactBusyTitle: "The agent is replying; compact after the reply",
  compactDidNotStart: "Compact did not start",
  autoCompact: "Auto compact",
  thresholdLabel: "Auto compact threshold, %",
  thresholdShort: "Threshold, %",
  thresholdRange: (min, max) => `Threshold ${min}–${max}%`,
  threadAutoCompact: "Thread auto compact",
  apply: "Apply",
  mode: { inherit: "as in settings", off: "off", on: "on" },
  autoOff: (thread) => `Auto compact: off${thread ? " (this thread)" : ""}`,
  autoOn: (at, actsAt, thread, paused) =>
    `Auto compact: on at ${at}${actsAt === null ? "" : `, acts at ${actsAt}`}${thread ? " (this thread)" : ""}${
      paused === null ? "" : `, paused for ${paused}`
    }`,
  askPast: (p, t) => `Context is already at ${p}, past ${t}. Auto compact:`,
  now: "Now",
  afterNextReply: "After the next reply",

  recentCompacts: "Recent compacts",
  trigger: { auto: "auto", manual: "manual" },
  result: { compacted: "compacted", failed: "failed", unsupported: "unsupported", cancelled: "cancelled" },

  settingsSummary: (on, t, i) => `Auto compact: ${on ? `on, threshold ${t}%` : "off"}. Limits polled every ${i} min.`,
  settingsHint:
    "Change the settings in the form above. Claude Code compacts on its own at 78%, so for it the plugin acts at 76% at most. A single thread is set in its context card or in the band.",
  notPolledYet: "Limits not polled yet",
  lastPoll: (ago) => `Last poll: ${ago}`,
  refresh: "Refresh now",
  refreshing: "Refreshing…",
  pollError: (m) => `Poll error: ${m}`,
  providerUsageNote:
    "The built-in «Provider usage» plugin (bb--provider-usage) can stay on: both read the same bb limits and do not interfere.",
};

/** Accusative weekdays: "в среду". */
const RU_WEEKDAYS_ACC = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"] as const;

export const ru: Strings = {
  lang: "ru",
  locale: "ru-RU",
  unit: { d: "д", h: "ч", m: "м" },

  limitReached: (at) => (at === null ? "Лимит исчерпан." : `Лимит исчерпан. Работа возобновится ${at}.`),
  willRunOut: (reset) => `При таком темпе лимит закончится до ${reset}.`,
  onTrack: (reset) => `Всё в порядке. Лимита с запасом хватит до ${reset}.`,
  resetAtTime: (time) => `сброса в ${time}`,
  resetOnDay: (day) => `сброса ${RU_WEEKDAYS_ACC[day]}`,
  resumesAt: (time, day) => (day === null ? `в ${time}` : `${RU_WEEKDAYS_ACC[day]} в ${time}`),

  shortWindow: { "Current session": "5ч", "Weekly limit": "Нед" },
  fullWindow: { "Current session": "5 часов", "Weekly limit": "Неделя" },
  hitNote: (reset) => (reset === null ? "Лимит исчерпан" : `Лимит исчерпан – ${reset}`),
  willHitIn: (hit, reset) => `Лимит закончится через ${hit}${reset === null ? "" : ` – ${reset}`}`,
  onPaceFor: (p, reset) => `К сбросу примерно ${p}%${reset === null ? "" : ` – ${reset}`}`,
  leftAtReset: (p, reset) => `К сбросу останется примерно ${p}%${reset === null ? "" : ` – ${reset}`}`,
  percentLeft: (p) => `осталось ${p}`,
  resetsIn: (span) => `сброс через ${span}`,
  resetNow: "сброс сейчас",
  noReset: "Время сброса неизвестно",
  noForecast: "Прогноза пока нет",
  currentPace: (p) => `По текущему темпу к сбросу: ${p}`,
  usualPace: (p, n) => `По прошлым окнам (${n}): ${p}`,
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
  pollFailed: (m) => `Последний опрос не удался: ${m}`,
  updated: (ago) => `Обновлено ${ago}`,
  justNow: "только что",
  ago: (span) => `${span} назад`,
  showDetails: "Подробнее",
  hideDetails: "Свернуть",
  collapse: "Свернуть",
  recentCompactsCount: (n) => `Последние сжатия (${n})`,

  context: "Контекст",
  contextShort: "Конт",
  contextUsed: (p) => `занято ${p}`,
  freeOf: (free, total) => `свободно ${free} из ${total}`,
  notMeasured: "ещё не измерен",
  categories: { messages: "Сообщения", tools: "Инструменты", other: "Прочее" },
  contextBreakdown: "Состав контекста",
  providerCompactsAt: (p) => `Провайдер сжимает сам на ${p}`,
  compactUnsupported: "Провайдер не поддерживает сжатие",

  compact: "Сжать",
  compacting: "Сжимаю…",
  compactTitle: "Сжать контекст треда (/compact)",
  compactBusyTitle: "Агент отвечает; сжать можно после ответа",
  compactDidNotStart: "Сжатие не запустилось",
  autoCompact: "Авто-компакт",
  thresholdLabel: "Порог авто-компакта, %",
  thresholdShort: "Порог, %",
  thresholdRange: (min, max) => `Порог от ${min} до ${max}%`,
  threadAutoCompact: "Авто-компакт треда",
  apply: "Применить",
  mode: { inherit: "как в настройках", off: "выкл", on: "вкл" },
  autoOff: (thread) => `Авто-компакт: выкл${thread ? " (для треда)" : ""}`,
  autoOn: (at, actsAt, thread, paused) =>
    `Авто-компакт: вкл на ${at}${actsAt === null ? "" : `, срабатывает на ${actsAt}`}${thread ? " (для треда)" : ""}${
      paused === null ? "" : `, пауза ещё ${paused}`
    }`,
  askPast: (p, t) => `Контекст уже ${p}, выше порога ${t}. Авто-компакт:`,
  now: "Сейчас",
  afterNextReply: "После следующего ответа",

  recentCompacts: "Последние сжатия",
  trigger: { auto: "авто", manual: "вручную" },
  result: { compacted: "сжат", failed: "ошибка", unsupported: "не поддерживается", cancelled: "отменён" },

  settingsSummary: (on, t, i) => `Авто-компакт: ${on ? `вкл, порог ${t}%` : "выкл"}. Опрос лимитов каждые ${i} мин.`,
  settingsHint:
    "Настройки меняются в форме выше. Claude Code сжимает сам на 78%, поэтому для него плагин срабатывает не позже 76%. Отдельный тред настраивается в его карточке контекста или в полосе над полем ввода.",
  notPolledYet: "Лимиты ещё не опрошены",
  lastPoll: (ago) => `Последний опрос: ${ago}`,
  refresh: "Обновить сейчас",
  refreshing: "Обновляю…",
  pollError: (m) => `Ошибка опроса: ${m}`,
  providerUsageNote:
    "Встроенный плагин «Provider usage» (bb--provider-usage) можно оставить включённым: оба читают одни и те же лимиты bb и не мешают друг другу.",
};

export const STRINGS: Record<Lang, Strings> = { en, ru };

/** The table for the `language` setting; English until the settings load. */
export function useStrings(): Strings {
  return STRINGS[parseLang(useSettings().values?.language)];
}
