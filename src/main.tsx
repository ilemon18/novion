import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installClientErrorHooks } from "./lib/diagnostics";
import "./index.css";
import { applyDocFont, applyFontSize, applyTheme, useUi } from "./store/ui";
import { applyLocale } from "./i18n";
import { applyPlatform } from "./lib/platform";

// a webview crash must leave a trace on disk, not just a blank window
installClientErrorHooks();

const bootUi = useUi.getState();
applyPlatform();
applyTheme(bootUi.theme, bootUi.palette);
applyFontSize(bootUi.fontSize);
applyDocFont(bootUi.docFont);
applyLocale(bootUi.locale);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);