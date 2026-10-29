import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { tr } from './tr';

export type Language = 'tr' | 'en';

export async function initI18n(lng: Language): Promise<void> {
  await i18next.use(initReactI18next).init({
    lng,
    fallbackLng: 'tr',
    resources: { tr: { translation: tr }, en: { translation: en } },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  document.documentElement.lang = lng;
}

export async function setLanguage(lng: Language): Promise<void> {
  await i18next.changeLanguage(lng);
  document.documentElement.lang = lng;
}

export { i18next };
