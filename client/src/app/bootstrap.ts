import i18n from "i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { listenSystemMode } from "../utils/darkModeUtils";

let bootstrapped = false;

export function bootstrapApp() {
  if (bootstrapped) {
    return;
  }

  listenSystemMode();

  i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      backend: {
        loadPath: "/locales/{{lng}}/{{ns}}.json",
      },
      fallbackLng: "en",
      interpolation: {
        escapeValue: false,
      },
    });

  // 让 <html lang> 跟随实际语言，读屏软件与搜索引擎都依赖它
  const syncHtmlLang = (lng?: string) => {
    if (lng) {
      document.documentElement.lang = lng;
    }
  };
  i18n.on("languageChanged", syncHtmlLang);
  syncHtmlLang(i18n.resolvedLanguage || i18n.language);

  bootstrapped = true;
}
