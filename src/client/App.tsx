// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
import * as React from "react";
import { errorMessage, formatDate, labels, resolveBrowserLocale, type Locale } from "../i18n";
import type { InitialPage } from "./bootstrap";
import type { OperationRecords } from "./contracts";
import { createThemeController, type ThemeController, type ThemePreference, type ThemeSnapshot } from "./theme";
import { OperationStatus } from "./components/OperationStatus";
import { WorkbenchShell } from "./components/WorkbenchShell";

interface AppProps {
  initialPage: InitialPage;
}

function bootstrapLocale(initialPage: InitialPage): Locale {
  return initialPage.ok ? initialPage.bootstrap.locale : initialPage.locale;
}

function pageHeading(initialPage: InitialPage, locale: Locale): string {
  const copy = labels(locale);
  if (!initialPage.ok) return copy.error;
  const { bootstrap } = initialPage;
  switch (bootstrap.page) {
    case "create":
      return copy.create;
    case "paste":
      return bootstrap.consumed ? copy.consumed : bootstrap.paste.title || `${copy.paste} ${bootstrap.paste.id}`;
    case "markdown":
      return bootstrap.title || copy.paste;
    case "password":
      return copy.passwordRequired;
    case "error":
      return errorMessage(locale, bootstrap.errorCode);
    default: {
      const exhaustive: never = bootstrap;
      return exhaustive;
    }
  }
}

function PageContent({ initialPage, locale, headingId }: AppProps & { locale: Locale; headingId: string }) {
  const heading = pageHeading(initialPage, locale);
  if (!initialPage.ok) {
    return (
      <>
        <h1 id={headingId} tabIndex={-1}>{heading}</h1>
        <p role="alert">{errorMessage(locale, initialPage.errorCode)}</p>
      </>
    );
  }

  return <h1 id={headingId} tabIndex={-1}>{heading}</h1>;
}

function initialRecords(): OperationRecords {
  const changedAt = new Date().toISOString();
  return {
    autosave: { state: "clean", confirmedAt: null, failedAt: null },
    autosync: { state: "waiting", stateChangedAt: null, checkedAt: null, appliedAt: null },
    network: { state: navigator.onLine === false ? "offline" : "online", changedAt },
    lastAction: { state: "idle" },
  };
}

function useDocumentTheme(): readonly [ThemeSnapshot, (preference: ThemePreference) => void] {
  const controller = React.useRef<ThemeController | null>(null);
  const [snapshot, setSnapshot] = React.useState<ThemeSnapshot>({ preference: "system", resolved: "light" });

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const next = createThemeController(document.documentElement, media, (resolved) => {
      setSnapshot((current) => ({ ...current, resolved }));
    });
    controller.current = next;
    setSnapshot(next.snapshot());
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, []);

  const setPreference = React.useCallback((preference: ThemePreference) => {
    controller.current?.setPreference(preference);
    const next = controller.current?.snapshot();
    if (next !== undefined) setSnapshot(next);
  }, []);

  return [snapshot, setPreference] as const;
}

function DocumentControls({ locale, onLocaleChange, preference, onThemeChange }: {
  locale: Locale;
  onLocaleChange(locale: Locale): void;
  preference: ThemePreference;
  onThemeChange(preference: ThemePreference): void;
}) {
  const copy = labels(locale);
  return (
    <>
      <label htmlFor="document-locale" className="flex min-w-0 flex-col gap-1 text-xs">
        <span>{copy.locale}</span>
        <select
          id="document-locale"
          className="h-11 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={locale}
          onChange={(event) => onLocaleChange(event.currentTarget.value as Locale)}
        >
          <option value="en">{copy.languageEnglish}</option>
          <option value="zh-CN">{copy.languageChinese}</option>
        </select>
      </label>
      <label htmlFor="document-theme" className="flex min-w-0 flex-col gap-1 text-xs">
        <span>{copy.theme}</span>
        <select
          id="document-theme"
          className="h-11 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={preference}
          onChange={(event) => onThemeChange(event.currentTarget.value as ThemePreference)}
        >
          <option value="system">{copy.themeSystem}</option>
          <option value="light">{copy.themeLight}</option>
          <option value="dark">{copy.themeDark}</option>
        </select>
      </label>
    </>
  );
}

