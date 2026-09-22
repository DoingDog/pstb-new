// Derived from shadcn-ui/ui new-york-v4/sidebar-11 at 2b3e6d4f8d9161fe5c19340dc383aade392012dd; MIT; see THIRD_PARTY_NOTICES.md.
import * as React from "react";
import { flushSync } from "react-dom";
import { errorMessage, formatDate, labels, resolveBrowserLocale, type Locale } from "../i18n";
import { createPasteApi } from "./api";
import type { InitialPage, TrustedMarkdownHtml } from "./bootstrap";
import type { AppBootstrap, OperationRecords, PasteSummary } from "./contracts";
import { prepareMarkdownPreview, prepareMarkdownVisual, type MarkdownPreview, type PreparedMarkdownVisual } from "./markdown";
import { createStagedSurfaceApply, type DerivedSurface, type StagedSurfaceApply, type SurfaceRollback } from "./surface-apply";
import { createThemeController, type ThemeController, type ThemePreference, type ThemeSnapshot } from "./theme";
import { OperationStatus } from "./components/OperationStatus";
import type { LocalActionState } from "./components/LocalActions";
import { WorkbenchShell } from "./components/WorkbenchShell";
import type { SurfaceFallbackState, TerminalHandoff, TerminalPage } from "./hooks/use-paste-page";

const CreatePage = React.lazy(() => import("./pages/CreatePage").then(({ CreatePage }) => ({ default: CreatePage })));
const PasswordPage = React.lazy(() => import("./pages/PasswordPage").then(({ PasswordPage }) => ({ default: PasswordPage })));
const ErrorPage = React.lazy(() => import("./pages/ErrorPage").then(({ ErrorPage }) => ({ default: ErrorPage })));
const LocalOnlyPastePage = React.lazy(() => import("./pages/LocalOnlyPastePage").then(({ LocalOnlyPastePage }) => ({ default: LocalOnlyPastePage })));
const MarkdownPage = React.lazy(() => import("./pages/MarkdownPage").then(({ MarkdownPage }) => ({ default: MarkdownPage })));
const OrdinaryPage = React.lazy(() => import("./pages/OrdinaryPage").then(({ OrdinaryPage }) => ({ default: OrdinaryPage })));

interface AppProps {
  initialPage: InitialPage;
}

type TerminalLocalRuntime = {
  epoch: number;
  source: string;
  pending: boolean;
  actionAttempt: number | null;
  surface: StagedSurfaceApply;
  previewHost: HTMLDivElement | null;
  mountedSurfaces: Set<DerivedSurface>;
  resources: { preview: unknown; visual: unknown; diff: unknown; generation: number } | null;
  previousResources: { preview: unknown; visual: unknown; diff: unknown; generation: number } | null;
};
type TerminalState = TerminalPage & { local: TerminalLocalRuntime };

function isPreparedMarkdownVisual(value: unknown): value is PreparedMarkdownVisual {
  return typeof HTMLElement !== "undefined" && typeof value === "object" && value !== null
    && "root" in value && value.root instanceof HTMLElement
    && "dispose" in value && typeof value.dispose === "function";
}

function isMarkdownPreview(value: unknown): value is MarkdownPreview {
  return typeof value === "object" && value !== null
    && "source" in value && typeof value.source === "string"
    && "html" in value && typeof value.html === "string";
}

function disposeTerminalResources(resources: TerminalLocalRuntime["resources"], previous: TerminalLocalRuntime["previousResources"] = null): void {
  if (isPreparedMarkdownVisual(resources?.visual)) void resources.visual.dispose();
  if (previous !== resources && isPreparedMarkdownVisual(previous?.visual)) void previous.visual.dispose();
}

function terminalResourcesForRollback(local: TerminalLocalRuntime, rollback: SurfaceRollback) {
  const capture = local.surface.snapshot().capture;
  const expectedParentToken = rollback.failedGeneration === rollback.oldGeneration
    ? capture.parentApplyToken
    : capture.parentApplyToken + 1;
  if (
    capture.currentDisplayGeneration !== rollback.oldGeneration
    || capture.currentExactSource !== rollback.oldSource
    || capture.hostGeneration !== rollback.hostGeneration
    || expectedParentToken !== rollback.parentApplyToken
  ) return { current: null, previous: null };
  const current = local.resources?.generation === rollback.failedGeneration
    ? local.resources
    : null;
  const previous = local.previousResources?.generation === rollback.oldGeneration
    ? local.previousResources
    : null;
  return { current, previous };
}

