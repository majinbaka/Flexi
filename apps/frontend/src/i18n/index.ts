import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import vi from './locales/vi.json';

const SUPPORTED_LANGUAGES = ['en', 'vi'] as const;
const STORAGE_KEY = 'flexi-language';

function isSupportedLanguage(value: string): value is (typeof SUPPORTED_LANGUAGES)[number] {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Reads localStorage/navigator defensively -- both can throw (e.g. storage disabled by policy, some private-browsing modes). */
function resolveInitialLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isSupportedLanguage(stored)) {
      return stored;
    }

    const preferences = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const preference of preferences) {
      const short = preference.slice(0, 2);
      if (isSupportedLanguage(short)) {
        return short;
      }
    }
  } catch {
    // Fall through to the default below.
  }

  return 'en';
}

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
  lng: resolveInitialLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

// Persist the manual toggle in TopNav (currently the only languageChanged
// trigger) so the choice survives a reload instead of resetting to English.
i18next.on('languageChanged', (language) => {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage unavailable (e.g. disabled by policy) -- language still
    // applies for this session, it just won't persist across reloads.
  }
});

export default i18next;
