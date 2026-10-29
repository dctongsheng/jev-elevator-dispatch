export type Locale = "en" | "zh";

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "elevator-sense.locale";

export function parseLocale(value: unknown): Locale {
  return value === "zh" ? "zh" : DEFAULT_LOCALE;
}
