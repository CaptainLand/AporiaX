import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export const LANGUAGE_STORAGE_KEY = "aporiax.language.v1";
export const DEFAULT_LANGUAGE = "en";
export const SUPPORTED_LANGUAGES = ["zh-CN", "en"];

const I18nContext = createContext(null);

function interpolate(value, variables = {}) {
  return String(value ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key])
      : match,
  );
}

function readSavedLanguage() {
  const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return SUPPORTED_LANGUAGES.includes(saved) ? saved : DEFAULT_LANGUAGE;
}

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(readSavedLanguage);
  const setLanguage = useCallback((nextLanguage) => {
    if (!SUPPORTED_LANGUAGES.includes(nextLanguage)) return;
    setLanguageState(nextLanguage);
  }, []);
  const tr = useCallback(
    (chinese, english, variables) =>
      interpolate(language === "en" ? english : chinese, variables),
    [language],
  );

  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo(
    () => ({
      language,
      setLanguage,
      isEnglish: language === "en",
      tr,
    }),
    [language, setLanguage, tr],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return context;
}

export function LanguageSwitch({ className = "", compact = false }) {
  const { language, setLanguage, tr } = useI18n();
  return (
    <div
      className={`language-switch ${compact ? "compact" : ""} ${className}`.trim()}
      role="group"
      aria-label={tr("界面语言", "Interface language")}
    >
      <button
        type="button"
        className={language === "zh-CN" ? "active" : ""}
        aria-pressed={language === "zh-CN"}
        onClick={() => setLanguage("zh-CN")}
      >
        中文
      </button>
      <button
        type="button"
        className={language === "en" ? "active" : ""}
        aria-pressed={language === "en"}
        onClick={() => setLanguage("en")}
      >
        English
      </button>
    </div>
  );
}
