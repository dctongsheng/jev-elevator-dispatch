"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, parseLocale, type Locale } from "@/lib/i18n/locale";

type LanguageContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (english: string, chinese: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
const listeners = new Set<() => void>();
let currentLocale: Locale = DEFAULT_LOCALE;
let initialized = false;

function getSnapshot(): Locale {
  if (!initialized) {
    initialized = true;
    try { currentLocale = parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY)); } catch { /* Storage may be disabled. */ }
  }
  return currentLocale;
}

function getServerSnapshot(): Locale { return DEFAULT_LOCALE; }

function publish(locale: Locale) {
  currentLocale = locale;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    try {
      if (event.storageArea === window.localStorage && (event.key === LOCALE_STORAGE_KEY || event.key === null)) {
        publish(parseLocale(event.newValue));
      }
    } catch { /* A browser can deny storage access. */ }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function setLocale(locale: Locale) {
  initialized = true;
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Switching still works without persistence. */ }
  publish(locale);
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Match the server's English on hydration, then restore the saved preference.
  // Browser language is deliberately not used: first visits default to English.
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const t = useCallback((english: string, chinese: string) => locale === "zh" ? chinese : english, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  return (
    <LanguageContext.Provider value={value}>
      <title>{t("Elevator Sense", "智能电梯调度")}</title>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage requires LanguageProvider");
  return value;
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useLanguage();
  return (
    <select value={locale} onChange={(event) => setLocale(parseLocale(event.target.value))}
      aria-label={t("Language", "语言")} title={t("Interface language", "界面语言")}
      className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 outline-none focus-visible:border-emerald-500">
      <option value="en">English</option>
      <option value="zh">简体中文</option>
    </select>
  );
}