type SourceInitialPage = {
  ok: true;
  bootstrap: Extract<AppBootstrap, { page: "paste" | "markdown" }>;
  exactSource: string;
  initialMarkdown: TrustedMarkdownHtml | null;
  password: string | null;
};

type OrdinaryInitialPage = SourceInitialPage & {
  bootstrap: Extract<AppBootstrap, { page: "paste"; consumed: false }>;
};

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

function terminalHeading(page: TerminalPage, locale: Locale): string {
  const copy = labels(locale);
  switch (page.phase) {
    case "armed-view-once": return copy.armedViewOnce;
    case "consumed": return copy.consumed;
    case "not-found": return copy.notFound;
    case "delete-uncertain": return copy.deleteUncertain;
  }
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

function sidebarMetadata(initialPage: InitialPage, locale: Locale, terminal: TerminalPage | null, summary: PasteSummary | null) {
  if (terminal !== null || !initialPage.ok) return [];
  const copy = labels(locale);
  const { bootstrap } = initialPage;
  if (bootstrap.page === "paste" && !bootstrap.consumed && summary !== null) {
    return [
      { label: "ID", value: summary.id },
      { label: copy.protected, value: summary.protected ? copy.enabled : copy.notProtected },
      { label: copy.viewOnce, value: summary.viewOnce ? copy.enabled : copy.standard },
      { label: copy.expires, value: summary.expiresAt === null ? copy.permanent : formatDate(locale, summary.expiresAt) },
      { label: copy.size, value: `${summary.contentBytes} ${copy.bytes}` },
      { label: copy.revision, value: String(summary.contentRevision) },
    ];
  }
  if (bootstrap.page === "markdown") return [{ label: "ID", value: bootstrap.id }];
  return [];
}

function isOrdinaryPage(initialPage: InitialPage): initialPage is OrdinaryInitialPage {
  return initialPage.ok && initialPage.bootstrap.page === "paste" && !initialPage.bootstrap.consumed;
}

function operationStatusPageIdentity(initialPage: InitialPage, terminal: TerminalPage | null, rootHandoff: boolean): string {
  if (rootHandoff) return "create";
  if (terminal !== null) return `local:${terminal.phase}`;
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

function Route({ initialPage, locale, create, terminal, rootHandoff, onRecordsChange, onSummaryChange, onTerminal, onLocalAction, onUseConsumedResponse, onKeepCurrent, onTerminalPreviewMounted, onTerminalRetry, onRootHandoff }: {
  initialPage: InitialPage;
  locale: Locale;
  create: ReturnType<typeof createPasteApi>["create"] | null;
  terminal: TerminalState | null;
  rootHandoff: boolean;
  onRecordsChange(records: OperationRecords): void;
  onSummaryChange(summary: PasteSummary | null): void;
  onTerminal(handoff: TerminalHandoff): void;
  onLocalAction(state: LocalActionState): void;
  onUseConsumedResponse(): void;
  onKeepCurrent(): void;
  onTerminalPreviewMounted(host: HTMLDivElement | null): void;
  onTerminalRetry(surface: SurfaceFallbackState["surface"]): void;
  onRootHandoff(): void;
}) {
  if (rootHandoff) return create === null ? null : <CreatePage locale={locale} create={create} />;
  if (terminal !== null) {
    const capture = terminal.local.surface.snapshot().capture;
    const fallback = terminal.local.previewHost !== null
      && terminal.fallback?.surface === "preview"
      && terminal.fallback.source === terminal.source
      && terminal.fallback.generation === capture.currentDisplayGeneration
      && terminal.fallback.hostGeneration === capture.hostGeneration
      ? terminal.fallback
      : null;
    return <LocalOnlyPastePage locale={locale} {...terminal} fallback={fallback} derivedPreview={isMarkdownPreview(terminal.local.resources?.preview) ? terminal.local.resources.preview : null} onUseConsumedResponse={onUseConsumedResponse} onKeepCurrent={onKeepCurrent} onSurfaceMounted={onTerminalPreviewMounted} onRetrySurface={onTerminalRetry} onActionState={onLocalAction} />;
  }
  if (!initialPage.ok) return <ErrorPage locale={locale} status={500} errorCode={initialPage.errorCode} />;

  const { bootstrap } = initialPage;
  switch (bootstrap.page) {
    case "create":
      return create === null ? null : <CreatePage locale={locale} create={create} />;
    case "password":
      return <PasswordPage locale={locale} errorCode={bootstrap.errorCode} />;
    case "error":
      return <ErrorPage locale={locale} status={bootstrap.status} errorCode={bootstrap.errorCode} />;
    case "paste": {
      const sourcePage = initialPage as SourceInitialPage;
      return bootstrap.consumed
        ? <LocalOnlyPastePage locale={locale} phase="consumed" source={sourcePage.exactSource} initialMarkdown={sourcePage.initialMarkdown} onActionState={onLocalAction} />
        : <OrdinaryPage initialPage={sourcePage as OrdinaryInitialPage} locale={locale} onRecordsChange={onRecordsChange} onSummaryChange={onSummaryChange} onTerminal={onTerminal} onRootHandoff={() => { onSummaryChange(null); onRootHandoff(); }} />;
    }
    case "markdown": {
      const sourcePage = initialPage as SourceInitialPage;
      return <MarkdownPage locale={locale} title={bootstrap.title} source={sourcePage.exactSource} initialMarkdown={sourcePage.initialMarkdown!} />;
    }
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
  const [summary, setSummary] = React.useState<PasteSummary | null>(() => isOrdinaryPage(initialPage) ? initialPage.bootstrap.paste : null);
  const [theme, setTheme] = useDocumentTheme();
  const [terminal, setTerminal] = React.useState<TerminalState | null>(null);
  const terminalRef = React.useRef<TerminalState | null>(null);
  const recordsRef = React.useRef(records);
  terminalRef.current = terminal;
  recordsRef.current = records;
  const [rootHandoff, setRootHandoff] = React.useState(false);
  const ordinary = terminal === null && !rootHandoff && isOrdinaryPage(initialPage);
  const needsCreateApi = rootHandoff || (terminal === null && initialPage.ok && initialPage.bootstrap.page === "create");
  const create = React.useMemo(() => needsCreateApi ? createPasteApi({ fetch: globalThis.fetch, crypto: globalThis.crypto }).create : null, [needsCreateApi]);
  const createAttempt = React.useRef(0);
  const createWithAction = React.useCallback(async (...args: Parameters<ReturnType<typeof createPasteApi>["create"]>) => {
    if (create === null) throw new Error("Create API is unavailable");
    const attempt = ++createAttempt.current;
    const startedAt = new Date().toISOString();
    setRecords((records) => ({ ...records, lastAction: { state: "pending", key: "create", attempt, startedAt } }));
    try {
      const result = await create(...args);
      setRecords((records) => records.lastAction.state === "pending" && records.lastAction.key === "create" && records.lastAction.attempt === attempt
        ? {
          ...records,
          lastAction: {
            state: result.ok ? "succeeded" : "failed",
            key: "create",
            attempt,
            startedAt,
            settledAt: new Date().toISOString(),
            outcomeKey: null,
          },
        }
        : records);
      return result;
    } catch (error) {
      setRecords((records) => records.lastAction.state === "pending" && records.lastAction.key === "create" && records.lastAction.attempt === attempt
        ? {
          ...records,
          lastAction: {
            state: "failed",
            key: "create",
            attempt,
            startedAt,
            settledAt: new Date().toISOString(),
            outcomeKey: null,
          },
        }
        : records);
      throw error;
    }
  }, [create]);
  const headingId = "workbench-heading";
  const heading = rootHandoff ? labels(locale).create : terminal === null ? pageHeading(initialPage, locale) : terminalHeading(terminal, locale);
  const copy = labels(locale);

  React.useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    document.title = `${heading} | ${copy.brand}`;
  }, [copy.brand, heading, locale]);

  React.useEffect(() => {
    if (ordinary) return;
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
  }, [ordinary]);

  const createTerminalState = React.useCallback((page: TerminalPage): TerminalState => {
    const local = {} as TerminalLocalRuntime;
    local.epoch = 0;
    local.source = page.source;
    local.pending = false;
    local.actionAttempt = null;
    local.previewHost = null;
    local.mountedSurfaces = new Set();
    local.resources = null;
    local.previousResources = null;
    local.surface = createStagedSurfaceApply({
      capture: {
        localGeneration: 0,
        currentExactSource: page.source,
        currentDisplayGeneration: 0,
        hostGeneration: 0,
        parentApplyGeneration: 0,
        parentApplyToken: 0,
        derivedRetryToken: 0,
      },
      ports: {
        stagePreview: (source) => prepareMarkdownPreview(source),
        stageVisual: async (source, generation) => {
          const visual = await prepareMarkdownVisual(source, document);
          visual.root.dataset.stagedVisual = String(generation);
          return visual;
        },
        stageDiff: () => Promise.resolve(null),
        mounted: () => Array.from(local.mountedSurfaces),
        commit: (staged, generation) => {
          const previous = local.resources;
          local.previousResources = previous;
          local.resources = { ...staged, generation };
          return () => {
            if (isPreparedMarkdownVisual(previous?.visual) && previous.visual !== staged.visual && !previous.visual.root.isConnected) {
              void previous.visual.dispose();
            }
          };
        },
        restoreOld: async (rollback) => {
          const { current, previous } = terminalResourcesForRollback(local, rollback);
          if (current === null || previous === null) return false;
          local.resources = previous;
          return true;
        },
        showOldGenerationFailure: (rollback) => {
          const { current } = terminalResourcesForRollback(local, rollback);
          if (current === null) return;
          local.resources = {
            preview: { kind: "fallback", surface: "preview", source: rollback.oldSource, generation: rollback.oldGeneration },
            visual: { kind: "fallback", surface: "visual", source: rollback.oldSource, generation: rollback.oldGeneration },
            diff: { kind: "fallback", surface: "diff", source: rollback.oldSource, generation: rollback.oldGeneration },
            generation: rollback.oldGeneration,
          };
        },
        disposeAttemptResources: (attempt) => {
          const staged = (attempt as { staged?: Record<string, unknown> }).staged;
          if (isPreparedMarkdownVisual(staged?.visual)) void staged.visual.dispose();
        },
      },
    });
    return { ...page, local };
  }, []);

  React.useEffect(() => () => disposeTerminalResources(terminalRef.current?.local.resources ?? null, terminalRef.current?.local.previousResources ?? null), []);

  const terminalPreviewMounted = React.useCallback((host: HTMLDivElement | null) => {
    const current = terminalRef.current;
    if (current === null || current.local.previewHost === host) return;
    current.local.previewHost = host;
    if (host === null) current.local.mountedSurfaces.delete("preview");
    else current.local.mountedSurfaces.add("preview");
    current.local.surface.remount();
    if (host === null) return;
    const capture = current.local.surface.snapshot().capture;
    setTerminal((page) => page?.local === current.local && page.fallback?.surface === "preview" && page.fallback.source === page.source
      ? { ...page, fallback: { ...page.fallback, generation: capture.currentDisplayGeneration, hostGeneration: capture.hostGeneration } }
      : page);
  }, []);

  const retryTerminalSurface = React.useCallback((surface: SurfaceFallbackState["surface"]) => {
    const current = terminalRef.current;
    const fallback = current?.fallback;
    if (current === null || surface !== "preview" || fallback?.surface !== "preview" || fallback.source !== current.source || current.local.previewHost === null) return;
    const local = current.local;
    const host = local.previewHost;
    const capture = local.surface.snapshot().capture;
    if (
      fallback.source !== local.surface.snapshot().source
      || fallback.generation !== capture.currentDisplayGeneration
      || fallback.hostGeneration !== capture.hostGeneration
    ) return;
    void local.surface.retryPreview(fallback.source).then((applied) => {
      if (!applied) return;
      const latest = local.surface.snapshot().capture;
      setTerminal((page) => page?.local === local
        && page.fallback === fallback
        && local.previewHost === host
        && latest.currentDisplayGeneration === capture.currentDisplayGeneration
        && latest.hostGeneration === capture.hostGeneration
        ? { ...page, fallback: null }
        : page);
    });
  }, []);

  const useConsumedResponse = React.useCallback(() => {
    const current = terminalRef.current;
    if (current === null || current.consumedSource === null || current.local.pending) return;
    const local = current.local;
    const source = current.consumedSource;
    const epoch = local.epoch;
    const displayGeneration = local.surface.snapshot().capture.currentDisplayGeneration;
    const ownsSelection = (): boolean => {
      const latest = terminalRef.current;
      return latest !== null
        && latest.local === local
        && local.epoch === epoch
        && latest.source === local.source
        && latest.consumedSource === source;
    };
    const isCurrent = (): boolean => ownsSelection()
      && local.surface.snapshot().capture.currentDisplayGeneration === displayGeneration;
    if (!isCurrent()) return;

    const instant = new Date().toISOString();
    const attempt = recordsRef.current.lastAction.state === "idle" ? 1 : recordsRef.current.lastAction.attempt + 1;
    local.pending = true;
    local.actionAttempt = attempt;
    setRecords((records) => ({
      ...records,
      lastAction: { state: "pending", key: "use-consumed-response", attempt, startedAt: instant },
    }));
    void local.surface.applyTerminalLocal(source, {
      terminalEpochCurrent: isCurrent(),
      displayGenerationCurrent: isCurrent(),
      selectedSourceCurrent: isCurrent(),
      commitCurrent: isCurrent,
    }).then((receipt) => {
      if (!ownsSelection()) {
        setRecords((records) => records.lastAction.state === "pending" && records.lastAction.key === "use-consumed-response" && records.lastAction.attempt === attempt
          ? {
            ...records,
            lastAction: {
              state: "failed",
              key: "use-consumed-response",
              attempt,
              startedAt: instant,
              settledAt: new Date().toISOString(),
              outcomeKey: "use-consumed-response-display-failed",
            },
          }
          : records);
        return;
      }
      local.pending = false;
      const complete = receipt?.outcome === "complete";
      const outcome = receipt === null
        ? "use-consumed-response-display-failed"
        : local.surface.settleUseConsumedResponse(receipt.terminalLocalToken, complete ? "displayed" : "display-failed")
          ?? "use-consumed-response-display-failed";
      if (complete) {
        local.source = source;
        setTerminal((page) => page?.local === local && local.epoch === epoch && page.consumedSource === source
          ? { ...page, source, consumedSource: null, initialMarkdown: null, fallback: null }
          : page);
      } else if (receipt?.outcome === "fallback" && receipt.fallback !== null) {
        const capture = local.surface.snapshot().capture;
        const fallback = { surface: receipt.fallback, source, generation: capture.currentDisplayGeneration, hostGeneration: capture.hostGeneration };
        setTerminal((page) => page?.local === local && local.epoch === epoch && page.consumedSource === source
          ? { ...page, fallback }
          : page);
      }
      setRecords((records) => records.lastAction.state === "pending" && records.lastAction.key === "use-consumed-response" && records.lastAction.attempt === attempt
        ? {
          ...records,
          lastAction: {
            state: complete ? "succeeded" : "failed",
            key: "use-consumed-response",
            attempt,
            startedAt: instant,
            settledAt: new Date().toISOString(),
            outcomeKey: outcome,
          },
        }
        : records);
    });
  }, []);
  const keepCurrent = React.useCallback(() => {
    const current = terminalRef.current;
    if (current === null) return;
    current.local.epoch += 1;
    current.local.pending = false;
    current.local.surface.invalidate();
    setTerminal((page) => page?.local === current.local ? { ...page, consumedSource: null } : page);
  }, []);
  const enterTerminal = React.useCallback(({ page, records }: TerminalHandoff) => {
    disposeTerminalResources(terminalRef.current?.local.resources ?? null, terminalRef.current?.local.previousResources ?? null);
    flushSync(() => {
      setRecords(records);
      setTerminal(createTerminalState(page));
    });
  }, [createTerminalState]);
  const recordLocalAction = React.useCallback((action: LocalActionState) => {
    setRecords((records) => {
      if (action.state === "pending") {
        return { ...records, lastAction: { state: "pending", key: action.key, attempt: action.attempt, startedAt: action.startedAt } };
      }
      if (
        records.lastAction.state !== "pending"
        || records.lastAction.key !== action.key
        || records.lastAction.attempt !== action.attempt
        || action.settledAt === undefined
      ) return records;
      return {
        ...records,
        lastAction: {
          state: action.state,
          key: action.key,
          attempt: action.attempt,
          startedAt: records.lastAction.startedAt,
          settledAt: action.settledAt,
          outcomeKey: null,
        },
      };
    });
  }, []);

  return (
    <WorkbenchShell
      locale={locale}
      breadcrumb={[copy.paste, heading]}
      headingId={headingId}
      destinationGroups={[{ id: "paste-views", label: copy.pasteViews, destinations: [{ id: "current-document", label: heading, selected: true, headingId }] }]}
      metadata={sidebarMetadata(initialPage, locale, terminal, summary)}
      headerActions={
        <DocumentControls
          locale={locale}
          onLocaleChange={setLocale}
          preference={theme.preference}
          onThemeChange={setTheme}
        />
      }
    >
      <h1 id={headingId} tabIndex={-1}>{heading}</h1>
      <React.Suspense fallback={<p role="status">{heading}</p>}>
        <Route
          initialPage={initialPage}
          locale={locale}
          create={create === null ? null : createWithAction}
          terminal={terminal}
          rootHandoff={rootHandoff}
          onRecordsChange={setRecords}
          onSummaryChange={setSummary}
          onTerminal={enterTerminal}
          onLocalAction={recordLocalAction}
          onUseConsumedResponse={useConsumedResponse}
          onKeepCurrent={keepCurrent}
          onTerminalPreviewMounted={terminalPreviewMounted}
          onTerminalRetry={retryTerminalSurface}
          onRootHandoff={() => setRootHandoff(true)}
        />
      </React.Suspense>
      <OperationStatus locale={locale} pageIdentity={operationStatusPageIdentity(initialPage, terminal, rootHandoff)} records={records} ordinary={ordinary} />
    </WorkbenchShell>
  );
}
