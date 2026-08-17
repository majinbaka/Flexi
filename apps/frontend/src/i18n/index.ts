import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import vi from './locales/vi.json';

/**
 * i18next init with en/vi stub resources for the base system UI.
 * Dynamic user-created content translation (field labels, page names, wiki
 * content) is deferred -- this only covers the app shell.
 */
void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    vi: { translation: vi },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18next;