function sidebarMetadata(initialPage: InitialPage, locale: Locale) {
  if (!initialPage.ok) return [];
  const copy = labels(locale);
  const { bootstrap } = initialPage;
  if (bootstrap.page === "paste" && !bootstrap.consumed) {
    return [
      { label: "ID", value: bootstrap.paste.id },
      { label: copy.protected, value: bootstrap.paste.protected ? copy.enabled : copy.notProtected },
      { label: copy.viewOnce, value: bootstrap.paste.viewOnce ? copy.enabled : copy.standard },
      { label: copy.expires, value: bootstrap.paste.expiresAt === null ? copy.permanent : formatDate(locale, bootstrap.paste.expiresAt) },
      { label: copy.size, value: `${bootstrap.paste.contentBytes} ${copy.bytes}` },
      { label: copy.revision, value: String(bootstrap.paste.contentRevision) },
    ];
  }
  if (bootstrap.page === "markdown") return [{ label: "ID", value: bootstrap.id }];
  return [];
}

function isOrdinaryPage(initialPage: InitialPage): boolean {
  return initialPage.ok && initialPage.bootstrap.page === "paste" && !initialPage.bootstrap.consumed;
}

function operationStatusPageIdentity(initialPage: InitialPage): string {
  if (!initialPage.ok) return `error:${initialPage.errorCode}`;
  const { bootstrap } = initialPage;
  switch (bootstrap.page) {
    case "create": return "create";
    case "password": return `password:${bootstrap.errorCode ?? ""}`;
    case "error": return `error:${bootstrap.status}:${bootstrap.errorCode}`;
    case "paste": return bootstrap.consumed ? "paste:consumed" : `paste:${bootstrap.paste.id}`;
    case "markdown": return `markdown:${bootstrap.id}`;
    default: {
      const exhaustive: never = bootstrap;
      return exhaustive;
    }
  }
}

export function App({ initialPage }: AppProps) {
  const documentLocale = bootstrapLocale(initialPage);
  const [locale, setLocale] = React.useState<Locale>(() => resolveBrowserLocale(navigator.languages, documentLocale));
  const [records, setRecords] = React.useState(initialRecords);
  const [theme, setTheme] = useDocumentTheme();
  const headingId = "workbench-heading";
  const heading = pageHeading(initialPage, locale);
  const copy = labels(locale);

  React.useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    document.title = `${heading} | ${copy.brand}`;
  }, [copy.brand, heading, locale]);

  React.useEffect(() => {
    const updateNetwork = (state: "online" | "offline") => {
      setRecords((current) => current.network.state === state ? current : {
        ...current,
        network: { state, changedAt: new Date().toISOString() },
      });
    };
    const online = () => updateNetwork("online");
    const offline = () => updateNetwork("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  return (
    <WorkbenchShell
      locale={locale}
      breadcrumb={[copy.paste, heading]}
      headingId={headingId}
      destinationGroups={[{ id: "paste-views", label: copy.pasteViews, destinations: [{ id: "current-document", label: heading, selected: true, headingId }] }]}
      metadata={sidebarMetadata(initialPage, locale)}
      headerActions={
        <DocumentControls
          locale={locale}
          onLocaleChange={setLocale}
          preference={theme.preference}
          onThemeChange={setTheme}
        />
      }
    >
      <PageContent initialPage={initialPage} locale={locale} headingId={headingId} />
      <OperationStatus locale={locale} pageIdentity={operationStatusPageIdentity(initialPage)} records={records} ordinary={isOrdinaryPage(initialPage)} />
    </WorkbenchShell>
  );
}
