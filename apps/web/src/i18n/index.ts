import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

export const resources = { en: { translation: en } } as const;
export type Lang = 'en' | 'si';

void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
});

/**
 * Switch the UI language (Settings › Appearance, per person). Sinhala strings are a separate chunk,
 * fetched only by someone who uses them; any key missing there falls back to English.
 */
export async function setLanguage(lang: Lang): Promise<void> {
  if (lang === 'si' && !i18n.hasResourceBundle('si', 'translation')) {
    const si = (await import('./si.json')).default;
    i18n.addResourceBundle('si', 'translation', si);
  }
  await i18n.changeLanguage(lang);
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/** Dates follow the UI language; money stays en-LK everywhere (CLAUDE.md rule 4). */
export function uiLocale(householdLocale: string): string {
  return i18n.language === 'si' ? 'si-LK' : householdLocale;
}

export default i18n;
