import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import {
  Archive, ArrowDown, ArrowUp, ArrowUpRight, BarChart3, Cloud, Copy, Database, Download,
  Globe2, LayoutDashboard, Maximize2, Minimize2, Moon, Package, Pencil, Plus,
  LogOut, RotateCcw, ScrollText, Search, Sun, Trash2, Upload, Users as UsersIcon, X, Rows3,
  BrainCircuit, CircleStop, Clock3, Cpu, Ellipsis, Play, QrCode as QrCodeIcon, RefreshCw, Scale, Settings2, ShieldCheck, Square,
  Blocks, BookmarkPlus, Bug, FileCode2, LoaderCircle, Gauge, History, KeyRound, Monitor, CircleArrowUp, Star, TriangleAlert,
} from 'lucide-react';
import {
  Alert, AlertDescription, AlertTitle, AuthLayout, Badge, BrandMark, Button, buttonVariants, Card, CardAction,
  ConfirmDialog, DetailRow, EmptyState, StatTile, type StatusTone,
  CardContent, CardFooter, CardHeader,
  CardGrid, Checkbox, cn, DataTable, type DataTableColumn, type DataTableLabels,
  Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Field, GithubMark, initialQuery, Input, Label, MobileNav, PageContainer, PasscodeInput, PasswordInput,
  Skeleton,
  RadioGroup, RadioGroupItem,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarTrigger, Sheet, SheetContent, SheetHeader, SheetTitle, Switch,
  Tabs, TabsContent, TabsList, TabsTrigger, type TableQuery, Toaster, Tooltip,
  TooltipContent, TooltipTrigger, useSidebar, useToast,
} from '../../../packages/ui/src/index.js';
import { failures, logCatalog, translator, type Fail, type Translate } from './i18n.js';
import { browserEnvironment, browserStorage, readPreferences, savePreferences, type LocaleCode, type Preferences } from './preferences.js';
import { authErrorKey } from './auth-error.js';
import { DEFAULT_SILLYTAVERN_PORT, portRefusal } from './ports.js';
import { isThisMachine, readTunnelOfferDeclined, saveTunnelOfferDeclined, shouldOfferManagerTunnel } from './hosting.js';
import { availableUpdate, readDismissedUpdate, saveDismissedUpdate } from './updates.js';
import { apiFetch, onSessionExpired, resetSessionWatch } from './session.js';
import type { AccessGatewayState, BackupManifest, ConfigDocument, ConfigSettings, ConfigSettingsInput, ConfigUpdateInput, Installation, Job, LocalBackupSchedule, LogEntry, LogSourceFilter, MetricsBucket, MetricsSnapshot, PortSettings, ProcessState, Profile, R2CheckResult, R2CloudflareUsage, R2Config, R2ConnectionMode, R2SnapshotSummary, R2UsageResponse, R2UsageWarning, RestoreMode, RestorePreview, StartupSettings, StorageDurabilityReport, SystemSnapshot, TunnelState, VersionOption } from '../../../packages/contracts/src/index.js';
import { BACKUP_KINDS, backupKind, backupSearchText, backupSortValue, formatBytes, type BackupKind, metricsSearchText, metricsSortValue, snapshotSortValue } from '../../../packages/contracts/src/index.js';
import { useLiveLogs } from './use-live-logs.js';
import { translateLogEntry, translateStep } from './log-format.js';
import { QrCode } from './qr-code.js';
import { CLOUDFLARE_ORANGE, CloudflareMark } from './cloudflare-mark.js';
import { localHost, reachableAddresses, shortenHost } from './addresses.js';
import { EmbedStage } from './embed-stage.js';
import { LegalCredit, LegalDialog, LEGAL_REVISION } from './legal-dialog.js';
import { legalBundle, type LegalDocumentId } from '../../../packages/legal/src/index.js';

const navigation = [
  { id: 'overview', icon: LayoutDashboard },
  { id: 'data', icon: Database }, { id: 'metrics', icon: BarChart3 },
  { id: 'config', icon: Settings2 },
] as const;
type PageId = typeof navigation[number]['id'];
type Navigate = (page: PageId) => void;

function pageFromHash(): PageId {
  const hash = window.location.hash.slice(1);
  return navigation.find(({ id }) => id === hash)?.id ?? 'overview';
}

/** What the server's own `validatePassword` accepts, so the form agrees with it. */
const MIN_MANAGER_PASSWORD = 6;
/** The access gateway holds SillyTavern open to a network, and asks for more. */
/**
 * The passcode that opens SillyTavern from outside this machine.
 *
 * Six digits rather than a password, because the public address is a
 * `trycloudflare.com` subdomain and a browser shown a password typed into one of
 * those warns the reader, in red, that they may have handed it to a phishing
 * site. The door is worth less entropy than a password, so the gateway locks
 * globally after five consecutive wrong tries rather than only per address -
 * the trade a phone makes, for the same reason.
 */
const PASSCODE_DIGITS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const UPLOAD_RETRIES = 3;
const UPLOAD_RATE_WINDOW_MS = 10_000;

/**
 * What to say about a reply that was not the JSON this panel expected.
 *
 * An upload passes through whatever sits in front of the manager, and a proxy
 * that gives up answers in its own voice - its own JSON, or an HTML error
 * page. The manager's own refusal is translated; the proxy's words are its
 * own; and a reply with nothing in it at all leaves only the status code.
 */
function apiErrorFromText(text: string, status: number, fallback: string, fail: Fail, proxyHtml: string): string {
  try {
    const payload: unknown = JSON.parse(text);
    const proxyMessage = isRecord(payload) && typeof payload.Message === 'string' ? payload.Message : null;
    return fail.body(payload, proxyMessage ?? `${fallback} (HTTP ${status})`);
  } catch {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/iu.test(text);
    return looksLikeHtml
      ? proxyHtml
      : `${fallback} (HTTP ${status})`;
  }
}

/** Thrown when the operator stops the work themselves, which is not an error. */
class StoppedError extends Error {
  public constructor() { super('stopped'); this.name = 'StoppedError'; }
}

/** A stopped restore that could not be put back, so the profile is left mixed. */
class RollbackFailedError extends Error {
  public constructor(message: string) { super(message); this.name = 'RollbackFailedError'; }
}

/** What a failed chunk should say, in the reader's language rather than this file's. */
interface UploadMessages {
  readonly fail: Fail;
  readonly failed: string;
  readonly proxyPage: string;
}

async function uploadChunkWithRetry(url: string, body: Blob, headers: HeadersInit, messages: UploadMessages, signal?: AbortSignal): Promise<void> {
  let lastError = messages.failed;
  for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new StoppedError();
    let response: Response;
    try {
      response = await apiFetch(url, { method: 'POST', credentials: 'same-origin', headers, body, ...(signal ? { signal } : {}) });
    } catch (error: unknown) {
      if (signal?.aborted) throw new StoppedError();
      lastError = error instanceof Error ? error.message : lastError;
      if (attempt === UPLOAD_RETRIES) throw new Error(lastError);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 500 * (attempt + 1)));
      continue;
    }
    if (response.ok) return;
    const text = await response.text();
    lastError = apiErrorFromText(text, response.status, messages.failed, messages.fail, messages.proxyPage);
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === UPLOAD_RETRIES) throw new Error(lastError);
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 500 * (attempt + 1)));
  }
  throw new Error(lastError);
}

export function App() {
  return <AuthGate />;
}

type AuthMode = 'checking' | 'setup' | 'login' | 'ready';

/**
 * The screen in front of the console, and the one place that owns the session.
 *
 * It also owns the language and the theme. Both used to live inside the
 * console, which meant the first screen anyone sees - a password field, before
 * there is any session to read a preference with - was stuck in whatever
 * language the browser reported, with no way to change it until after signing
 * in. They are set here and handed down.
 */
function AuthGate() {
  const [mode, setMode] = useState<AuthMode>('checking');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [preferences, setPreferences] = useState(() => readPreferences(browserStorage(), browserEnvironment()));
  const t = translator(preferences.locale);
  const changePreferences = (update: Partial<Preferences>) => setPreferences((current) => ({ ...current, ...update }));

  useEffect(() => {
    document.documentElement.classList.toggle('dark', preferences.theme === 'dark');
    document.documentElement.lang = preferences.locale;
    document.documentElement.dataset.theme = preferences.theme;
    savePreferences(preferences, browserStorage());
  }, [preferences]);

  // The console polls the runtime every second and a half. When the session
  // ends it has to be taken down, or those calls go on being refused with
  // nobody reading the refusal and nothing on screen saying why.
  useEffect(() => onSessionExpired(() => {
    setCsrfToken(null);
    setSignedOut(true);
    setMode('login');
  }), []);

  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/v1/setup/status').then(async (response) => response.json() as Promise<{ setupRequired: boolean }>).then(async (status) => {
      if (cancelled) return;
      if (status.setupRequired) { setMode('setup'); return; }
      // The session probe and the sign-in form are the calls where a refusal
      // is an ordinary answer rather than a session running out, so they go
      // straight to `fetch`. Routed through the watch, a first visit would be
      // met by a notice saying the reader had been signed out of something,
      // and a mistyped password would say the same.
      const response = await fetch('/api/v1/auth/session', { credentials: 'same-origin' });
      if (!response.ok) { if (!cancelled) setMode('login'); return; }
      const payload = await response.json() as { session: { csrfToken: string } };
      if (!cancelled) { setCsrfToken(payload.session.csrfToken); setMode('ready'); }
    }).catch(() => { if (!cancelled) setMode('login'); });
    return () => { cancelled = true; };
  }, []);

  /**
   * Leave, deliberately.
   *
   * Without this the only way out was to wait for the session to expire, and
   * the notice that follows an expiry - "you were signed out, sign in again" -
   * is the wrong thing to say to somebody who just pressed Sign out.
   */
  const signOut = async () => {
    await apiFetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin', headers: csrfToken ? { 'x-csrf-token': csrfToken } : {} }).catch(() => undefined);
    resetSessionWatch();
    setSignedOut(false);
    setCsrfToken(null);
    setMode('login');
  };

  const signedIn = (token: string) => {
    // Arm the watch again: the session that expired is not the session now held.
    resetSessionWatch();
    setSignedOut(false);
    setCsrfToken(token);
    setMode('ready');
  };

  // Until the session check answers there is nothing to ask for. Falling
  // through to the form showed a flash of the login screen on every reload of
  // an already signed-in console.
  const waiting = <div className="auth-shell" role="status" aria-busy="true" />;
  const body = mode === 'checking'
    ? waiting
    : mode === 'ready'
      ? csrfToken ? <ConsoleApp csrfToken={csrfToken} preferences={preferences} onPreferencesChange={changePreferences} onSignOut={signOut} /> : waiting
      : <AuthScreen
        t={t}
        mode={mode}
        signedOut={signedOut}
        preferences={preferences}
        onPreferencesChange={changePreferences}
        onSignedIn={signedIn}
      />;

  /*
   * Results are reported from here down, so the provider is here.
   *
   * It used to be inside the console, which meant the console's own handlers -
   * start, stop, remove SillyTavern - got the no-op fallback instead of the
   * real one and reported nothing at all. This is also where the language
   * lives, so the close button is labelled in the reader's language and
   * follows them when they change it.
   */
  return <Toaster closeLabel={t('common.close')}>{body}</Toaster>;
}

function AuthScreen({ t, mode, signedOut, preferences, onPreferencesChange, onSignedIn }: { t: Translate; mode: 'setup' | 'login'; signedOut: boolean; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; onSignedIn: (csrfToken: string) => void }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocumentId>('terms');
  const termsId = useId();
  const setup = mode === 'setup';
  const fail = failures(preferences.locale);
  // Shown once the second field stops being a prefix of the first, rather than
  // the moment the two differ - a mismatch warning under a half-typed password
  // is noise that goes away on its own.
  const mismatch = setup && confirmPassword.length > 0 && !password.startsWith(confirmPassword);
  const ready = password.length >= MIN_MANAGER_PASSWORD
    && (!setup || (accepted && password === confirmPassword));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      // Not `apiFetch`: see the note on the session probe above.
      const response = await fetch(setup ? '/api/v1/setup/password' : '/api/v1/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(setup ? { password, termsAccepted: accepted, telemetryAccepted: accepted } : { password }),
      });
      const payload = await response.json() as { session?: { csrfToken: string }; error?: { code?: string; message?: string } };
      if (!response.ok || !payload.session) {
        const key = authErrorKey(payload.error?.code);
        setError(key ? t(key) : fail.body(payload, t('setup.authError')));
        return;
      }
      onSignedIn(payload.session.csrfToken);
    } catch { setError(t('setup.connectionError')); } finally { setBusy(false); }
  };

  return (
    <AuthLayout
      title={setup ? t('setup.title') : t('setup.loginTitle')}
      subtitle={setup ? t('setup.subtitle') : t('setup.loginSubtitle')}
      // The credit is on both screens. On the first run it answers "what is
      // this and who wrote it?" before anything is typed into it; afterwards
      // it is the fastest way to read off the version a fault report needs.
      footer={<>
        {setup ? <p>{t('setup.telemetryNotice')}</p> : null}
        <LegalCredit t={t} />
      </>}
      controls={<>
        <LanguageControl t={t} preferences={preferences} onChange={onPreferencesChange} />
        <Button variant="ghost" size="icon-sm" className="size-9" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => onPreferencesChange({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
          {preferences.theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </>}
    >
      <Card className="rounded-2xl">
        <CardContent className="p-6">
          <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {signedOut ? <Alert><Clock3 /><AlertDescription>{t('setup.signedOut')}</AlertDescription></Alert> : null}
            <Field label={t('setup.password')} hint={setup ? t('setup.passwordHint') : null}>
              <PasswordInput
                revealLabel={t('setup.reveal')}
                hideLabel={t('setup.hide')}
                autoComplete={setup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={MIN_MANAGER_PASSWORD}
                required
              />
            </Field>
            {setup ? (
              <Field label={t('console.confirmPassword')} error={mismatch ? t('setup.mismatch') : null}>
                <PasswordInput
                  revealLabel={t('setup.reveal')}
                  hideLabel={t('setup.hide')}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </Field>
            ) : null}
            {/* The tick and the text are separate controls on purpose. The
                text is the way into the documents, which is what somebody
                asked to accept terms actually needs; the box beside it is the
                only thing that agrees to them, so reading cannot accidentally
                be consent and consent cannot be given by a stray click. */}
            {setup ? (
              <div className="terms-consent">
                <Checkbox
                  id={termsId}
                  checked={accepted}
                  onCheckedChange={(checked) => setAccepted(checked === true)}
                  aria-label={t('setup.terms')}
                  className="mt-0.5"
                />
                <button
                  type="button"
                  className="terms-text"
                  aria-haspopup="dialog"
                  title={t('setup.termsOpen')}
                  onClick={() => { setLegalDocument('terms'); setLegalOpen(true); }}
                >
                  <span>{t('setup.terms')}</span>
                  <span className="terms-more">{t('setup.termsAction')}<ArrowUpRight /></span>
                </button>
              </div>
            ) : null}
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Button type="submit" size="lg" className="w-full" disabled={busy || !ready}>
              {busy ? t('common.loading') : setup ? t('setup.createAdmin') : t('setup.signIn')}
            </Button>
          </form>
        </CardContent>
      </Card>
      <LegalDialog
        t={t}
        locale={preferences.locale}
        open={legalOpen}
        onOpenChange={setLegalOpen}
        document={legalDocument}
        onDocumentChange={setLegalDocument}
      />
    </AuthLayout>
  );
}

function ConsoleApp({ csrfToken, preferences, onPreferencesChange, onSignOut }: { csrfToken: string; preferences: Preferences; onPreferencesChange: (value: Partial<Preferences>) => void; onSignOut: () => Promise<void> }) {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [version, setVersion] = useState('latest');
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [activeInstallationId, setActiveInstallationId] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupManifest[]>([]);
  const [installing, setInstalling] = useState(false);
  const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(null);
  /** The job behind the install in flight, which is what stopping it asks for. */
  const [installJobId, setInstallJobId] = useState<string | null>(null);
  /** What the manager does with SillyTavern on its own way up. Null until read. */
  const [startup, setStartup] = useState<StartupSettings | null>(null);
  const [logSource, setLogSource] = useState<LogSourceFilter>('all');
  const [logQuery, setLogQuery] = useState('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [compactLogs, setCompactLogs] = useState(false);
  const [processState, setProcessState] = useState<ProcessState>({ status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null });
  const [tunnelState, setTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const [managerTunnelState, setManagerTunnelState] = useState<TunnelState>({ mode: 'off', status: 'stopped', url: null, startedAt: null, error: null });
  const [configDocument, setConfigDocument] = useState<ConfigDocument | null>(null);
  const [portSettings, setPortSettings] = useState<PortSettings | null>(null);
  const [tunnelOfferOpen, setTunnelOfferOpen] = useState(false);
  const [accessSecurity, setAccessSecurity] = useState<AccessGatewayState>({ status: 'stopped', host: null, port: 8001, lan: false, passwordConfigured: false, passcode: false, sessions: 0, error: null });
  const t = translator(preferences.locale);
  const catalog = logCatalog(preferences.locale);
  const fail = failures(preferences.locale);
  const { toast } = useToast();

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const applyMobileDefault = () => { if (media.matches) setCompactLogs(true); };
    applyMobileDefault();
    media.addEventListener('change', applyMobileDefault);
    return () => media.removeEventListener('change', applyMobileDefault);
  }, []);

  useEffect(() => {
    if (!activeInstallationId) { setConfigDocument(null); return undefined; }
    let cancelled = false;
    const load = async () => {
      const response = await apiFetch('/api/v1/config', { credentials: 'same-origin' });
      if (response.ok && !cancelled) setConfigDocument(await response.json() as ConfigDocument);
    };
    void load();
    return () => { cancelled = true; };
  }, [activeInstallationId]);

  /*
   * Offer the console's own link once, on a platform where its address may not
   * be one that works.
   *
   * Waits for the first answer about the tunnel rather than asking on the
   * strength of the state's initial value, which says "off" before anything has
   * been read and would put the dialog in front of somebody who already has it
   * open. Once asked, it is not asked again: closing it remembers that.
   */
  const managerTunnelMode = managerTunnelState.mode;
  const [tunnelAnswered, setTunnelAnswered] = useState(false);
  useEffect(() => {
    if (!tunnelAnswered) return;
    if (!shouldOfferManagerTunnel({ hostname: window.location.hostname, tunnelWanted: managerTunnelMode !== 'off', declined: readTunnelOfferDeclined(browserStorage()) })) return;
    setTunnelOfferOpen(true);
  }, [tunnelAnswered, managerTunnelMode]);

  // Not tied to an installation: which ports this manager holds is true before
  // anything is installed, and the page that shows them says so either way.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const response = await apiFetch('/api/v1/config/port', { credentials: 'same-origin' });
      if (response.ok && !cancelled) setPortSettings(await response.json() as PortSettings);
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [processResponse, tunnelResponse, managerTunnelResponse, securityResponse] = await Promise.all([
        apiFetch('/api/v1/process', { credentials: 'same-origin' }),
        apiFetch('/api/v1/tunnel', { credentials: 'same-origin' }),
        apiFetch('/api/v1/manager-tunnel', { credentials: 'same-origin' }),
        apiFetch('/api/v1/access/security', { credentials: 'same-origin' }),
      ]);
      if (cancelled) return;
      if (processResponse.ok) setProcessState(await processResponse.json() as ProcessState);
      if (tunnelResponse.ok) setTunnelState(await tunnelResponse.json() as TunnelState);
      if (managerTunnelResponse.ok) { setManagerTunnelState(await managerTunnelResponse.json() as TunnelState); setTunnelAnswered(true); }
      if (securityResponse.ok) setAccessSecurity(await securityResponse.json() as AccessGatewayState);
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = pageFromHash();
      const hash = window.location.hash.slice(1);
      if (hash && hash !== next) window.history.replaceState(null, '', `#${next}`);
      setPage(next);
    };
    onHashChange();
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiFetch('/api/v1/versions', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ versions: VersionOption[] }> : null),
      apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null; activeJob: Job | null }> : null),
      apiFetch('/api/v1/profiles', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ profiles: Profile[]; activeProfileId: string | null }> : null),
      apiFetch('/api/v1/backups', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ backups: BackupManifest[] }> : null),
      apiFetch('/api/v1/startup', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ startup: StartupSettings }> : null),
    ]).then(([versionPayload, installationPayload, profilePayload, backupPayload, startupPayload]) => {
      if (cancelled) return;
      if (startupPayload) setStartup(startupPayload.startup);
      if (versionPayload) setVersions(versionPayload.versions);
      if (installationPayload) {
        setInstallations(installationPayload.installations);
        setActiveInstallationId(installationPayload.activeInstallationId);
        /*
         * An install already running that this page did not start.
         *
         * Two ways that happens: the page was reloaded during one, and a
         * manager that had just been set up installed SillyTavern by itself.
         * Adopting it is what makes the progress on the card belong to
         * something - and gives the reader the button that stops it.
         */
        if (installationPayload.activeJob) {
          setInstalling(true);
          setPendingInstallationId(installationPayload.activeJob.installationId);
          setInstallJobId(installationPayload.activeJob.id);
        }
      }
      if (profilePayload) { setProfiles(profilePayload.profiles); setActiveProfileId(profilePayload.activeProfileId); }
      if (backupPayload) setBackups(backupPayload.backups);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  /*
   * The backup list, kept current without being asked.
   *
   * Archives appear without anybody pressing anything - the schedule, the
   * safety copy a restore or a profile switch takes, a copy that became an
   * automatic backup - and the list used to show them only after a reload or
   * a trip to another page and back. The list is the manager's own file, read
   * from memory, so asking every few seconds costs nothing worth saving; it is
   * skipped while the tab is hidden, and a reply identical to what is on
   * screen changes nothing.
   */
  useEffect(() => {
    let cancelled = false;
    let last = '';
    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await apiFetch('/api/v1/backups', { credentials: 'same-origin' });
        if (!response.ok || cancelled) return;
        const text = await response.text();
        if (cancelled || text === last) return;
        last = text;
        setBackups((JSON.parse(text) as { backups: BackupManifest[] }).backups);
      } catch {
        // The next poll tries again.
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 4000);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    if (!installing) return undefined;
    if (!pendingInstallationId) return undefined;
    const timer = window.setInterval(() => {
      void apiFetch(`/api/v1/installations/${pendingInstallationId}`, { credentials: 'same-origin' }).then(async (response) => {
        // A stopped install takes its own record away with everything else it
        // wrote, so the row this was watching is simply not there any more.
        // Without this the console sat on "Installing" for as long as it was
        // left open, over a machine on which nothing was being installed.
        if (response.status === 404) return 'gone' as const;
        return response.ok ? await response.json() as Installation : null;
      }).then((installation) => {
        if (installation === 'gone') {
          setInstalling(false);
          setPendingInstallationId(null);
          setInstallJobId(null);
          setInstallations((current) => current.filter((item) => item.id !== pendingInstallationId));
          void apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
            if (!payload) return;
            setInstallations(payload.installations);
            setActiveInstallationId(payload.activeInstallationId);
          }).catch(() => undefined);
          return;
        }
        if (!installation) return;
        setInstallations((current) => [...current.filter((item) => item.id !== installation.id), installation]);
        if (installation.status === 'ready' || installation.status === 'failed') {
          setInstalling(false);
          setInstallJobId(null);
          // Keep the pending id so the just-finished result stays visible.
          // Refresh the active pointer after the runtime switches atomically.
          void apiFetch('/api/v1/installations', { credentials: 'same-origin' }).then(async (response) => response.ok ? response.json() as Promise<{ installations: Installation[]; activeInstallationId: string | null }> : null).then((payload) => {
            if (!payload) return;
            setInstallations(payload.installations);
            setActiveInstallationId(payload.activeInstallationId);
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [installing, pendingInstallationId]);

  /**
   * Stop the install that is running, and let the server take back what it wrote.
   *
   * The answer is not waited for here beyond the request being accepted: what
   * happens next is the same polling that was already watching the install,
   * which sees the record go and clears the card.
   */
  const cancelInstall = async (): Promise<void> => {
    if (!installJobId || !csrfToken) return;
    await apiFetch(`/api/v1/jobs/${encodeURIComponent(installJobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
  };

  /** Whether SillyTavern comes up with the manager. Reported back so the switch can go back. */
  const setAutoStartSillyTavern = async (enabled: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/startup', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ autoStartSillyTavern: enabled }) });
    const payload = await response.json() as { startup?: StartupSettings; error?: { message?: string } };
    if (!response.ok || !payload.startup) return fail.body(payload, t('console.startupSaveFailed'));
    setStartup(payload.startup);
    return null;
  };

  const navigate: Navigate = (next) => { window.location.hash = next; setPage(next); window.scrollTo({ top: 0 }); };
  const changePreferences = onPreferencesChange;
  const liveLogs = useLiveLogs(logSource);
  /*
   * Whether anything has arrived in the log since it was last looked at.
   *
   * The first batch is whatever was already in the buffer when the page
   * opened, not news, so the mark starts at the newest line of it; only what
   * comes after that lights the dot. While the sheet is open the mark keeps
   * up with the tail, so closing it always leaves the dot clear.
   */
  const [seenLogId, setSeenLogId] = useState<number | null>(null);
  const newestLogId = liveLogs.entries.at(-1)?.id ?? null;
  useEffect(() => {
    if (newestLogId === null) return;
    if (seenLogId === null || logsExpanded) setSeenLogId(newestLogId);
  }, [newestLogId, logsExpanded, seenLogId]);
  const hasNewLogs = seenLogId !== null && newestLogId !== null && newestLogId > seenLogId;
  const { snapshot: systemSnapshot, remeasure } = useSystemSnapshot(csrfToken);
  const updateRuntime = async (path: string, body?: unknown) => {
    const init: RequestInit = { method: body === undefined ? 'POST' : 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await apiFetch(path, init);
    if (!response.ok) {
      toast({ title: fail.body(await response.json().catch(() => null), t('console.actionFailed')), tone: 'destructive' });
      return;
    }
    const payload = await response.json() as ProcessState | TunnelState;
    if (path.includes('/process')) { setProcessState(payload as ProcessState); reportProcess(payload as ProcessState); }
    else { setTunnelState(payload as TunnelState); reportTunnel(payload as TunnelState); }
  };

  /*
   * Say what actually happened, not what was asked for.
   *
   * Both of these requests answer with the state they ended in - start waits
   * for SillyTavern to respond before it replies - so the confirmation can be
   * read off that rather than assumed from the button that was pressed. A
   * version that said "Started" whatever came back would be lying on the one
   * occasion the reader most needs the truth.
   */
  const reportProcess = (state: ProcessState) => {
    if (state.status === 'running') toast({ title: t('console.startDone'), tone: 'success' });
    else if (state.status === 'stopped') toast({ title: t('console.stopDone'), tone: 'success' });
    else if (state.status === 'error') toast({ title: fail.of(state.errorCode, state.error, t('console.heroFailed')), tone: 'destructive' });
  };
  const reportTunnel = (state: TunnelState) => {
    if (state.error) { toast({ title: state.error, tone: 'destructive' }); return; }
    // The address is the whole point of turning it on, so it comes with the
    // confirmation rather than only in the card behind it.
    if (state.url) toast({ title: t('console.tunnelOnDone'), description: state.url, tone: 'success' });
    else if (state.mode === 'off') toast({ title: t('console.tunnelOffDone'), tone: 'success' });
  };
  const activeInstallation = installations.find((item) => item.id === pendingInstallationId) ?? installations.find((item) => item.id === activeInstallationId) ?? installations.at(-1);
  /*
   * The version select opens on the version that is installed.
   *
   * It used to open on "latest" whatever was on the disk, so a machine pinned
   * to an older release presented the newest one as the current choice, and
   * the Install button beside it looked like it would reinstall what was
   * already there. The ref is what is matched on, not the name of the option:
   * "latest" moves, so an installed copy is only that option while the option
   * still points at it, and otherwise the pinned entry for that ref is the
   * honest answer. Keyed on the installed ref, so choosing a different version
   * to install is not undone by the next poll.
   */
  const installedRef = activeInstallation?.status === 'ready' ? activeInstallation.resolvedRef : null;
  useEffect(() => {
    if (installedRef === null) return;
    const pinned = versions.find((option) => option.ref === installedRef && option.selector !== 'latest' && option.selector !== 'release');
    const moving = versions.find((option) => option.ref === installedRef);
    setVersion(pinned?.selector ?? moving?.selector ?? activeInstallation?.selector ?? 'latest');
    // The installed ref is the only thing that should move this control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installedRef, versions]);
  const removeInstallation = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/installations', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    if (!response.ok) {
      const payload = await response.json() as { error?: { message?: string } };
      return fail.body(payload, t('console.uninstallFailed'));
    }
    setInstallations([]);
    setActiveInstallationId(null);
    setPendingInstallationId(null);
    toast({ title: t('console.uninstallDone'), tone: 'success' });
    return null;
  };
  // Where SillyTavern actually is, for every link that points at it. The config
  // document reports it too, but it is null until something is installed and
  // the addresses are shown before that.
  const sillyTavernPort = portSettings?.port ?? configDocument?.settings.port ?? DEFAULT_SILLYTAVERN_PORT;
  const logProps = { t, catalog, source: logSource, onSourceChange: setLogSource, entries: liveLogs.entries, query: logQuery, onQueryChange: setLogQuery, compact: compactLogs, onToggleCompact: () => setCompactLogs((current) => !current), onLoadOlder: liveLogs.loadOlder, hasOlder: liveLogs.hasOlder, loadingOlder: liveLogs.loadingOlder };
  const logs = <LogsPanel {...logProps} expanded={logsExpanded} onToggleExpanded={() => setLogsExpanded((current) => !current)} />;
  const updateConfig = async (input: ConfigUpdateInput): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(input) });
    const payload = await response.json() as { config?: ConfigDocument; process?: ProcessState; tunnel?: TunnelState; error?: { message?: string } };
    if (!response.ok || !payload.config) return fail.body(payload, t('console.configSaveFailed'));
    setConfigDocument(payload.config);
    if (payload.process) setProcessState(payload.process);
    if (payload.tunnel) setTunnelState(payload.tunnel);
    return null;
  };
  const resetConfig = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config/reset', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    const payload = await response.json() as { config?: ConfigDocument; process?: ProcessState; tunnel?: TunnelState; error?: { message?: string } };
    if (!response.ok || !payload.config) return fail.body(payload, t('console.configSaveFailed'));
    setConfigDocument(payload.config);
    if (payload.process) setProcessState(payload.process);
    if (payload.tunnel) setTunnelState(payload.tunnel);
    return null;
  };
  /**
   * Move SillyTavern to another port.
   *
   * The server restarts it as part of the change, so the process state comes
   * back with the answer and is adopted here rather than waited for: until it
   * does, the page would show SillyTavern as running on a port it has left.
   */
  const updateSillyTavernPort = async (port: number): Promise<string | null> => {
    const response = await apiFetch('/api/v1/config/port', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ port }) });
    const payload = await response.json() as { port?: number; process?: ProcessState; error?: { message?: string } };
    const saved = payload.port;
    if (!response.ok || typeof saved !== 'number') return fail.body(payload, t('console.portSaveFailed'));
    setPortSettings((current) => current ? { ...current, port: saved } : current);
    if (payload.process) setProcessState(payload.process);
    // The file now says the new port, and the settings card reads it from there.
    const configResponse = await apiFetch('/api/v1/config', { credentials: 'same-origin' });
    if (configResponse.ok) setConfigDocument(await configResponse.json() as ConfigDocument);
    return null;
  };
  /**
   * Open or close the console's own public link.
   *
   * Nothing is navigated here. The address takes a moment to arrive - the
   * switch reports "starting" until cloudflared announces it - and moving the
   * reader to a link that does not exist yet would land them on nothing.
   */
  const setManagerTunnel = async (on: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/manager-tunnel', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: on ? 'quick' : 'off' }) });
    const payload = await response.json() as TunnelState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.managerTunnelFailed'));
    setManagerTunnelState(payload);
    return null;
  };
  const setAccessPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.passwordSaveFailed'));
    setAccessSecurity(payload);
    toast({ title: t('console.passwordSaved'), tone: 'success' });
    return null;
  };
  const setAccessLan = async (lan: boolean): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/network', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ lan }) });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.configSaveFailed'));
    setAccessSecurity(payload);
    return null;
  };
  const signOutAccessDevices = async (): Promise<string | null> => {
    const response = await apiFetch('/api/v1/access/sessions', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
    const payload = await response.json() as AccessGatewayState & { error?: { message?: string } };
    if (!response.ok) return fail.body(payload, t('console.actionFailed'));
    setAccessSecurity(payload);
    toast({ title: t('console.signOutDevicesDone'), tone: 'success' });
    return null;
  };
  const changeManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const response = await apiFetch('/api/v1/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ password, confirmPassword }) });
    const payload = await response.json() as { error?: { message?: string } };
    return response.ok ? null : fail.body(payload, t('console.managerPasswordSaveFailed'));
  };
  const hero = <RuntimeCard
    t={t}
    fail={fail}
    catalog={catalog}
    process={processState}
    tunnel={tunnelState}
    security={accessSecurity}
    sillyTavernPort={sillyTavernPort}
    networkHost={configDocument?.networkHost ?? null}
    installed={Boolean(activeInstallationId)}
    installing={installing}
    canCancelInstall={installJobId !== null}
    onCancelInstall={cancelInstall}
    active={activeInstallation}
    dataBytes={systemSnapshot?.storage.dataBytes ?? null}
    profileName={profiles.find((profile) => profile.id === activeProfileId)?.name ?? null}
    version={version}
    onVersionChange={setVersion}
    versions={versions}
    onPendingInstallationId={setPendingInstallationId}
    csrfToken={csrfToken}
    onInstalling={setInstalling}
    onInstallJob={setInstallJobId}
    onRemove={removeInstallation}
    onStart={() => updateRuntime('/api/v1/process/start')}
    onStop={() => updateRuntime('/api/v1/process/stop')}
    onSetPassword={setAccessPassword}
    onPublish={() => updateRuntime('/api/v1/tunnel', { mode: 'quick' })}
    onShowAddresses={() => { document.querySelector('[data-tour="remote-access"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
    onOpenSettings={() => navigate('config')}
  />;

  return (
    <>
      <SidebarProvider style={{ '--sidebar-width': '15rem', '--sidebar-width-icon': '3.75rem' } as CSSProperties}>
        <AppSidebar page={page} navigate={navigate} t={t} />
        <SidebarInset className="min-w-0">
          <header className="site-header">
            <div className="site-header-inner">
              {/* The trigger is desktop-only: below `md` the destinations are
                  along the bottom of the screen, where a thumb already is. */}
              <SidebarTrigger label={t('console.toggleNavigation')} className="-ml-1 hidden size-8 shrink-0 md:inline-flex" />
              <BrandMark size={26} className="md:hidden" />
              <h1>{t(`nav.${page}`)}</h1>
              <div className="-mr-1 ml-auto flex shrink-0 items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="log-header-button"
                  aria-label={hasNewLogs ? `${t('console.openLogs')} · ${t('console.newLogs')}` : undefined}
                  onClick={() => setLogsExpanded(true)}
                ><ScrollText />{t('console.openLogs')}{hasNewLogs ? <span className="log-new-dot" aria-hidden="true" /> : null}</Button>
                <LanguageControl t={t} preferences={preferences} onChange={changePreferences} />
                <Button variant="ghost" size="icon-sm" aria-label={preferences.theme === 'dark' ? t('console.useLight') : t('console.useDark')} onClick={() => changePreferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' })}>
                  {preferences.theme === 'dark' ? <Sun /> : <Moon />}
                </Button>
              </div>
            </div>
          </header>
          <PageContainer>
            {page === 'overview' ? <div className="grid min-w-0 gap-(--section-gap)">{hero}<AccessPanel t={t} process={processState} tunnel={tunnelState} config={configDocument} security={accessSecurity} sillyTavernPort={sillyTavernPort} onAction={updateRuntime} onSetLan={setAccessLan} onSetPassword={setAccessPassword} /><CardGrid columns={2}><DataPanel t={t} navigate={navigate} latestBackup={backups.at(-1) ?? null} snapshot={systemSnapshot} onRemeasure={remeasure} /><SystemPanel t={t} snapshot={systemSnapshot} />{logs}</CardGrid></div> : page === 'data' ? <DataPage t={t} locale={preferences.locale} fail={fail} catalog={catalog} csrfToken={csrfToken} profiles={profiles} activeProfileId={activeProfileId} backups={backups} onProfilesChange={(next, active) => { setProfiles(next); setActiveProfileId(active); }} onBackupsChange={setBackups} /> : page === 'metrics' ? <MetricsPage t={t} /> : page === 'config' ? <ConfigPage t={t} locale={preferences.locale} config={configDocument} security={accessSecurity} ports={portSettings} managerTunnel={managerTunnelState} onSetManagerTunnel={setManagerTunnel} startup={startup} onSetAutoStart={setAutoStartSillyTavern} onPortChange={updateSillyTavernPort} onConfigUpdate={updateConfig} onConfigReset={resetConfig} process={processState} catalog={catalog} onChangeManagerPassword={changeManagerPassword} onSetPassword={setAccessPassword} onSignOut={onSignOut} onSignOutDevices={signOutAccessDevices} /> : <ResourcePanel page={page} t={t} />}
          </PageContainer>
          <MobileNav
            items={navigation.map(({ id, icon }) => ({ id, icon, href: `#${id}`, label: t(`nav.${id}`) }))}
            current={page}
            onNavigate={(id) => navigate(id as PageId)}
            label={t('console.navigation')}
          />
        </SidebarInset>
        <LogsSheet {...logProps} open={logsExpanded} onClose={() => setLogsExpanded(false)} />
      </SidebarProvider>
      <ManagerTunnelOffer
        t={t}
        open={tunnelOfferOpen}
        hostname={window.location.hostname}
        tunnel={managerTunnelState}
        onDecline={() => { setTunnelOfferOpen(false); saveTunnelOfferDeclined(browserStorage()); }}
        onAccept={setManagerTunnel}
      />
    </>
  );
}

/**
 * The offer to open the console's own link, on a platform where its address
 * may not be one that works.
 *
 * It stays open after the switch is thrown, because the address does not exist
 * yet at that moment - cloudflared takes a few seconds to announce it - and
 * the whole point of the offer is to hand the reader that address. So the
 * dialog becomes the place it arrives, with a button that moves there.
 */
function ManagerTunnelOffer({ t, open, hostname, tunnel, onDecline, onAccept }: { t: Translate; open: boolean; hostname: string; tunnel: TunnelState; onDecline: () => void; onAccept: (on: boolean) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true); setError(null);
    try { setError(await onAccept(true)); } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onDecline(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t('console.tunnelOfferTitle')}</DialogTitle>
        <DialogDescription>{t('console.tunnelOfferBody', { host: hostname })}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t('console.tunnelOfferNote')}</p>
        {tunnel.proxyUrl ?? tunnel.url
          ? <code className="break-all rounded-lg border bg-muted/40 p-3 font-mono text-sm">{tunnel.proxyUrl ?? tunnel.url}</code>
          : tunnel.mode !== 'off'
            ? <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" role="status"><span className="thinking">{t('console.tunnelOfferOpening')}</span><TaskBar /></div>
            : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDecline}>{tunnel.url ? t('common.close') : t('console.tunnelOfferDecline')}</Button>
        {tunnel.proxyUrl ?? tunnel.url
          ? <Button asChild><a href={(tunnel.proxyUrl ?? tunnel.url)!} target="_blank" rel="noopener noreferrer"><ArrowUpRight />{t('console.tunnelOfferOpen')}</a></Button>
          : <Button disabled={busy || tunnel.mode !== 'off'} onClick={() => void accept()}>{busy ? <LoaderCircle className="animate-spin" /> : null}{t('console.tunnelOfferAccept')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function AppSidebar({ page, navigate, t }: { page: PageId; navigate: Navigate; t: Translate }) {
  const { setOpenMobile, isMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon" mobileTitle={t('console.navigation')}>
      <SidebarHeader className="brand-header">
        <a href="#overview" aria-label="SillyTavern Manager" className="brand" onClick={() => setOpenMobile(false)}>
          <BrandMark size={28} />
          <span className="truncate group-data-[collapsible=icon]:hidden">ST Manager</span>
        </a>
        {isMobile ? <Button variant="ghost" size="icon" className="ml-auto shrink-0" aria-label={t('console.closeNavigation')} onClick={() => setOpenMobile(false)}><X /></Button> : null}
      </SidebarHeader>
      <SidebarContent><SidebarGroup><SidebarGroupContent><nav aria-label={t('console.navigation')}><SidebarMenu>{navigation.map(({ id, icon: Icon }) => <SidebarMenuItem key={id}><SidebarMenuButton asChild isActive={page === id} tooltip={t(`nav.${id}`)} className="h-11 gap-3 px-3 text-sm md:h-10 group-data-[collapsible=icon]:size-11! group-data-[collapsible=icon]:p-3!"><a href={`#${id}`} aria-current={page === id ? 'page' : undefined} aria-label={t(`nav.${id}`)} onClick={() => { navigate(id); setOpenMobile(false); }}><Icon className="size-4" /><span>{t(`nav.${id}`)}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></nav></SidebarGroupContent></SidebarGroup></SidebarContent>
    </Sidebar>
  );
}

/**
 * Which language is on, and one press to change it.
 *
 * This was a pair of buttons in a bordered track, which made it the tallest
 * thing in a header of 32px controls and read as a setting with two answers
 * when there are only ever two and one of them is already in force. The
 * button shows the language being read; pressing it says so in the other.
 */
function LanguageControl({ t, preferences, onChange }: { t: Translate; preferences: Preferences; onChange: (value: Partial<Preferences>) => void }) {
  const next: LocaleCode = preferences.locale === 'vi' ? 'en' : 'vi';
  const label = t(next === 'vi' ? 'console.switchToVietnamese' : 'console.switchToEnglish');
  return <Button
    variant="outline"
    size="icon-sm"
    className="language-toggle"
    aria-label={label}
    title={label}
    onClick={() => onChange({ locale: next })}
  >{preferences.locale.toUpperCase()}</Button>;
}

function PanelHeading({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return <CardHeader><h2 className="panel-title">{icon}{children}</h2>{action ? <CardAction>{action}</CardAction> : null}</CardHeader>;
}

/**
 * A state, said in a word and in a colour, wherever a state is reported.
 *
 * The dot is never the only carrier: the word beside it always says the same
 * thing, because a colour alone is no use to a reader who cannot separate
 * green from amber and no use at all to a screen reader. The colours are the
 * semantic ones - green for up, amber for needs-attention, the accent for work
 * in progress - rather than the accent doing all three jobs.
 */
function StatePill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`state-pill state-pill-${tone}`}>
    <span aria-hidden="true" className="state-dot" />
    {children}
  </span>;
}

/**
 * A still of SillyTavern's layout, drawn rather than photographed.
 *
 * Deliberately a placeholder and not a screenshot: there is no headless
 * browser here to photograph the real thing, and a stale picture of somebody
 * else's chat would be worse than an honest diagram. What it carries is the
 * shape - characters down the left, the conversation in the middle, the
 * generation settings on the right - which is enough to recognise what is
 * behind the button sitting on top of it.
 */
interface PreviewManifest {
  readonly background: string | null;
  readonly theme: {
    readonly text: string | null; readonly quote: string | null; readonly tint: string | null;
    readonly userTint: string | null; readonly botTint: string | null; readonly border: string | null;
    readonly chatWidth: number | null;
  } | null;
  readonly recent: readonly { readonly name: string; readonly avatar: string | null; readonly at: string }[];
}

/** The width the still is drawn at before it is scaled into whatever box it gets. */
const STILL_WIDTH = 640;

/**
 * SillyTavern's own front page, redrawn small.
 *
 * Not a screenshot - there is no headless browser here to take one - but not a
 * generic drawing either: the wallpaper, the theme colours and the characters
 * in the Recent Chats list are the reader's own, read off their profile. What
 * is invented is only the shape, and the shape is the one SillyTavern actually
 * opens with: nine icons along the top, both side drawers shut, a single
 * column of chat down the middle at the width they set, the recent list, and
 * the assistant's greeting under it.
 *
 * Drawn at a fixed size and scaled into its box, so the proportions stay right
 * at any width instead of reflowing into a layout SillyTavern never has. The
 * message bodies are blank bars because no chat file is ever read to draw
 * this - a picture on a dashboard is not worth opening conversations for.
 */
function SillyTavernStill({ generation }: { generation: string }) {
  const [manifest, setManifest] = useState<PreviewManifest | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);
  // Read once per run of SillyTavern. None of it changes while it is up, and
  // the wallpaper is a megabyte nobody needs fetched on a timer.
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch('/api/v1/preview', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => response.ok ? await response.json() as PreviewManifest : null)
      .then((payload) => { if (payload && !controller.signal.aborted) setManifest(payload); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [generation]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    const fit = () => { if (element.clientWidth > 0) setScale(element.clientWidth / STILL_WIDTH); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const image = (kind: 'background' | 'avatar' | 'logo', name?: string) =>
    name === undefined
      ? `/api/v1/preview/image?kind=${kind}`
      : `/api/v1/preview/image?kind=${kind}&name=${encodeURIComponent(name)}`;
  const theme = manifest?.theme ?? null;
  const rows = manifest?.recent ?? [];
  const width = theme?.chatWidth ?? 50;
  const style = {
    '--st-text': theme?.text ?? 'rgba(220, 224, 232, 1)',
    '--st-quote': theme?.quote ?? 'rgba(165, 140, 115, 1)',
    '--st-tint': theme?.tint ?? 'rgba(30, 30, 36, 0.85)',
    '--st-bot-tint': theme?.botTint ?? 'rgba(34, 30, 32, 0.75)',
    '--st-border': theme?.border ?? 'rgba(80, 80, 80, 0.89)',
    '--st-column': `${Math.max(30, Math.min(92, width))}%`,
    transform: `scale(${scale})`,
  } as CSSProperties;

  return <div className="st-still" ref={frame} aria-hidden="true">
    {manifest?.background ? <img className="st-still-bg" src={image('background', manifest.background)} alt="" /> : null}
    {/*
      * One column, the width SillyTavern is set to, running the whole height
      * of the window - the toolbar is the top of that column rather than a
      * band across the window, and the wallpaper shows either side of it and
      * through the empty part of the conversation below.
      */}
    <div className="st-still-scale" style={style}>
      <div className="st-still-column">
        <div className="st-still-top">{Array.from({ length: 9 }, (_, index) => <i key={index} />)}</div>
        <div className="st-still-panel">
          <div className="st-still-head">
            <img className="st-still-logo" src={image('logo')} alt="" />
            <b />
            <span className="st-still-chips"><i /><i /><i /><i /></span>
          </div>
          <span className="st-still-section" />
          {[0, 1, 2].map((index) => {
            const row = rows[index];
            return <div key={index} className="st-still-recent">
              {row?.avatar ? <img src={image('avatar', row.avatar)} alt="" /> : <i className="st-still-blank" />}
              <span className="st-still-lines">
                <b style={{ width: `${40 + index * 14}%` }} />
                <u style={{ width: `${86 - index * 11}%` }} />
              </span>
            </div>;
          })}
          <span className="st-still-more" />
        </div>
        <div className="st-still-message">
          <img className="st-still-avatar" src={image('logo')} alt="" />
          <span className="st-still-lines">
            <b style={{ width: '34%' }} />
            <u style={{ width: '82%' }} />
            <u style={{ width: '58%' }} />
          </span>
        </div>
        <div className="st-still-actions"><i /><i /><i /></div>
        <div className="st-still-gap" />
        <div className="st-still-foot">
          <span className="st-still-links"><i /><i /><i /></span>
          <em />
        </div>
      </div>
    </div>
  </div>;
}

function Unavailable({ t, children }: { t: Translate; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="inline-flex rounded-md" aria-label={t('console.unavailable')}>{children}</span></TooltipTrigger><TooltipContent>{t('console.unavailable')}</TooltipContent></Tooltip>;
}

/**
 * The card the overview opens with, and everything about the running copy.
 *
 * The page used to begin with a status banner, and then, three cards later,
 * offer a version select in a card of its own headed "SillyTavern" - so the
 * thing that says whether SillyTavern is up and the thing that decides which
 * SillyTavern is up were separated by two unrelated cards. Both are here: the
 * state at the top, what it is running underneath it, and the preview of the
 * thing itself beside them.
 *
 * Start is a plain button; Stop is a destructive one and asks first, because
 * whoever is reading a chat through the public link is not in the room to be
 * consulted, and because the colour is the last chance to notice which of the
 * two buttons the pointer is over.
 */
function RuntimeCard({
  t, fail, catalog, process, tunnel, security, sillyTavernPort, networkHost, installed, installing, active, dataBytes, profileName,
  version, onVersionChange, versions, onPendingInstallationId, csrfToken, onInstalling, onInstallJob, onRemove,
  canCancelInstall, onCancelInstall,
  onStart, onStop, onSetPassword, onPublish, onShowAddresses, onOpenSettings,
}: {
  t: Translate; fail: Fail; catalog: Record<string, unknown>; process: ProcessState; tunnel: TunnelState;
  security: AccessGatewayState; sillyTavernPort: number; networkHost: string | null; installed: boolean; installing: boolean;
  active: Installation | undefined; dataBytes: number | null; profileName: string | null; version: string;
  onVersionChange: (value: string) => void; versions: VersionOption[];
  onPendingInstallationId: (value: string | null) => void; csrfToken: string | null;
  onInstalling: (value: boolean) => void; onInstallJob: (value: string | null) => void; onRemove: () => Promise<string | null>;
  /** Whether the install in flight is one the server will take back. */
  canCancelInstall: boolean;
  onCancelInstall: () => Promise<void>;
  onStart: () => Promise<void>; onStop: () => Promise<void>;
  onSetPassword: (password: string, confirmPassword: string) => Promise<string | null>;
  /** Turn the tunnel on, for a reader who has no address that reaches this machine. */
  onPublish: () => Promise<void>;
  onShowAddresses: () => void;
  onOpenSettings: () => void;
}) {
  const [stopAsked, setStopAsked] = useState(false);
  // Asked for on the way to a link, not before: the PIN is what the tunnel
  // needs, and it means something at the moment the door is about to open.
  const [passcodeAsked, setPasscodeAsked] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [askedVersion, setAskedVersion] = useState<string | null>(null);
  const [askedRemove, setAskedRemove] = useState(false);
  const [askedStopInstall, setAskedStopInstall] = useState(false);
  const [stoppingInstall, setStoppingInstall] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  // Opened once, kept mounted: coming back to the console and going in again
  // should not reload SillyTavern and lose whatever was half typed.
  const [embedMounted, setEmbedMounted] = useState(false);
  const [embedOpening, setEmbedOpening] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<string | null>(() => readDismissedUpdate(browserStorage()));
  const { toast } = useToast();
  const report = (message: string | null) => { if (message) toast({ title: message, tone: 'destructive' }); };

  const running = process.status === 'running';
  const pending = busy || process.status === 'starting' || process.status === 'stopping';
  const installingNow = installing || (active !== undefined && active.status !== 'ready' && active.status !== 'failed');
  const installFailed = active?.status === 'failed';

  const tone: StatusTone = installingNow || process.status === 'starting' || process.status === 'stopping'
    ? 'working'
    : running ? 'online'
      : process.status === 'error' || installFailed ? 'attention'
        : 'offline';

  // The card is headed with the name of the thing; the state is a pill beside
  // it, in a word. The heading used to be the whole sentence, which made the
  // one fixed thing on the page - what this card is about - move and change
  // length every time the state did.
  const stateWord = installingNow ? t('console.stateInstalling')
    : installFailed ? t('console.stateInstallFailed')
      : process.status === 'starting' ? t('console.stateStarting')
        : process.status === 'stopping' ? t('console.stateStopping')
          : process.status === 'error' ? t('console.stateError')
            : running ? t('console.stateRunning')
              : installed ? t('console.stateStopped')
                : t('console.stateNotInstalled');
  // What is being waited for, while something is being waited for. This is
  // where the sweep lives for a start or a stop - the two things somebody
  // presses and then watches, and which used to report nothing at all until
  // they finished.
  // Read off SillyTavern's own output while it starts, so a slow start says
  // what it is slow at - compiling, migrating, loading plugins.
  const processStep = process.stepCode ? translateStep('', catalog, process.stepCode, process.stepParams) : '';
  const waitingFor = process.status === 'starting' ? processStep || t('console.waitingForSilly')
    : process.status === 'stopping' ? processStep || t('console.stoppingSilly')
      : null;
  const waitingTask = process.status === 'starting' ? t('console.taskStart') : t('console.taskStop');

  // A refusal the manager wrote is said in the reader's language; a line from
  // git, npm or SillyTavern itself is shown as that program wrote it.
  const failure = installFailed && active?.error
    ? fail.of(active.errorCode, active.error, t('console.heroInstallFailed'))
    : process.error
      ? fail.of(process.errorCode, process.error, t('console.heroFailed'))
      : null;

  const choices = versions.length > 0 ? versions : [{ selector: 'latest', label: `${t('dashboard.latest')} (latest)`, ref: 'latest', channel: 'release', tag: null, publishedAt: null }] satisfies VersionOption[];
  const chosen = choices.find((choice) => choice.selector === version);
  const chosenLabel = chosen?.label ?? version;
  /*
   * Whether pressing Install would do nothing. Compared on the ref each option
   * resolves to, not on the name of the option: "latest" is a moving target,
   * so matching on the word would lock the one choice most people leave
   * selected and no upstream release could ever be installed.
   */
  const installedRef = active?.status === 'ready' ? active.resolvedRef : null;
  const alreadyInstalled = installedRef !== null && chosen !== undefined && chosen.ref === installedRef;
  const update = availableUpdate(choices, active ?? null);
  const showUpdate = update !== null && update.ref !== dismissedUpdate && !installingNow;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  const install = async () => {
    if (!csrfToken) return;
    onInstalling(true);
    try {
      const response = await apiFetch('/api/v1/installations', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ version }) });
      const payload = await response.json() as { installationId?: string; job?: { id?: string }; error?: { message?: string } };
      if (!response.ok) { report(fail.body(payload, t('console.installRequestFailed'))); onInstalling(false); return; }
      if (!payload.installationId) { report(t('console.installRequestFailed')); onInstalling(false); return; }
      onPendingInstallationId(payload.installationId);
      // The job, not the installation: stopping is asked of the job, and the
      // record the installation lives in is one of the things a stop removes.
      onInstallJob(payload.job?.id ?? null);
    } catch { report(t('console.installRequestFailed')); onInstalling(false); }
  };

  // The first install has nothing to interrupt. Every one after it replaces a
  // working copy and restarts it, which is worth a question.
  const requestInstall = () => { if (installed || running) setAskedVersion(version); else void install(); };
  // Asked about, because what is being given up is however many minutes of
  // downloading have already been spent.
  const stopInstall = () => { setAskedStopInstall(true); };
  const takeUpdate = () => { if (update) { onVersionChange('latest'); setAskedVersion('latest'); } };
  const dismissUpdate = () => {
    if (!update) return;
    saveDismissedUpdate(update.ref, browserStorage());
    setDismissedUpdate(update.ref);
  };

  /*
   * Whether SillyTavern can be shown inside this page at all.
   *
   * It cannot be framed directly: it answers with `X-Frame-Options:
   * SAMEORIGIN`, and the console is a different port and so a different
   * origin. What is framed is the manager's own gateway, which proxies to it
   * and says instead that this console may frame it - so the embed needs the
   * gateway up, and the gateway needs its PIN set before it lets anyone past.
   *
   * Only from this machine, and that is not a gap waiting to be filled.
   * Reached over the network the console is on some other origin, which the
   * gateway has not been told to allow; and reached through the two Workers
   * the console and the gateway are two different hostnames, so the session
   * cookie the embed relies on would be a third-party cookie inside a
   * cross-site frame - blocked outright by Safari and Firefox, and by Chrome
   * before long. A feature that works in one browser and fails silently in
   * the rest is worse than the tab this falls back to, which works in all of
   * them. The box below says so by offering that instead.
   */
  const onThisMachine = isThisMachine(window.location.hostname);
  const embedUrl = `http://${window.location.hostname}:${security.port}/`;
  const canEmbed = running && onThisMachine;
  // A frame kept loaded across a stop would come back to an error page.
  useEffect(() => { if (!running) { setEmbedOpen(false); setEmbedMounted(false); } }, [running]);
  /*
   * Open it without asking for the PIN.
   *
   * Whoever is reading this page gave the console's password, and that is the
   * stronger credential: it can stop SillyTavern, reach its data and change
   * the PIN itself. The console asks the gateway for a session on their
   * behalf; the cookie it sets is host-scoped, and cookies ignore ports, so
   * the frame on the gateway's port arrives already signed in.
   */
  const openEmbed = async () => {
    // Put away rather than closed: it is still loaded, so it only has to be shown.
    if (embedMounted) { setEmbedOpen(true); return; }
    if (!csrfToken) return;
    setEmbedOpening(true);
    try {
      const response = await apiFetch('/api/v1/access/embed-session', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { report(fail.body(await response.json().catch(() => null), t('console.embedFailed'))); return; }
      setEmbedMounted(true);
      setEmbedOpen(true);
    } catch { report(t('console.embedFailed')); } finally { setEmbedOpening(false); }
  };

  const addresses = reachableAddresses(tunnel, security, networkHost ?? window.location.hostname, sillyTavernPort, onThisMachine);
  /*
   * The best address there is, or none at all.
   *
   * None is what a hosted console has before anything is published: the
   * loopback address belongs to a container nobody can reach, the network
   * address is off, and there is no tunnel yet. This used to fall back on the
   * loopback address and offer it as the way in, which from the reader's
   * browser is their own machine - a link that opens a connection refused.
   */
  const primary = addresses[0] ?? null;
  const otherCount = Math.max(0, addresses.length - 1);
  const openPrimary = () => { if (primary) window.open(primary.url, '_blank', 'noopener,noreferrer'); };
  /*
   * Give the reader a link to SillyTavern, doing whatever that takes.
   *
   * The tunnel publishes the gateway, and the gateway will not open without a
   * PIN, so those are the two steps - asked for here, in that order, off one
   * press. Telling somebody on a hosted studio that their only address is one
   * they cannot use, and leaving them to find the switch, is how a console
   * ends up looking broken.
   */
  const publish = async () => {
    if (!security.passwordConfigured) { setPasscodeAsked(true); return; }
    setPublishing(true);
    try { await onPublish(); } finally { setPublishing(false); }
  };
  const waitingForLink = running && primary === null;

  return <>
    <Card className="runtime-card" data-tour="installation">
      <CardHeader className="runtime-head">
        <h2 className="panel-title">
          SillyTavern
          <StatePill tone={tone}>{stateWord}</StatePill>
        </h2>
        <CardAction className="runtime-actions">
          {installed ? <>
            {waitingForLink
              ? <Button variant="outline" size="sm" onClick={() => void publish()} disabled={publishing || tunnel.mode !== 'off'}><Globe2 />{publishing || tunnel.mode !== 'off' ? t('common.loading') : t('console.getLink')}</Button>
              : <Button variant="outline" size="sm" disabled={!running || primary === null} onClick={openPrimary}><ArrowUpRight />{t('console.openInTab')}</Button>}
            {running
              ? <Button variant="destructive" size="sm" onClick={() => setStopAsked(true)} disabled={pending}><Square />{t('dashboard.stop')}</Button>
              : <Button size="sm" onClick={() => void run(onStart)} disabled={pending || installingNow}><Play />{pending ? t('common.loading') : t('dashboard.start')}</Button>}
          </> : null}
        </CardAction>
      </CardHeader>

      <CardContent className="runtime-body">
        {/*
          * The picture is of something that is running. With SillyTavern down
          * there is nothing to show a picture of, and a still of a front page
          * that is not being served reads as an invitation to click something
          * that does nothing - so the box goes empty and says why.
          */}
        <div className="runtime-preview" data-live={running ? 'true' : 'false'}>
          {running ? <SillyTavernStill generation={process.startedAt ?? 'up'} /> : null}
          {/* From another device the frame cannot be shown, so the same
              invitation opens SillyTavern in a tab at the best address instead
              of explaining why it will not. */}
          {canEmbed
            ? <button type="button" className="runtime-preview-open" onClick={() => void openEmbed()}>
              <span className="runtime-preview-cta"><Monitor aria-hidden="true" />{embedOpening ? t('common.loading') : embedMounted ? t('console.embedResume') : t('console.useItHere')}</span>
              <span className="runtime-preview-note">{embedMounted ? t('console.embedResumeHint') : t('console.useItHereHint')}</span>
            </button>
            : waitingForLink
              ? <button type="button" className="runtime-preview-open" onClick={() => void publish()} disabled={publishing || tunnel.mode !== 'off'}>
                <span className="runtime-preview-cta"><Globe2 aria-hidden="true" />{publishing || tunnel.mode !== 'off' ? t('console.linkStarting') : t('console.getLink')}</span>
                <span className="runtime-preview-note">{t('console.getLinkHint')}</span>
              </button>
              : running
              ? <button type="button" className="runtime-preview-open" onClick={openPrimary}>
                <span className="runtime-preview-cta"><ArrowUpRight aria-hidden="true" />{t('console.useItHere')}</span>
                <span className="runtime-preview-note">{t('console.useItInTabHint')}</span>
              </button>
              : <div className="runtime-preview-idle">
                <Monitor aria-hidden="true" />
                <span>{t('console.stateOffline')}</span>
              </div>}
        </div>

        <dl className="runtime-meta">
          {/* Nothing is answering at any of these while SillyTavern is down,
              so the row goes rather than standing there with a dash in it. */}
          {running ? <div className="runtime-row">
            <dt>{t('console.addressLabel')}</dt>
            <dd>
              {primary
                ? <AddressLink t={t} href={primary.url}>
                  <span className="address-full">{primary.host}</span>
                  <span className="address-short">{shortenHost(primary.host)}</span>
                </AddressLink>
                : <span className="text-muted-foreground">{t('console.noAddressYet')}</span>}
              {otherCount > 0
                ? <button type="button" className="runtime-shared" onClick={onShowAddresses}>{t('console.alsoOnline', { count: otherCount })}</button>
                : null}
            </dd>
          </div> : null}

          <div className="runtime-row">
            <dt><label htmlFor="install-version">{t('dashboard.version')}</label></dt>
            <dd className="runtime-version">
              <Select value={version} onValueChange={onVersionChange}>
                <SelectTrigger id="install-version" size="sm" className="runtime-select"><SelectValue /></SelectTrigger>
                <SelectContent position="popper" align="start" className="version-select-content">
                  {choices.map((choice) => <SelectItem key={choice.selector} value={choice.selector}>{choice.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {alreadyInstalled
                ? <Tooltip><TooltipTrigger asChild><span className="inline-flex"><Button variant="outline" size="sm" disabled><Download />{t('console.versionInstalled')}</Button></span></TooltipTrigger><TooltipContent>{t('console.versionInstalledHint')}</TooltipContent></Tooltip>
                : <Button variant="success" size="sm" onClick={requestInstall} disabled={!csrfToken || installing}><Download />{installing ? t('common.loading') : t('dashboard.install')}</Button>}
            </dd>
          </div>

          <div className="runtime-row">
            <dt>{t('console.dataProfile')}</dt>
            <dd>
              <span>{profileName ?? t('console.noProfiles')}</span>
              {profileName === null ? null : <span className="runtime-sep" aria-hidden="true">·</span>}
              {profileName === null ? null : dataBytes === null ? <span className="thinking">{t('system.measuring')}</span> : <span className="runtime-bytes">{formatBytes(dataBytes)}</span>}
            </dd>
          </div>

          {installingNow && active ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={t('console.taskInstall')} step={translateStep(active.step, catalog, active.stepCode, active.stepParams)} percent={active.progress} />
              <TaskBar percent={active.progress} />
              {/* A first install is minutes of Git and npm, and on a phone a
                  good deal more. Somebody who started it by mistake, or on the
                  wrong version, used to have nothing to press. What is stopped
                  is taken back by the server, so the machine is left as it was
                  found rather than holding half a checkout. */}
              {canCancelInstall ? <div className="runtime-progress-actions">
                <Button variant="outline" size="sm" disabled={stoppingInstall} onClick={() => void stopInstall()}>
                  {stoppingInstall ? <LoaderCircle className="animate-spin" /> : <Square />}{stoppingInstall ? t('console.installStopping') : t('console.installStop')}
                </Button>
              </div> : null}
            </dd>
          </div> : removing ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={t('console.taskUninstall')} step={process.status === 'stopping' && waitingFor ? waitingFor : t('console.uninstallRemoving')} />
              <TaskBar />
            </dd>
          </div> : waitingFor ? <div className="runtime-row">
            <dt>{t('console.progressLabel')}</dt>
            <dd className="runtime-progress">
              <TaskLine task={waitingTask} step={waitingFor} />
              <TaskBar />
            </dd>
          </div> : null}

          {failure ? <div className="runtime-row">
            <dt>{t('console.problemLabel')}</dt>
            <dd><span className="install-error" role="alert">{failure}</span></dd>
          </div> : null}
        </dl>
      </CardContent>

      {showUpdate && update ? <div className="runtime-update" role="status">
        <CircleArrowUp aria-hidden="true" />
        <span>{t('console.updateAvailable', { version: update.label })}</span>
        <div className="runtime-update-actions">
          <Button variant="success" size="sm" onClick={takeUpdate}><Download />{t('console.updateNow')}</Button>
          <Button variant="ghost" size="sm" onClick={dismissUpdate}>{t('console.updateDismiss')}</Button>
        </div>
      </div> : null}

      {installed ? <CardFooter className="runtime-foot">
        <div className="runtime-foot-actions">
          <Button variant="ghost" size="sm" onClick={onOpenSettings}><Settings2 />{t('nav.config')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setAskedRemove(true)} disabled={installing || removing}><Trash2 />{t('console.uninstall')}</Button>
        </div>
      </CardFooter> : null}
    </Card>

    {embedMounted && primary ? <EmbedStage t={t} open={embedOpen} url={embedUrl} openUrl={primary.url} onMinimize={() => setEmbedOpen(false)} onClose={() => { setEmbedOpen(false); setEmbedMounted(false); }} /> : null}

    <ConfirmDialog
      open={stopAsked}
      onOpenChange={setStopAsked}
      title={t('console.stopConfirm')}
      description={t('console.stopConfirmBody')}
      confirmLabel={t('dashboard.stop')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => run(onStop)}
    />
    <ConfirmDialog
      open={askedVersion !== null}
      onOpenChange={(open) => { if (!open) setAskedVersion(null); }}
      tone="default"
      title={t('console.installConfirm', { version: chosenLabel })}
      description={t('console.installConfirmBody')}
      confirmLabel={t('dashboard.install')}
      cancelLabel={t('common.cancel')}
      onConfirm={install}
    />
    <PasscodeDialog
      t={t}
      open={passcodeAsked}
      onOpenChange={setPasscodeAsked}
      note={null}
      onSubmit={async (passcode, confirmPasscode) => {
        const failure = await onSetPassword(passcode, confirmPasscode);
        if (failure) return failure;
        // The PIN was only ever the condition. Publishing is what was asked for.
        setPublishing(true);
        try { await onPublish(); } finally { setPublishing(false); }
        return null;
      }}
    />
    <ConfirmDialog
      open={askedStopInstall}
      onOpenChange={setAskedStopInstall}
      title={t('console.installStopConfirm')}
      description={t('console.installStopConfirmBody')}
      confirmLabel={t('console.installStop')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { setStoppingInstall(true); try { await onCancelInstall(); } finally { setStoppingInstall(false); } }}
    />
    <ConfirmDialog
      open={askedRemove}
      onOpenChange={setAskedRemove}
      title={t('console.uninstallConfirm')}
      description={t('console.uninstallConfirmBody')}
      confirmLabel={t('console.uninstall')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { setRemoving(true); try { report(await onRemove()); } finally { setRemoving(false); } }}
    />
  </>;
}

function AccessPanel({ t, process, tunnel, config, security, sillyTavernPort, onAction, onSetLan, onSetPassword }: { t: Translate; process: ProcessState; tunnel: TunnelState; config: ConfigDocument | null; security: AccessGatewayState; sillyTavernPort: number; onAction: (path: string, body?: unknown) => Promise<void>; onSetLan: (lan: boolean) => Promise<string | null>; onSetPassword: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [securityBusy, setSecurityBusy] = useState(false);
  const running = process.status === 'running';
  const { toast } = useToast();
  /**
   * Whether the tunnel is meant to be open, rather than whether it is up.
   *
   * The tunnel outlives SillyTavern now - it publishes the access gateway, so a
   * restart or a restore leaves the address alone, and an exit nobody asked for
   * is reconnected. Reading the switch off the live status meant a tunnel that
   * was between attempts looked off, and one that was reconnecting could not be
   * turned off at all.
   */
  const tunnelWanted = tunnel.mode !== 'off';
  // The door is the manager's own, so its password and its reach are known
  // whether or not SillyTavern happens to be up. Nothing here has to wait for
  // a version to answer, and no reading is ever "unknown".
  const passwordReady = security.passwordConfigured;
  const lan = security.lan;
  const [passwordOpen, setPasswordOpen] = useState(false);
  // Turning either of these off takes an address away from whoever is on the
  // other end of it, and they are not in the room to be asked.
  const [closing, setClosing] = useState<'tunnel' | 'lan' | null>(null);
  const runAction = async (path: string, body?: unknown) => { setBusy(true); try { await onAction(path, body); } finally { setBusy(false); } };
  const setTunnel = async (on: boolean) => { await runAction('/api/v1/tunnel', { mode: on ? 'quick' : 'off' }); };
  /*
   * What to turn on once a PIN exists, or null when nothing is waiting.
   *
   * A switch pressed without a PIN is a request, not a state: it opens the
   * dialog that asks for one, and it is that dialog finishing which turns the
   * thing on. Until then the switch shows what is true, which is off - and a
   * dialog closed without a PIN leaves it there, because nothing was turned on.
   * These switches used to be disabled instead, with a line underneath naming a
   * prerequisite, which left the reader to go and find the prerequisite
   * themselves.
   */
  const [waiting, setWaiting] = useState<'tunnel' | 'lan' | null>(null);
  const askForPassword = (what: 'tunnel' | 'lan') => { setWaiting(what); setPasswordOpen(true); };
  const toggleTunnel = (next: boolean) => {
    if (!next) { setClosing('tunnel'); return; }
    if (!passwordReady) { askForPassword('tunnel'); return; }
    void setTunnel(true);
  };
  const setLanTo = async (next: boolean) => {
    setSecurityBusy(true);
    try {
      // A refusal is a result: said once, then gone. Whether the gateway is
      // currently broken is state, and stays on the card below.
      const failure = await onSetLan(next);
      if (failure) toast({ title: failure, tone: 'destructive' });
      else toast({ title: next ? t('console.lanOnDone') : t('console.lanOffDone'), tone: 'success' });
    } finally { setSecurityBusy(false); }
  };
  const toggleLan = (next: boolean) => {
    if (!next) { setClosing('lan'); return; }
    if (!passwordReady) { askForPassword('lan'); return; }
    void setLanTo(true);
  };
  // This machine reaches SillyTavern directly, because the loopback address is
  // already a boundary. Everything else goes through the gateway and its
  // password: the LAN address and the tunnel both point there.
  const local = localHost(sillyTavernPort);
  // Whether the reader is on the machine this is running on. From anywhere else
  // - another device on the Wi-Fi, a hosted studio, a forwarded port - the
  // loopback address names the reader's own computer, so it is shown as what it
  // is rather than offered as a link into a machine it was never going to reach.
  const onThisMachine = isThisMachine(window.location.hostname);
  const lanHost = `${config?.networkHost ?? window.location.hostname ?? 'localhost'}:${security.port}`;
  const localUrl = `http://${local}`;
  const lanUrl = `http://${lanHost}`;
  /*
   * What this card reports is whether the doors are answering, which is not
   * the same question as whether either switch is on.
   *
   * Turning SillyTavern off does not turn the sharing off - nobody asked for
   * that, and a switch that flips itself back is a switch nobody can trust -
   * but it does leave the addresses with nothing behind them. Saying "online"
   * then would be untrue and saying "off" would be a lie about the switches,
   * so the third state says the actual situation: the doors are open and
   * waiting for something to be behind them.
   */
  const shared = tunnelWanted || lan;
  const accessTone: StatusTone = tunnel.error ? 'attention' : running && shared ? 'online' : shared ? 'attention' : 'offline';
  const accessLabel = tunnel.error ? t('dashboard.offline')
    : running && shared ? t('console.online')
      : shared ? t('console.waitingForSillyShort')
        : t('dashboard.offline');
  return <Card data-tour="remote-access">
    <PanelHeading icon={<Globe2 />} action={<StatePill tone={accessTone}>{accessLabel}</StatePill>}>{t('console.publicAccess')}</PanelHeading>
    <CardContent className="flex-1">
      {/*
        * Two questions, asked in that order: what is open, and where does it
        * answer. The switches used to sit between the addresses, each one
        * followed by the address it turned on, so the reader met the whole
        * card twice over to find the one line they came for.
        *
        * The tunnel is first because it is the one that reaches a phone that
        * is not in the house.
        */}
      {/*
        * Each switch says, in one short line, what it does for the person
        * reading it.
        *
        * It used to say what it needed instead - "Cloudflare tunnel · Password
        * required before sharing" - which told somebody who did not already
        * know what a tunnel is two things they could not use: a brand they had
        * not heard of, and a prerequisite. The feature most worth trying was
        * the one most often never tried.
        *
        * Nothing here mentions the passcode any more, in either state. The
        * switch asks for one the moment it is pressed, which is the moment it
        * means anything; announcing it beforehand spends the only line these
        * rows have on a condition rather than on a reason.
        */}
      <div className="access-switches">
        <div className="access-row">
          <div>
            <strong>{t('console.quickTunnel')}{!tunnelWanted ? <span className="access-badge"><Star />{t('console.tunnelBadge')}</span> : null}</strong>
            <span>{t('console.tunnelWhy')}</span>
          </div>
          {/* Not waiting on SillyTavern. The tunnel publishes the door in
              front of it, which is up from the moment the console is, and it
              serves SillyTavern the moment SillyTavern answers - so somebody
              setting a machine up gets to do these steps in whichever order
              suits them, and the address is ready before it is needed. */}
          <Switch id="tunnel-switch" checked={tunnelWanted} onCheckedChange={toggleTunnel} disabled={busy} aria-label={t('console.enableTunnel')} />
        </div>
        <div className="access-row">
          <div>
            <strong>{t('console.lanAccess')}</strong>
            <span>{t('console.lanWhy')}</span>
          </div>
          <Switch id="listen-switch" checked={lan} onCheckedChange={toggleLan} disabled={securityBusy} aria-label={t('console.enableLan')} />
        </div>
      </div>
      {/* With SillyTavern down every one of these leads nowhere, so the whole
          group goes rather than three rows of dashes. */}
      {running ? <>
        <div className="access-group-label">{t('console.addresses')}</div>
        <div className="address-rows">
          {/* The fixed Worker address when there is one, because that is the
              address worth giving anybody; the tunnel's own is inside the
              sheet, where somebody looking for it will find it. */}
          <AddressRow
            t={t}
            label={t('dashboard.publicAddress')}
            url={tunnel.proxyUrl ?? tunnel.url}
            display={tunnel.proxyUrl ?? tunnel.url ?? ''}
            disabledHint={t('console.tunnelOffShort')}
            {...(tunnel.proxyUrl && tunnel.url ? { alternates: [tunnel.url] } : {})}
          />
          <AddressRow t={t} label={t('console.lanAddress')} url={lan ? lanUrl : null} display={lanHost} disabledHint={t('console.lanOffShort')} />
          <AddressRow t={t} label={t('console.local')} url={onThisMachine ? localUrl : null} display={local} disabledHint={t('console.localElsewhere')} />
        </div>
      </> : null}
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => { if (!open) setClosing(null); }}
        title={closing === 'lan' ? t('console.lanOffConfirm') : t('console.tunnelOffConfirm')}
        description={closing === 'lan' ? t('console.lanOffConfirmBody') : t('console.tunnelOffConfirmBody')}
        confirmLabel={t('common.turnOff')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => { if (closing === 'lan') await setLanTo(false); else await setTunnel(false); }}
      />
      <PasscodeDialog
        t={t}
        open={passwordOpen}
        onOpenChange={(open) => { setPasswordOpen(open); if (!open) setWaiting(null); }}
        note={null}
        onSubmit={async (passcode, confirmPasscode) => {
          const failure = await onSetPassword(passcode, confirmPasscode);
          if (failure) return failure;
          const next = waiting;
          setWaiting(null);
          if (next === 'tunnel') await setTunnel(true);
          if (next === 'lan') await setLanTo(true);
          return null;
        }}
      />
      {busy || securityBusy ? <div className="operation-progress" role="status"><span className="thinking">{t('common.loading')}</span><TaskBar /></div> : null}
      {security.error ? <p className="install-error" role="alert">{security.error}</p> : null}
      {tunnel.error ? <p className="install-error" role="alert">{tunnel.error}</p> : null}
    </CardContent>
  </Card>;
}

/**
 * Setting a password, wherever a password is set.
 *
 * There are two, and they open different things: one lets a browser into this
 * manager, the other lets a browser into SillyTavern. They used to be asked
 * for in two different shapes on two different pages - a collapsed section on
 * the access card, a pair of bare fields on the settings page - so the only
 * way to tell which one was being changed was to already know. Both are asked
 * for here, named after what they open, and only when the reader asks.
 */
function PasswordDialog({ t, open, onOpenChange, title, description, note, minLength, hint, submitLabel, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; note?: string | null; minLength: number; hint: string; submitLabel: string; onSubmit: (password: string, confirmPassword: string) => Promise<string | null> }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Flagged once the second field stops being a prefix of the first, rather
  // than the moment the two differ - a warning under a half-typed password is
  // noise that goes away on its own.
  const mismatch = confirmPassword.length > 0 && !password.startsWith(confirmPassword);
  const ready = password.length >= minLength && password === confirmPassword;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setPassword(''); setConfirmPassword(''); setError(null); }
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(password, confirmPassword);
      setError(failure);
      if (!failure) close(false);
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <Field label={t('console.password')} hint={hint}>
            <PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label={t('console.confirmPassword')} error={mismatch ? t('setup.mismatch') : null}>
            <PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </Field>
          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} disabled={busy || !ready}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Set the passcode, twice.
 *
 * Twice because a passcode that was mistyped once locks the door on its owner
 * from wherever they were going to use it, and there is no "forgot it" here -
 * only the console on the machine itself.
 */
function PasscodeDialog({ t, open, onOpenChange, note, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; note: string | null; onSubmit: (passcode: string, confirmPasscode: string) => Promise<string | null> }) {
  const [entered, setEntered] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const [stage, setStage] = useState<'enter' | 'confirm'>('enter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = { digit: t('console.passcodeDigit'), clear: t('console.passcodeClear'), backspace: t('console.passcodeBackspace') };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setEntered(''); setConfirmed(''); setStage('enter'); setError(null); }
  };

  const save = async (code: string) => {
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(entered, code);
      if (failure) { setError(failure); setConfirmed(''); setStage('enter'); setEntered(''); return; }
      close(false);
    } finally { setBusy(false); }
  };

  const mismatch = stage === 'confirm' && confirmed.length === PASSCODE_DIGITS && confirmed !== entered;

  return <Dialog open={open} onOpenChange={close}>
    {/* A dialog focuses its first field as it opens. On a touch screen that
        field is the one under the dots, and focus there is what used to bring
        the device's keypad up over the one drawn below it. */}
    <DialogContent className="sm:max-w-sm" onOpenAutoFocus={(event) => { if (!window.matchMedia('(pointer: fine)').matches) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{t('console.passwordSettings')}</DialogTitle>
        <DialogDescription>{stage === 'enter' ? t('console.passcodeChoose') : t('console.passcodeRepeat')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        {stage === 'enter'
          ? <PasscodeInput
            key="enter"
            value={entered}
            onChange={(value) => { setEntered(value); setError(null); }}
            onComplete={() => setStage('confirm')}
            label={t('console.passwordSettings')}
            length={PASSCODE_DIGITS}
            labels={labels}
            disabled={busy}
            autoFocus
          />
          : <PasscodeInput
            key="confirm"
            value={confirmed}
            onChange={(value) => setConfirmed(value)}
            onComplete={(value) => { if (value === entered) void save(value); }}
            label={t('console.confirmPassword')}
            length={PASSCODE_DIGITS}
            labels={labels}
            disabled={busy}
            autoFocus
          />}
        {mismatch ? <Alert variant="destructive"><AlertDescription>{t('setup.mismatch')}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => close(false)} disabled={busy}>{t('common.cancel')}</Button>
        {stage === 'confirm'
          ? <Button variant="outline" onClick={() => { setStage('enter'); setConfirmed(''); }} disabled={busy}>{t('console.passcodeAgain')}</Button>
          : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** An address that opens in its own tab rather than sitting there as text. */
function AddressLink({ t, href, children }: { t: Translate; href: string; children: ReactNode }) {
  return <a className="address-link" href={href} target="_blank" rel="noopener noreferrer" title={t('console.openInNewTab')}><code>{children}</code></a>;
}

/**
 * One address, and the one button that does everything else with it.
 *
 * The card used to carry an Open button and a Copy button in its footer, both
 * of which acted on whichever address the card had decided was the important
 * one, plus a Show QR toggle that pushed the rest of the card down when it was
 * pressed. Each address now answers for itself: the address is the link, and
 * the button beside it opens the sheet that holds the code, the copy and the
 * open - for that address, not for whichever one the footer had in mind.
 */
function AddressRow({ t, label, url, display, disabledHint, alternates }: { t: Translate; label: string; url: string | null; display: string; disabledHint?: string; alternates?: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <div className="address-row">
    <span className="address-name">{label}</span>
    <span className="address-value">
      {url ? <AddressLink t={t} href={url}>{display}</AddressLink> : <code className="address-absent">{disabledHint ?? '—'}</code>}
    </span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`${t('console.shareAddress')} · ${label}`}
      title={t('console.shareAddress')}
      disabled={url === null}
      onClick={() => setOpen(true)}
    ><QrCodeIcon /></Button>
    {url ? <ShareDialog t={t} open={open} onOpenChange={setOpen} label={label} links={[url, ...(alternates ?? [])]} /> : null}
  </div>;
}

/**
 * The code, and every address that reaches this door.
 *
 * Three things and no fourth: the code, and one line per address, each of them
 * a link. Where a place has two addresses - a Worker with a fixed name and the
 * tunnel it forwards to - both are here, one under the other, because either
 * works and a reader is entitled to see the second rather than be told about
 * it. The first is the one the code carries and the one worth sharing.
 */
function ShareDialog({ t, open, onOpenChange, label, links }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; label: string; links: readonly string[] }) {
  const primary = links[0] ?? '';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="share-dialog">
      <DialogHeader>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{t('console.scanToOpen')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="share-body">
        <QrCode value={primary} label={`${label}: ${primary}`} />
        <div className="share-links">
          {links.map((link) => <a key={link} className="share-url" href={link} target="_blank" rel="noopener noreferrer">{link}</a>)}
        </div>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/**
 * Where the data stands, and one way through to it.
 *
 * This card had four controls - a link in the body, two buttons in the footer
 * and an advert pinned under them - and all four went to the same page. It
 * also carried a standing recommendation to set up off-machine backups, which
 * is advice printed on a page rather than offered where it can be acted on;
 * that belongs next to the setting itself.
 */
function DataPanel({ t, navigate, latestBackup, snapshot, onRemeasure }: { t: Translate; navigate: Navigate; latestBackup: BackupManifest | null; snapshot: SystemSnapshot | null; onRemeasure: () => Promise<void> }) {
  /*
   * Two figures, because they answer two different questions.
   *
   * One number for the whole installation invited the reading that the
   * manager's own footprint and SillyTavern's data were separate things being
   * added up, when the second is inside the first. Split, each half says what
   * it is: what can be deleted to get room back, and what is actually being
   * chatted with.
   *
   * The archive half is the remainder rather than a measurement of its own, so
   * with more than one profile it also carries the profiles that are not
   * running. That is the honest place to put them - they are stored, not in
   * use - and it keeps the two halves adding up to the total on disk.
   */
  const storage = snapshot?.storage ?? null;
  const dataBytes = storage?.dataBytes ?? null;
  const totalBytes = storage?.managerBytes ?? null;
  // Measured, as opposed to still being walked. A machine with no profile has
  // no `dataBytes`, which is an answer rather than an absence of one: the size
  // is what the manager holds, and none of it is a profile yet.
  const measured = totalBytes !== null;
  const profileBytes = dataBytes ?? 0;
  const otherBytes = totalBytes === null ? 0 : Math.max(0, totalBytes - profileBytes);
  return <Card data-tour="data" className="overview-pair">
    <PanelHeading icon={<Database />}>{t('console.dataAndBackups')}</PanelHeading>
    <CardContent className="flex-1">
      <div className="grid gap-1">
        <DetailRow label={t('console.sizeLabel')}>
          {measured
            ? <span className="size-split">
              <span>{formatBytes(otherBytes)} <em>({t('console.sizeBackups')})</em></span>
              <span aria-hidden="true">+</span>
              <span>{formatBytes(profileBytes)} <em>({t('console.sizeData')})</em></span>
            </span>
            : <span className="thinking">{t('system.measuring')}</span>}
        </DetailRow>
        {latestBackup
          ? <DetailRow label={t('status.lastBackup')}>{new Date(latestBackup.createdAt).toLocaleString()}</DetailRow>
          : <DetailRow label={t('status.lastBackup')}>
            <Button variant="outline" size="sm" onClick={() => navigate('data')}><Archive />{t('dashboard.backupNow')}</Button>
          </DetailRow>}
      </div>
      {storage ? <p className="system-note">
        {storage.measuredAt ? <span>{t('system.sizesMeasuredAt')} {new Date(storage.measuredAt).toLocaleTimeString()}</span> : <span />}
        <Button variant="ghost" size="sm" onClick={() => void onRemeasure()} disabled={storage.measuring}><RefreshCw />{storage.measuring ? t('system.measuring') : t('system.remeasure')}</Button>
      </p> : null}
    </CardContent>
    <CardFooter><Button variant="outline" className="w-full" onClick={() => navigate('data')}><Database />{t('console.manageData')}<ArrowUpRight /></Button></CardFooter>
  </Card>;
}

interface LogViewProps {
  readonly t: Translate;
  readonly catalog: Record<string, unknown>;
  readonly source: LogSourceFilter;
  readonly onSourceChange: (value: LogSourceFilter) => void;
  readonly entries: LogEntry[];
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly compact: boolean;
  readonly onToggleCompact: () => void;
  readonly onLoadOlder: () => void;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
}

function LogsPanel({ expanded, onToggleExpanded, ...contentProps }: LogViewProps & { expanded: boolean; onToggleExpanded: () => void }) {
  const { t } = contentProps;
  // While the sheet is open the card keeps its footprint but not its content,
  // so the page behind does not reflow and the log is not rendered twice.
  const cardContents = expanded ? <div className="log-card-placeholder" aria-hidden="true" /> : <LogsContent {...contentProps} />;
  return <Card data-tour="logs" data-expanded={expanded}><PanelHeading icon={<ScrollText />} action={<Button variant="ghost" size="sm" onClick={onToggleExpanded} aria-label={t('console.expandLogs')}><Maximize2 />{t('console.expandLogs')}</Button>}>{t('console.liveLogs')}</PanelHeading>{cardContents}</Card>;
}

/**
 * The expanded log, mounted for every page rather than only the overview, so
 * the header button can reach it from wherever the operator happens to be.
 */
function LogsSheet({ open, onClose, ...contentProps }: LogViewProps & { open: boolean; onClose: () => void }) {
  const { t } = contentProps;
  return <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <SheetContent side="bottom" className="log-sheet" showCloseButton={false}>
      <SheetHeader className="log-sheet-header"><SheetTitle>{t('console.liveLogs')}</SheetTitle><Button variant="ghost" size="sm" onClick={onClose}><Minimize2 />{t('console.collapseLogs')}</Button></SheetHeader>
      <LogsContent {...contentProps} expanded />
    </SheetContent>
  </Sheet>;
}

/** Distance from the bottom, in pixels, still treated as "following the tail". */
const LOG_FOLLOW_SLACK = 48;
/** Distance from the top that asks for the previous page of retained lines. */
const LOG_BACKFILL_SLACK = 120;

function LogsContent({ t, catalog, source, onSourceChange, entries, query, onQueryChange, compact, onToggleCompact, onLoadOlder, hasOlder, loadingOlder, expanded = false }: { t: Translate; catalog: Record<string, unknown>; source: LogSourceFilter; onSourceChange: (value: LogSourceFilter) => void; entries: LogEntry[]; query: string; onQueryChange: (value: string) => void; compact: boolean; onToggleCompact: () => void; onLoadOlder: () => void; hasOlder: boolean; loadingOlder: boolean; expanded?: boolean }) {
  const logViewportRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  // Prepending history moves everything down; remember where the top was so the
  // reader keeps looking at the same line instead of being thrown forward.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = normalizedQuery.length === 0 ? entries : entries.filter((entry) => `${entry.source} ${entry.message}`.toLocaleLowerCase().includes(normalizedQuery));
  const showSource = source === 'all';
  const latestVisibleId = visibleEntries.at(-1)?.id;
  const oldestVisibleId = visibleEntries[0]?.id;

  const scrollToLatest = () => {
    const element = logViewportRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setFollowing(true);
    setUnread(0);
  };

  const onScroll = () => {
    const element = logViewportRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= LOG_FOLLOW_SLACK;
    setFollowing(atBottom);
    if (atBottom) setUnread(0);
    if (element.scrollTop <= LOG_BACKFILL_SLACK && hasOlder && !loadingOlder && normalizedQuery.length === 0) {
      anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      onLoadOlder();
    }
  };

  // Following the tail is the default, but scrolling up has to hold its place:
  // a restore writes a line every second and would otherwise drag the reader
  // back to the bottom mid-sentence.
  useEffect(() => {
    const element = logViewportRef.current;
    if (!element) return;
    if (following) { element.scrollTop = element.scrollHeight; return; }
    setUnread((current) => current + 1);
  }, [latestVisibleId]);

  useEffect(() => {
    const element = logViewportRef.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [normalizedQuery, source, compact, expanded]);

  useEffect(() => {
    const element = logViewportRef.current;
    const previous = anchor.current;
    if (!element || !previous) return;
    anchor.current = null;
    element.scrollTop = previous.top + (element.scrollHeight - previous.height);
  }, [oldestVisibleId]);
  return <div className={`logs-content ${expanded ? 'logs-content-expanded' : ''}`}>
    <div className="log-toolbar">
      <Select value={source} onValueChange={(value) => onSourceChange(value as LogSourceFilter)}>
        <SelectTrigger className="w-44" aria-label={t('console.logSource')}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('console.allLogs')}</SelectItem>
          <SelectItem value="sillytavern">SillyTavern</SelectItem>
          <SelectItem value="manager">Manager</SelectItem>
          <SelectItem value="cloudflared">Cloudflare Tunnel</SelectItem>
          <SelectItem value="installer">{t('console.installer')}</SelectItem>
          <SelectItem value="backup">{t('nav.backups')}</SelectItem>
        </SelectContent>
      </Select>
      <div className="log-search"><Search aria-hidden="true" /><Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t('console.searchLogs')} aria-label={t('console.searchLogs')} /></div>
      <Button type="button" variant="outline" size="sm" className="log-density-toggle" onClick={onToggleCompact} aria-pressed={compact} aria-label={compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}><Rows3 />{compact ? t('console.showDetailedLogs') : t('console.showCompactLogs')}</Button>
    </div>
    <div className="log-viewport">
      <div className="log-view" ref={logViewportRef} onScroll={onScroll} role="log" tabIndex={0} aria-label={t('console.liveLogs')}>
        {visibleEntries.length === 0 ? <span className="log-empty">{normalizedQuery ? t('console.noLogMatches') : t('console.noLogs')}</span> : <div className="log-lines">
          {normalizedQuery.length === 0 && hasOlder ? <div className="log-history-hint">{loadingOlder ? t('console.loadingOlderLogs') : <button type="button" onClick={onLoadOlder}>{t('console.loadOlderLogs')}</button>}</div> : null}
          {visibleEntries.map((entry) => <div className="log-line" key={entry.id}>
            {compact ? null : <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}</time>}
            {showSource ? <span className="log-source">{entry.source}</span> : null}
            <span className="log-message">{translateLogEntry(entry, catalog)}</span>
          </div>)}
        </div>}
      </div>
      {following ? null : <button type="button" className="log-jump" onClick={scrollToLatest} aria-label={unread > 0 ? t('console.newLogLines') : t('console.jumpToLatest')}>
        <ArrowDown aria-hidden="true" />
        <span>{t('console.jumpToLatest')}</span>
        {unread > 0 ? <span className="log-jump-dot" aria-hidden="true" /> : null}
      </button>}
    </div>
  </div>;
}

const BACKUP_KIND_LABEL = {
  manual: 'console.backupKindManual',
  scheduled: 'console.backupKindScheduled',
  'before-restore': 'console.backupKindBeforeRestore',
  'before-switch': 'console.backupKindBeforeSwitch',
  r2: 'console.backupKindR2',
  uploaded: 'console.backupKindUploaded',
} as const satisfies Record<BackupKind, string>;

/**
 * Why a backup exists, as a small coloured label.
 *
 * The one someone took on purpose is the accent, the safety copies are amber
 * because they are what to reach for after a restore went wrong, and the ones
 * that happen on their own stay quiet.
 */
function BackupKindBadge({ t, kind }: { t: Translate; kind: BackupKind }) {
  return <span className="backup-kind" data-kind={kind}>{t(BACKUP_KIND_LABEL[kind])}</span>;
}

/** A name the manager chose itself, including the suffix-style names older versions chose. */
function isManagerName(backup: BackupManifest): boolean {
  if (backup.autoNamed) return true;
  if (backup.kind) return false;
  return /-(scheduled|prerestore|preswitch)\.zip$|-r2-[^.]+\.zip$|-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/u.test(backup.name);
}

/**
 * What a backup is called on screen.
 *
 * A name somebody typed is theirs and is shown as typed. A name the manager
 * made up is only ever a kind and a time, so it is said as that - in the
 * reader's language and date format, "Tự động · 16/09/2026 16:35" - and
 * changes with the language. The file keeps its plain ASCII name, which is
 * what a download is saved as.
 */
export function backupDisplayName(t: Translate, locale: string, backup: BackupManifest): string {
  if (!isManagerName(backup)) return backup.name;
  const when = new Date(backup.createdAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  return `${t(BACKUP_KIND_LABEL[backupKind(backup)])} · ${when}`;
}

/**
 * A moment as `hh:mm dd/mm/yyyy`, for a column that has to fit on a phone.
 *
 * Not `toLocaleString`: that writes the reader's long form, which on a narrow
 * table wraps onto two or three lines and pushes the size and the button out of
 * the row. Digits in a fixed order are the same width in every language and
 * are read the same way in both of the ones this console speaks.
 */
export function shortWhen(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '—';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())} ${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()}`;
}

/** The labels every table in the console borrows, in the reader's language. */
function tableLabels(t: Translate): DataTableLabels {
  return {
    search: t('table.search'),
    perPage: t('table.perPage'),
    count: (shown, total) => t('table.count', { shown, total }),
    sortAscending: t('table.sortAscending'),
    sortDescending: t('table.sortDescending'),
    navigation: t('table.navigation'),
    previous: t('table.previous'),
    next: t('table.next'),
    page: (page, of) => t('table.page', { page, of }),
  };
}

/**
 * The stand-in the server hands back for a key it is holding.
 *
 * Sending it back unchanged means "leave the stored one alone", so a configured
 * bucket can be edited without its secret ever reaching a browser.
 */
const SECRET_MASK = '********';

interface R2KeysForm {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface R2ScheduleForm {
  readonly hotIntervalMinutes: number;
  readonly coldIntervalHours: number;
  readonly keepRecent: number;
  readonly keepDaily: number;
  readonly keepWeekly: number;
}

function r2KeysFrom(config: R2Config | null): R2KeysForm {
  return {
    endpoint: config?.endpoint ?? '',
    bucket: config?.bucket ?? '',
    accessKeyId: config?.accessKeyIdMasked ? SECRET_MASK : '',
    secretAccessKey: config?.secretAccessKeyConfigured ? SECRET_MASK : '',
  };
}

function r2ScheduleFrom(config: R2Config | null): R2ScheduleForm {
  return {
    hotIntervalMinutes: config?.schedule.hotIntervalMinutes ?? 5,
    coldIntervalHours: config?.schedule.coldIntervalHours ?? 6,
    keepRecent: config?.retention.keepRecent ?? 24,
    keepDaily: config?.retention.keepDaily ?? 30,
    keepWeekly: config?.retention.keepWeekly ?? 0,
  };
}

/*
 * The R2 schedule, asked as two plain questions.
 *
 * The dialog used to ask for six numbers, three of them retention: "keep
 * recovery points", "then keep one a day", "then keep one a week". Each was
 * accurate and together they were a puzzle - nobody could say how far back
 * 48, 14 and 8 let them go without working it out. The question people have
 * is how far back, so that is what is asked, and each answer is a set of the
 * same numbers the server has always taken. The numbers are still there, under
 * "Exact numbers", and a combination that matches no answer reads as Custom.
 */
const CUSTOM_CHOICE = 'custom';
const R2_UPLOAD_CHOICES = [
  { id: '5m', label: 'console.every5Minutes', hotIntervalMinutes: 5, coldIntervalHours: 6 },
  { id: '15m', label: 'console.every15Minutes', hotIntervalMinutes: 15, coldIntervalHours: 12 },
  { id: '1h', label: 'console.everyHour', hotIntervalMinutes: 60, coldIntervalHours: 24 },
] as const;
const R2_HISTORY_CHOICES = [
  { id: '7d', label: 'console.r2Back7Days', keepRecent: 24, keepDaily: 7, keepWeekly: 0 },
  { id: '30d', label: 'console.r2Back30Days', keepRecent: 24, keepDaily: 30, keepWeekly: 0 },
  { id: '3m', label: 'console.r2Back3Months', keepRecent: 24, keepDaily: 14, keepWeekly: 13 },
  { id: '1y', label: 'console.r2Back1Year', keepRecent: 24, keepDaily: 14, keepWeekly: 52 },
] as const;
/** How often the backup library takes a local copy. Not an R2 setting. Off is `0`, set by the switch. */
const DEFAULT_LOCAL_INTERVAL = 30;
const LOCAL_BACKUP_CHOICES = [
  { id: '30m', label: 'console.every30Minutes', intervalMinutes: 30 },
  { id: '1h', label: 'console.everyHour', intervalMinutes: 60 },
  { id: '6h', label: 'console.every6Hours', intervalMinutes: 360 },
  { id: '1d', label: 'console.everyDay', intervalMinutes: 1440 },
] as const;
function uploadChoice(hotIntervalMinutes: number, coldIntervalHours: number) {
  return R2_UPLOAD_CHOICES.find((choice) => choice.hotIntervalMinutes === hotIntervalMinutes && choice.coldIntervalHours === coldIntervalHours);
}

function historyChoice(keepRecent: number, keepDaily: number, keepWeekly: number) {
  return R2_HISTORY_CHOICES.find((choice) => choice.keepRecent === keepRecent && choice.keepDaily === keepDaily && choice.keepWeekly === keepWeekly);
}

/** The schedule in one line, for the card: "Every 5 minutes · 30 days back". */
function r2ScheduleSummary(t: Translate, config: R2Config): string {
  const upload = uploadChoice(config.schedule.hotIntervalMinutes, config.schedule.coldIntervalHours);
  const history = historyChoice(config.retention.keepRecent, config.retention.keepDaily, config.retention.keepWeekly);
  return `${upload ? t(upload.label) : t('console.r2Custom')} · ${history ? t('console.r2BackFor', { period: t(history.label) }) : t('console.r2Custom')}`;
}

/**
 * The profiles, the backups and the off-machine copy.
 *
 * The page used to be three cards of exposed machinery: a disclosure triangle
 * hiding a text box, a list of archives with four buttons on every row, and
 * eleven R2 settings sitting open on the page whether or not anybody had a
 * bucket. Nothing could be searched, a long list of backups could only be
 * scrolled, and the two questions that cannot be undone - restoring over a
 * profile and deleting an archive - were asked by `window.confirm` and
 * `window.prompt`, which cannot be translated and ask in the browser's voice
 * rather than this program's.
 *
 * Each card now asks one thing and keeps the rest behind a dialog, and the
 * archives are a table that can be searched, sorted and paged.
 */
function DataPage({ t, locale, fail, catalog, csrfToken, profiles, activeProfileId, backups, onProfilesChange, onBackupsChange }: { t: Translate; locale: string; fail: Fail; catalog: Record<string, unknown>; csrfToken: string; profiles: Profile[]; activeProfileId: string | null; backups: BackupManifest[]; onProfilesChange: (profiles: Profile[], activeProfileId: string | null) => void; onBackupsChange: (backups: BackupManifest[]) => void }) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /*
   * The one thing on this page that is state rather than a result.
   *
   * A restore stopped halfway leaves the profile part old and part new. That
   * is true until somebody does something about it, so it stays on the page;
   * everything else here happened once and is said once, in a toast.
   */
  const [mixedProfile, setMixedProfile] = useState<string | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('replace');
  const [selectedBackup, setSelectedBackup] = useState<BackupManifest | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<RestorePreview | null>(null);
  const [operationProgress, setOperationProgress] = useState<{ percent: number; step: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  // What the Stop button acts on: a server job by id, or the upload in flight.
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const [r2Config, setR2Config] = useState<R2Config | null>(null);
  /**
   * Whether this machine keeps what is written to it.
   *
   * Null until the first answer arrives, and the notice below waits for it:
   * a warning that appears and then takes itself back is worse than one that
   * arrives a moment late.
   */
  const [storage, setStorage] = useState<StorageDurabilityReport | null>(null);
  const [backupSchedule, setBackupSchedule] = useState<LocalBackupSchedule | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [r2Snapshots, setR2Snapshots] = useState<R2SnapshotSummary[]>([]);
  const [r2Busy, setR2Busy] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BackupManifest | null>(null);
  const [kindFilter, setKindFilter] = useState<BackupKind | 'all'>('all');
  // Which archive is being deleted, and whether the question is on screen. The
  // two are separate because the dialog fades out: clearing the row at the same
  // moment left the title reading "Delete ?" for the length of the animation.
  const [deleteTarget, setDeleteTarget] = useState<BackupManifest | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /*
   * Where the data goes and how often are two questions, so they are two forms.
   *
   * "Where" is one form for both ways of answering it. A sign-in and a key pair
   * are two answers to one question, and as two rows on the card - each with
   * its own hint, its own button and its own state - they read as two things
   * that both needed doing. One dialog, one choice, and the card keeps a single
   * line saying which answer is in force.
   */
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [r2ScheduleOpen, setR2ScheduleOpen] = useState(false);
  /*
   * The Cloudflare sign-in address, when this page could not open it itself.
   *
   * Kept on the page rather than announced and taken away again. It used to be
   * a toast: the one case where the reader has to do something with a link is
   * the one case where the link must not vanish while they look for somewhere
   * to put it.
   */
  const [cloudflareSignInUrl, setCloudflareSignInUrl] = useState<string | null>(null);
  const [r2Toggling, setR2Toggling] = useState(false);
  const [cloudflareBusy, setCloudflareBusy] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  // What the last look at the bucket found. Kept on the card, because an answer
  // that disappears two seconds after it arrives is not an answer.
  const [r2Check, setR2Check] = useState<R2CheckResult | null>(null);
  // The usage panel owns its own fetch; this lets one press of Check bring it
  // up to date too, instead of a second button that only refreshes.
  const usageRefresh = useRef<(() => void) | null>(null);
  // Newest first: the archive somebody wants is nearly always the last one taken.
  const [backupQuery, setBackupQuery] = useState<TableQuery>(() => initialQuery({ sort: 'createdAt', direction: 'desc' }));
  const [snapshotQuery, setSnapshotQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 5, sort: 'createdAt', direction: 'desc' }));
  const busy = busyAction !== null;
  const labels = tableLabels(t);
  const { toast } = useToast();
  const done = (title: string) => toast({ title, tone: 'success' });
  const failed = (title: string) => toast({ title, tone: 'destructive' });
  const jobStep = (job: Job) => translateStep(job.step, catalog, job.stepCode, job.stepParams);
  const refresh = async () => {
    const [profileResponse, backupResponse, r2Response, snapshotResponse, scheduleResponse] = await Promise.all([apiFetch('/api/v1/profiles', { credentials: 'same-origin' }), apiFetch('/api/v1/backups', { credentials: 'same-origin' }), apiFetch('/api/v1/r2', { credentials: 'same-origin' }), apiFetch('/api/v1/r2/snapshots', { credentials: 'same-origin' }).catch(() => null), apiFetch('/api/v1/backups/schedule', { credentials: 'same-origin' }).catch(() => null)]);
    // Listing recovery points needs the bucket, so it is the one call here that
    // fails when R2 is off or unreachable. That must not blank the page.
    if (snapshotResponse?.ok) {
      const payload = await snapshotResponse.json() as { snapshots: R2SnapshotSummary[] };
      setR2Snapshots(payload.snapshots);
    } else setR2Snapshots([]);
    if (profileResponse.ok) { const payload = await profileResponse.json() as { profiles: Profile[]; activeProfileId: string | null }; onProfilesChange(payload.profiles, payload.activeProfileId); }
    if (backupResponse.ok) { const payload = await backupResponse.json() as { backups: BackupManifest[] }; onBackupsChange(payload.backups); }
    if (r2Response.ok) {
      const payload = await r2Response.json() as { config: R2Config; storage?: StorageDurabilityReport };
      setR2Config(payload.config);
      if (payload.storage) setStorage(payload.storage);
    }
    if (scheduleResponse?.ok) setBackupSchedule((await scheduleResponse.json() as { schedule: LocalBackupSchedule }).schedule);
  };
  useEffect(() => { void refresh(); }, []);

  /*
   * Coming back from Cloudflare.
   *
   * The server finished the sign-in before the browser got here and says how it
   * went in the address. That is said once, then taken out of the address so a
   * reload does not say it again.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('cloudflare');
    if (!outcome) return;
    const code = params.get('cloudflare_error') ?? '';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
    if (outcome === 'connected') {
      void apiFetch('/api/v1/r2', { credentials: 'same-origin' })
        .then(async (response) => (response.ok ? (await response.json() as { config: R2Config }).config : null))
        .then((config) => {
          toast({ title: t('console.cfConnected', { bucket: config?.cloudflare?.bucket ?? '' }), tone: 'success', duration: 8000 });
          if (config) setR2Config(config);
          // Reading the bucket is how anyone finds out whether the connection
          // they just made actually works, and it was left as a button to
          // press. Asked here instead, so what the reader comes back to is the
          // answer rather than another thing to do.
          void checkAfterConnect(config);
        })
        .catch(() => undefined);
    } else if (outcome === 'choose_account') {
      // The sign-in worked and the only thing left is a choice, so the form
      // that holds that choice opens rather than being described in a message
      // the reader then has to go and act on.
      toast({ title: t('console.cfChooseNow'), tone: 'success', duration: 8000 });
      setDestinationOpen(true);
    } else {
      failed(cloudflareErrorText(t, code));
    }
  }, []);

  /*
   * The R2 card follows the scheduler the same way the list does.
   *
   * Reading the settings is local and free. Listing recovery points is a
   * charged request to the bucket, so it is made only when the last upload
   * time says there is a new one to list.
   */
  const lastUploadSeen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await apiFetch('/api/v1/r2', { credentials: 'same-origin' });
        if (!response.ok || cancelled) return;
        const config = (await response.json() as { config: R2Config }).config;
        if (cancelled) return;
        setR2Config(config);
        const previous = lastUploadSeen.current;
        lastUploadSeen.current = config.lastUploadAt;
        if (previous !== undefined && previous !== config.lastUploadAt && config.configured) {
          const snapshots = await apiFetch('/api/v1/r2/snapshots', { credentials: 'same-origin' });
          if (snapshots.ok && !cancelled) setR2Snapshots((await snapshots.json() as { snapshots: R2SnapshotSummary[] }).snapshots);
        }
      } catch {
        // The next poll tries again.
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // A restore runs in the server for minutes. Reloading the page must show the
  // one already in flight rather than an idle screen the operator would be
  // tempted to start a second restore from.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let kind: Job['kind'] | null = null;
      try {
        const response = await apiFetch('/api/v1/jobs/active', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json() as { job: Job | null };
        if (cancelled || !payload.job) return;
        const running = payload.job;
        kind = running.kind;
        setBusyAction(running.kind === 'restore' ? t('console.restore') : t('dashboard.backupNow'));
        setOperationProgress({ percent: running.progress, step: jobStep(running) });
        setRunningJobId(running.id);
        await waitForOperation(running.id, (job) => { if (!cancelled) setOperationProgress({ percent: job.progress, step: jobStep(job) }); });
        if (!cancelled) await refresh();
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof StoppedError) done(t(kind === 'restore' ? 'console.restoreStopped' : 'console.backupStopped'));
        else if (error instanceof RollbackFailedError) setMixedProfile(t('console.restoreStoppedPartway'));
        else failed(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
      } finally {
        if (!cancelled) { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * Stop whatever is running now.
   *
   * An upload is stopped in the browser, because that is where the bytes still
   * are. A backup or restore is stopped in the server, which is where the work
   * is; it stops between whole files and the pre-restore snapshot is the way
   * back from a restore that got part of the way through.
   */
  const stopOperation = async () => {
    if (stopping) return;
    // "Stopping" from the press until the work has actually ended, not only
    // for as long as the request takes: a restore putting the data back runs
    // on for minutes, and a button that came back pressable in that time
    // invited pressing it again and again.
    setStopping(true);
    try {
      uploadAbort.current?.abort();
      if (runningJobId) {
        const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(runningJobId)}/cancel`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
        // Refused because it had already finished is not worth a second press either.
        if (!response.ok && response.status !== 409) setStopping(false);
      }
    } catch {
      setStopping(false);
    }
  };
  useEffect(() => { if (busyAction === null && r2Busy === null) setStopping(false); }, [busyAction, r2Busy]);

  // Chunks are held in the browser until the last one lands, so a reload or a
  // navigation away throws the whole upload out. Warn before that happens.
  useEffect(() => {
    if (!uploading) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const createProfile = async (name: string): Promise<string | null> => {
    setBusyAction(t('console.newProfile'));
    try {
      const response = await apiFetch('/api/v1/profiles', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name, layout: 'data' }) });
      if (!response.ok) return fail.body(await response.json(), t('console.profileCreateFailed'));
      await refresh();
      return null;
    } catch { return t('console.profileCreateFailed'); } finally { setBusyAction(null); }
  };
  const activate = async (id: string) => {
    setBusyAction(t('console.switchProfile'));
    try {
      const response = await apiFetch(`/api/v1/profiles/${id}/activate`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { failed(fail.body(await response.json(), t('console.profileActivateFailed'))); return; }
      await refresh();
    } catch { failed(t('console.profileActivateFailed')); } finally { setBusyAction(null); }
  };
  /**
   * Start a backup and follow it on the page.
   *
   * "Back up now" is the automatic backup taken early - no name, no dialog,
   * and it replaces the previous automatic one. "Manual backup" asks for a
   * name and is kept. Either way the answer returns as soon as the server has
   * accepted the job, so the dialog closes at once and the progress is shown
   * where the Stop button is.
   */
  const startBackup = async (kind: 'scheduled' | 'manual', name = ''): Promise<string | null> => {
    const label = kind === 'scheduled' ? t('dashboard.backupNow') : t('console.manualBackup');
    setBusyAction(label); setOperationProgress(null);
    let jobId: string;
    try {
      const response = await apiFetch('/api/v1/backups', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ kind, ...(name ? { name } : {}) }) });
      const payload = await response.json() as { jobId?: string; unchanged?: boolean; error?: { message?: string } };
      if (response.ok && payload.unchanged) { setBusyAction(null); toast({ title: t('console.backupUpToDate'), tone: 'default' }); return null; }
      if (!response.ok || !payload.jobId) { setBusyAction(null); return fail.body(payload, t('console.backupCreateFailed')); }
      jobId = payload.jobId;
    } catch { setBusyAction(null); return t('console.backupCreateFailed'); }
    setRunningJobId(jobId);
    void (async () => {
      try {
        await waitForOperation(jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
        await refresh();
        done(t('console.backupDone'));
      } catch (error: unknown) {
        // Stopping is an answer rather than a failure; the list says what is there.
        if (error instanceof StoppedError) { await refresh(); done(t('console.backupStopped')); }
        else failed(error instanceof Error ? error.message : t('console.backupCreateFailed'));
      } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
    })();
    return null;
  };
  const waitForOperation = async (jobId: string, onUpdate: (job: Job) => void): Promise<Job> => {
    for (;;) {
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(t('console.backupRestoreFailed'));
      const job = await response.json() as Job;
      onUpdate(job);
      if (job.state === 'succeeded') return job;
      if (job.state === 'canceled') throw new StoppedError();
      if (job.state === 'failed' && job.stepCode === 'job.rollbackFailed') throw new RollbackFailedError(job.error ?? t('console.backupRestoreFailed'));
      if (job.state === 'failed') throw new Error(job.error ?? t('console.backupRestoreFailed'));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 700));
    }
  };
  const previewBackup = async (backup: BackupManifest) => {
    setBusyAction(t('console.restore'));
    try {
      await openRestoreFor(backup);
    } finally { setBusyAction(null); }
  };
  /**
   * Look inside an archive and ask what to do with it.
   *
   * Shared by the Restore menu item and by whatever has just put an archive in
   * the library - an uploaded zip, a recovery point brought back from R2 - so
   * all three end at the same question instead of one of them ending at a
   * notification and a list to go hunting through.
   */
  /** One archive by id, asked for straight rather than found again in the list. */
  const readBackup = async (backupId: string): Promise<BackupManifest | null> => {
    try {
      const response = await apiFetch(`/api/v1/backups/${encodeURIComponent(backupId)}`, { credentials: 'same-origin' });
      return response.ok ? await response.json() as BackupManifest : null;
    } catch { return null; }
  };
  const openRestoreFor = async (backup: BackupManifest): Promise<boolean> => {
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}/preview`, { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as RestorePreview | { error?: { message?: string } };
      if (!response.ok || !('files' in payload)) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return false; }
      setRestoreMode('replace');
      setSelectedBackup(backup); setSelectedPreview(payload);
      return true;
    } catch { failed(t('console.backupPreviewFailed')); return false; }
  };
  const closeRestore = () => { setSelectedBackup(null); setSelectedPreview(null); };
  const restoreSelected = async () => {
    if (!selectedBackup || !selectedPreview) return;
    const backupId = selectedBackup.id;
    // The question has been answered, so the dialog goes before the work
    // starts: what happens next belongs on the page, where the Stop button is.
    closeRestore();
    setBusyAction(t('console.restore')); setOperationProgress(null); setMixedProfile(null);
    try {
      const response = await apiFetch(`/api/v1/backups/${backupId}/restore`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: restoreMode }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.backupRestoreFailed'))); return; }
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      done(t('console.restoreDone'));
    } catch (error: unknown) {
      // A stopped restore is put back by the server before it reports, so a
      // stop is a result to glance at. Only a stop that could not be put back
      // leaves the profile mixed, and that stays on the page.
      if (error instanceof StoppedError) { done(t('console.restoreStopped')); await refresh(); }
      else if (error instanceof RollbackFailedError) { setMixedProfile(t('console.restoreStoppedPartway')); await refresh(); }
      else failed(error instanceof Error ? error.message : t('console.backupRestoreFailed'));
    } finally { setBusyAction(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const inspectUpload = async (file: File | undefined) => {
    if (!file) return;
    setBusyAction(t('console.importZip')); setOperationProgress(null); setUploading(true);
    const controller = new AbortController();
    uploadAbort.current = controller;
    const uploadId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      let index = 0;
      // Rate over the last few seconds rather than over the whole upload, so a
      // connection that has just slowed down says so instead of averaging the
      // slowdown away against the minutes that went before it.
      const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: 0 }];
      for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
        const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
        await uploadChunkWithRetry(
          `/api/v1/backups/import/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,
          file.slice(offset, end),
          { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken, accept: 'application/json' },
          { fail, failed: t('console.uploadFailed'), proxyPage: t('console.uploadProxyPage') },
          controller.signal,
        );
        index += 1;
        const at = Date.now();
        samples.push({ at, bytes: end });
        while (samples.length > 2 && at - (samples[0]?.at ?? at) > UPLOAD_RATE_WINDOW_MS) samples.shift();
        const oldest = samples[0] ?? { at, bytes: 0 };
        const elapsedMs = at - oldest.at;
        const bytesPerSecond = elapsedMs > 0 ? ((end - oldest.bytes) / elapsedMs) * 1000 : 0;
        const remaining = bytesPerSecond > 0 ? `${formatDuration((file.size - end) / bytesPerSecond)} ${t('console.uploadRemaining')}` : t('console.uploadEstimating');
        setOperationProgress({
          percent: Math.round((end / Math.max(file.size, 1)) * 100),
          step: `${t('console.uploading')} ${formatBytes(end)} / ${formatBytes(file.size)} · ${formatBytes(Math.round(bytesPerSecond))}/s · ${remaining}`,
        });
      }
      // Every chunk is on the server now, so it owns the rest of the work and
      // leaving the page no longer loses anything.
      setUploading(false);
      setOperationProgress({ percent: 100, step: t('console.importFinishing') });
      const response = await apiFetch('/api/v1/backups/import/finish', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ uploadId, name: file.name, expectedBytes: file.size }) });
      const text = await response.text();
      let payload: (RestorePreview & { backup?: BackupManifest }) | { error?: { message?: string } };
      try { payload = JSON.parse(text) as (RestorePreview & { backup?: BackupManifest }) | { error?: { message?: string } }; }
      catch { throw new Error(apiErrorFromText(text, response.status, t('console.backupPreviewFailed'), fail, t('console.uploadProxyPage'))); }
      if (!response.ok || !('files' in payload)) { failed(fail.body(payload, t('console.backupPreviewFailed'))); return; }
      if (!payload.backup) { failed(t('console.backupPreviewFailed')); return; }
      setRestoreMode('replace');
      setSelectedBackup(payload.backup); setSelectedPreview(payload);
      await refresh();
    } catch (error: unknown) {
      // The part file on the server is worth nothing without the rest of it,
      // whether the upload failed or the operator stopped it.
      await apiFetch(`/api/v1/backups/import/chunk?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } }).catch(() => undefined);
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.backupPreviewFailed'));
    } finally { uploadAbort.current = null; setBusyAction(null); setOperationProgress(null); setUploading(false); }
  };
  const renameBackup = async (name: string): Promise<string | null> => {
    if (!renameTarget) return null;
    setBusyAction(t('common.rename'));
    try {
      const response = await apiFetch(`/api/v1/backups/${renameTarget.id}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name }) });
      if (!response.ok) return fail.body(await response.json(), t('console.backupRenameFailed'));
      await refresh();
      return null;
    } catch { return t('console.backupRenameFailed'); } finally { setBusyAction(null); }
  };
  const deleteBackup = async () => {
    if (!deleteTarget) return;
    const backup = deleteTarget;
    setBusyAction(t('common.delete'));
    try {
      const response = await apiFetch(`/api/v1/backups/${backup.id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (!response.ok) { failed(fail.body(await response.json(), t('console.backupDeleteFailed'))); return; }
      if (selectedBackup?.id === backup.id) closeRestore();
      await refresh();
    } catch { failed(t('console.backupDeleteFailed')); } finally { setBusyAction(null); setDeleteOpen(false); }
  };
  const putR2 = async (body: Record<string, unknown>): Promise<string | null> => {
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) return fail.body(payload, t('console.r2SaveFailed'));
      setR2Config(payload.config);
      done(t('console.r2Saved'));
      void refresh().catch(() => undefined);
      return null;
    } catch { return t('console.r2SaveFailed'); }
  };
  /**
   * Saving keys is choosing them over the Cloudflare sign-in.
   *
   * The two ways of reaching a bucket are never both in use, and this form is
   * the one that says "use the keys" - which is why the switch is asked for
   * before the form opens, not silently applied after it.
   */
  const saveR2Keys = async (form: R2KeysForm & { readonly enabled?: boolean }): Promise<string | null> => await putR2({ ...form, mode: 'keys' });
  const saveR2Schedule = async (form: R2ScheduleForm): Promise<string | null> => await putR2({ ...form });
  // The switch lives on the card, not at the bottom of the settings dialog:
  // whether anything is being sent at all is the first thing to see, and
  // turning it off should not mean opening the connection settings to do it.
  // Turning the schedule off stores 0, which forgets the interval; turning it
  // back on brings back the one last seen here, or the default.
  const lastInterval = useRef(DEFAULT_LOCAL_INTERVAL);
  useEffect(() => { if (backupSchedule && backupSchedule.intervalMinutes > 0) lastInterval.current = backupSchedule.intervalMinutes; }, [backupSchedule]);
  const saveBackupSchedule = async (intervalMinutes: number) => {
    setScheduleSaving(true);
    try {
      const response = await apiFetch('/api/v1/backups/schedule', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ intervalMinutes }) });
      const payload = await response.json() as { schedule?: LocalBackupSchedule; error?: { message?: string } };
      if (!response.ok || !payload.schedule) { failed(fail.body(payload, t('console.localScheduleFailed'))); return; }
      setBackupSchedule(payload.schedule);
      done(t('console.localScheduleSaved'));
    } catch { failed(t('console.localScheduleFailed')); } finally { setScheduleSaving(false); }
  };
  const setR2Enabled = async (enabled: boolean) => {
    setR2Toggling(true);
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ enabled }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.r2SaveFailed'))); return; }
      setR2Config(payload.config);
      done(t(enabled ? 'console.r2TurnedOn' : 'console.r2TurnedOff'));
    } catch { failed(t('console.r2SaveFailed')); } finally { setR2Toggling(false); }
  };
  const connectCloudflare = async () => {
    setCloudflareSignInUrl(null);
    // Cloudflare's sign-in refuses to load in a frame. When the panel is shown
    // inside another page, the sign-in gets a tab of its own, opened now while
    // the click still counts as one so it is not taken for a pop-up.
    const framed = window.self !== window.top;
    const tab = framed ? window.open('', '_blank') : null;
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/connect', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || !payload.url) { tab?.close(); failed(fail.body(payload, t('console.cfConnectFailed'))); return; }
      if (tab) { tab.location.href = payload.url; return; }
      // A frame that is not allowed to open tabs leaves nowhere to send the
      // reader: this one cannot show Cloudflare's sign-in, and sending it
      // somewhere it will be refused would only blank the console. So hand
      // over the address instead and let them open it themselves.
      if (framed) {
        setCloudflareSignInUrl(payload.url);
        return;
      }
      window.location.assign(payload.url);
    } catch { tab?.close(); failed(t('console.cfConnectFailed')); } finally { setCloudflareBusy(false); }
  };
  const chooseCloudflareAccount = async (accountId: string): Promise<string | null> => {
    if (!accountId) return null;
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/account', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ accountId }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      // An account that has never turned R2 on fails here with everything else
      // in order. The refusal is on the connection now, so the card says it
      // and keeps saying it; this only has to not swallow it.
      if (!response.ok || !payload.config) { const message = fail.body(payload, t('console.cfConnectFailed')); failed(message); await refresh(); return message; }
      setR2Config(payload.config);
      done(t('console.cfConnected', { bucket: payload.config.cloudflare?.bucket ?? '' }));
      await refresh();
      await checkAfterConnect(payload.config);
      return null;
    } catch { failed(t('console.cfConnectFailed')); return t('console.cfConnectFailed'); } finally { setCloudflareBusy(false); }
  };
  /** Back up to another bucket of the account already signed in to. */
  const chooseCloudflareBucket = async (name: string): Promise<string | null> => {
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/bucket', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ name }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) return fail.body(payload, t('console.cfBucketFailed'));
      setR2Config(payload.config);
      done(t('console.cfBucketSaved', { bucket: payload.config.cloudflare?.bucket ?? name }));
      void refresh().catch(() => undefined);
      return null;
    } catch { return t('console.cfBucketFailed'); }
  };
  const disconnectCloudflare = async () => {
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2/cloudflare/disconnect', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { revoked?: boolean; config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.cfDisconnectFailed'))); return; }
      setR2Config(payload.config);
      if (payload.revoked) done(t('console.cfDisconnected'));
      else toast({ title: t('console.cfDisconnectedNotRevoked'), tone: 'destructive', duration: 12000 });
      await refresh();
    } catch { failed(t('console.cfDisconnectFailed')); } finally { setCloudflareBusy(false); }
  };
  const backUpToCloudflare = async () => {
    setCloudflareBusy(true);
    try {
      const response = await apiFetch('/api/v1/r2', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ mode: 'cloudflare', enabled: true }) });
      const payload = await response.json() as { config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.config) { failed(fail.body(payload, t('console.r2SaveFailed'))); return; }
      setR2Config(payload.config);
      done(t('console.cfConnected', { bucket: payload.config.cloudflare?.bucket ?? '' }));
      await refresh();
      await checkAfterConnect(payload.config);
    } catch { failed(t('console.r2SaveFailed')); } finally { setCloudflareBusy(false); }
  };
  /**
   * The one question about the bucket, asked once.
   *
   * There used to be three buttons here - Test connection, Check the bucket,
   * Refresh - that between them proved the credentials, brought the counts back
   * in line and re-read Cloudflare's figures. Each was a separate press with a
   * separate name, two of them read as the same thing, and all three answered
   * with a notification that said it had worked and then went away. They are
   * one press now, and the answer stays on the card.
   */
  const checkR2 = async () => {
    setR2Busy(t('console.r2Checking'));
    try {
      const response = await apiFetch('/api/v1/r2/check', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { check?: R2CheckResult; config?: R2Config; error?: { message?: string } };
      if (!response.ok || !payload.check) { failed(fail.body(payload, t('console.r2TestFailed'))); return; }
      setR2Check(payload.check);
      if (payload.config) setR2Config(payload.config);
      // What Cloudflare itself reports is the other half of the same question,
      // so one press asks for both rather than leaving a Refresh behind.
      usageRefresh.current?.();
      await refresh();
    } catch { failed(t('console.r2TestFailed')); } finally { setR2Busy(null); }
  };
  /**
   * Read the bucket once, straight after a connection is made.
   *
   * Only when there is something to read: the check needs backups to be on and
   * the destination settled, and asking before that is a refusal the reader did
   * nothing to cause. A failure here is the useful kind - it is the connection
   * they just made, said plainly on the card while they are still looking at it.
   */
  const checkAfterConnect = async (config: R2Config | null) => {
    if (!config?.enabled || !config.configured) return;
    if (config.mode === 'cloudflare' && config.cloudflare?.state !== 'connected') return;
    await checkR2();
  };
  const uploadR2 = async () => {
    setR2Busy(t('console.r2UploadLatest'));
    setOperationProgress(null);
    try {
      const response = await apiFetch('/api/v1/r2/sync', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.r2UploadFailed'))); return; }
      // A first upload is gigabytes. It runs in the server and is followed the
      // same way a restore is, so the bar says how far it has got and the Stop
      // button reaches the work rather than only this page.
      setRunningJobId(payload.jobId);
      await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh(); done(t('console.r2Uploaded'));
    } catch (error: unknown) {
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.r2UploadFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  /**
   * Bring one recovery point back as a local archive.
   *
   * It lands in the backup library rather than being written into the profile,
   * so restoring it is the same preview, the same safety snapshot and the same
   * merge-or-replace choice as any other archive - and the operator gets to
   * look at it first.
   */
  const fetchSnapshot = async (snapshot: R2SnapshotSummary) => {
    setR2Busy(t('console.r2Fetch'));
    setOperationProgress(null);
    try {
      // Which profile in the bucket wrote it, which for a point from another
      // machine is not this one. The chunks are shared, so reading it from
      // there and restoring it here costs nothing extra.
      const response = await apiFetch(`/api/v1/r2/snapshots/${encodeURIComponent(snapshot.id)}/fetch`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ profileId: snapshot.profileId }) });
      const payload = await response.json() as { jobId?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) { failed(fail.body(payload, t('console.r2FetchFailed'))); return; }
      setRunningJobId(payload.jobId);
      const finished = await waitForOperation(payload.jobId, (job) => setOperationProgress({ percent: job.progress, step: jobStep(job) }));
      await refresh();
      /*
       * Ask what to do with it, the way an uploaded zip is asked about.
       *
       * Bringing a recovery point back and restoring it are one intention,
       * split in two only because the archive has to exist before it can be
       * looked inside. Ending at a notification left the reader to go and find
       * the row themselves, in a list where the thing they had just downloaded
       * looked like everything else in it.
       */
      const landed = finished.resultBackupId ? await readBackup(finished.resultBackupId) : null;
      if (landed && await openRestoreFor(landed)) return;
      toast({ title: t('console.r2Fetched'), tone: 'success', duration: 8000 });
    } catch (error: unknown) {
      if (!(error instanceof StoppedError)) failed(error instanceof Error ? error.message : t('console.r2FetchFailed'));
    } finally { setR2Busy(null); setOperationProgress(null); setRunningJobId(null); }
  };
  const removeLegacy = async () => {
    setR2Busy(t('console.r2LegacyRemove'));
    try {
      const response = await apiFetch('/api/v1/r2/legacy', { method: 'DELETE', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      const payload = await response.json() as { removed?: number; error?: { message?: string } };
      if (!response.ok) { failed(fail.body(payload, t('console.r2LegacyRemoveFailed'))); return; }
      await refresh(); done(t('console.r2LegacyRemoved'));
    } catch { failed(t('console.r2LegacyRemoveFailed')); } finally { setR2Busy(null); }
  };

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;
  const localChoice = backupSchedule ? LOCAL_BACKUP_CHOICES.find((choice) => choice.intervalMinutes === backupSchedule.intervalMinutes) : undefined;
  const displayName = (backup: BackupManifest) => backupDisplayName(t, locale, backup);
  const backupColumns: DataTableColumn<BackupManifest>[] = [
    // The kind rides under the name on a phone, where there is no room for a
    // column of its own, and has its column from `md` up.
    { id: 'name', header: t('common.name'), sortable: true, cell: (backup) => <span className="grid min-w-0 justify-items-start gap-1"><span className="font-medium break-all" title={backup.name}>{displayName(backup)}</span><span className="md:hidden"><BackupKindBadge t={t} kind={backupKind(backup)} /></span></span> },
    { id: 'kind', header: t('console.backupKind'), sortable: true, showFrom: 'md', cell: (backup) => <BackupKindBadge t={t} kind={backupKind(backup)} /> },
    { id: 'createdAt', header: t('console.backupCreated'), sortable: true, showFrom: 'sm', cell: (backup) => <span className="whitespace-nowrap text-muted-foreground">{new Date(backup.createdAt).toLocaleString()}</span> },
    { id: 'sizeBytes', header: t('console.backupSize'), sortable: true, align: 'end', showFrom: 'sm', cell: (backup) => <span className="whitespace-nowrap text-muted-foreground">{formatBytes(backup.sizeBytes)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('console.backupActions')}</span>,
      align: 'end',
      headClassName: 'w-12',
      cell: (backup) => <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('console.backupRowMenu')} disabled={busy}><Ellipsis /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void previewBackup(backup)}><RotateCcw />{t('console.restore')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { window.location.href = `/api/v1/backups/${backup.id}/download`; }}><Download />{t('console.downloadBackup')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenameTarget(backup)}><Pencil />{t('common.rename')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => { setDeleteTarget(backup); setDeleteOpen(true); }}><Trash2 />{t('common.delete')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    },
  ];
  const cloudflare = r2Config?.cloudflare ?? null;
  // Backups go through the signed-in account, as opposed to it merely being connected.
  const signedIn = r2Config?.mode === 'cloudflare' && cloudflare?.state === 'connected';
  const keysConfigured = Boolean(r2Config?.endpoint && r2Config.bucket && r2Config.accessKeyIdMasked && r2Config.secretAccessKeyConfigured);
  const destination = destinationText(t, r2Config);
  /*
   * When, how big, and the one thing to do with it.
   *
   * There used to be two more columns: which profile in the bucket wrote the
   * point, and how many files it holds. Neither is a question anybody asks of
   * this table - every row is the same person's data, and a file count says
   * nothing a size does not say better - and between them they took the width
   * that the three columns that are read need on a phone. The row now fits on
   * one line at any width.
   */
  const snapshotColumns: DataTableColumn<R2SnapshotSummary>[] = [
    {
      id: 'createdAt',
      header: t('console.backupCreated'),
      sortable: true,
      // Digits rather than the locale's long form below `sm`: "18:05
      // 18/09/2026" is half the width of what `toLocaleString` writes and is
      // read the same way in both languages.
      cell: (snapshot) => <span className="whitespace-nowrap">
        <span className="sm:hidden">{shortWhen(snapshot.createdAt)}</span>
        <span className="hidden sm:inline">{new Date(snapshot.createdAt).toLocaleString()}</span>
      </span>,
    },
    // The data the point holds, which is what bringing it back downloads. The
    // index object alone - what this column used to show - is a few hundred
    // kilobytes whatever the profile weighs.
    { id: 'dataBytes', header: t('console.backupSize'), sortable: true, align: 'end', cell: (snapshot) => <span className="whitespace-nowrap text-muted-foreground">{snapshot.dataBytes === null ? '—' : formatBytes(snapshot.dataBytes)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('console.backupActions')}</span>,
      align: 'end',
      headClassName: 'w-28',
      // Not "Download": nothing leaves for the reader to carry off. The point
      // comes back into this manager's backup library, to be restored from there.
      cell: (snapshot) => <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={() => void fetchSnapshot(snapshot)} disabled={r2Busy !== null}><History />{t('console.r2Fetch')}</Button>,
    },
  ];

  return <div className="grid min-w-0 gap-4">
    <Card>
      <PanelHeading icon={<UsersIcon />} action={<Button variant="outline" size="sm" onClick={() => setProfileOpen(true)} disabled={busy}><Plus />{t('console.newProfile')}</Button>}>{t('console.profilesTitle')}</PanelHeading>
      <CardContent>
        {activeProfile === null
          ? <EmptyState icon={<UsersIcon />} title={t('console.noProfiles')} />
          : <Field label={t('console.switchProfile')}>
            <Select value={activeProfile.id} onValueChange={(id) => void activate(id)} disabled={busy}>
              <SelectTrigger className="w-full sm:max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>}
      </CardContent>
    </Card>

    <Card>
      <PanelHeading icon={<Archive />}>{t('console.backupLibrary')}</PanelHeading>
      <CardContent className="grid gap-4">
        {/* Here rather than in the R2 settings: it runs whether or not there is
            a bucket, so it has to be reachable without one. */}
        {backupSchedule ? <div>
          {/* On or off is a switch, the way every other on-or-off in the console
              is; how often is a separate question, asked only while it is on. */}
          <DetailRow label={t('console.localScheduleLabel')} {...(backupSchedule.intervalMinutes === 0 ? { hint: t('console.localScheduleOffHint') } : {})}>
            <Switch aria-label={t('console.localScheduleLabel')} checked={backupSchedule.intervalMinutes > 0} disabled={scheduleSaving} onCheckedChange={(on) => void saveBackupSchedule(on ? lastInterval.current : 0)} />
          </DetailRow>
          {backupSchedule.intervalMinutes > 0 ? <DetailRow label={t('console.localScheduleEvery')}>
            <Select value={localChoice?.id ?? CUSTOM_CHOICE} onValueChange={(id) => { const choice = LOCAL_BACKUP_CHOICES.find((item) => item.id === id); if (choice) void saveBackupSchedule(choice.intervalMinutes); }} disabled={scheduleSaving}>
              <SelectTrigger size="sm" className="w-40" aria-label={t('console.localScheduleEvery')}><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCAL_BACKUP_CHOICES.map((choice) => <SelectItem key={choice.id} value={choice.id}>{t(choice.label)}</SelectItem>)}
                {localChoice ? null : <SelectItem value={CUSTOM_CHOICE} disabled>{t('console.everyMinutes', { minutes: backupSchedule.intervalMinutes })}</SelectItem>}
              </SelectContent>
            </Select>
          </DetailRow> : null}
        </div> : null}
        {mixedProfile ? <Alert variant="destructive"><AlertDescription>{mixedProfile}</AlertDescription></Alert> : null}
        {busyAction ? <OperationProgress t={t} label={busyAction} progress={operationProgress} canStop={uploading || runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={uploading ? t('console.uploadKeepTabOpen') : null} /> : null}
        <DataTable
          rows={kindFilter === 'all' ? backups : backups.filter((backup) => backupKind(backup) === kindFilter)}
          columns={backupColumns}
          rowKey={(backup) => backup.id}
          query={backupQuery}
          onQueryChange={setBackupQuery}
          labels={labels}
          searchText={(backup) => `${displayName(backup)} ${backupSearchText(backup)}`}
          sortValue={(backup, column) => column === 'name' ? displayName(backup) : backupSortValue(backup, column)}
          empty={<EmptyState icon={<Archive />} title={t('dashboard.noBackup')} />}
          toolbar={<div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Select value={kindFilter} onValueChange={(value) => { setKindFilter(value as BackupKind | 'all'); setBackupQuery((current) => ({ ...current, page: 1 })); }}>
              <SelectTrigger size="sm" className="mr-auto w-44" aria-label={t('console.backupKind')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('console.backupKindAll')}</SelectItem>
                {BACKUP_KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(BACKUP_KIND_LABEL[kind])}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => void startBackup('scheduled').then((failure) => { if (failure) failed(failure); })} disabled={busy || activeProfileId === null}><Archive />{t('dashboard.backupNow')}</Button>
            <Button variant="outline" size="sm" onClick={() => setBackupOpen(true)} disabled={busy || activeProfileId === null}><BookmarkPlus />{t('console.manualBackup')}</Button>
            <label className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}>
              <Upload aria-hidden="true" />{t('console.importZip')}
              <input type="file" accept=".zip,application/zip" className="sr-only" disabled={busy} onChange={(event) => void inspectUpload(event.target.files?.[0])} />
            </label>
          </div>}
        />
      </CardContent>
    </Card>

    {/* Said above the card rather than inside it, because it is the reason to
        read the card at all. It stops being shown once backups are leaving this
        machine: at that point the storage is still temporary and it no longer
        costs the reader anything, so repeating it would only be noise. */}
    {storage && !storage.durable && !(r2Config?.enabled && r2Config.configured) ? <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{t('console.storageTemporaryTitle')}</AlertTitle>
      <AlertDescription>{t('console.storageTemporaryBody')}</AlertDescription>
    </Alert> : null}

    <Card className="cloud-card">
      <PanelHeading icon={<Cloud />}>
        {t('console.r2Title')}
        {/* The same mark the overview puts on the tunnel, for the same reason:
            of everything on this page, these two are what somebody who has not
            tried them is missing out on. */}
        <span className="access-badge"><Star />{t('console.r2Badge')}</span>
      </PanelHeading>
      <CardContent className="grid gap-4">
        {/* The address the dialog handed over, still here after the dialog has
            been closed on top of it. */}
        {cloudflareSignInUrl && !destinationOpen ? <CloudflareSignInBanner t={t} url={cloudflareSignInUrl} onDismiss={() => setCloudflareSignInUrl(null)} /> : null}
        {/* Said above the settings, and only while it is off: once it is on,
            this is a sales pitch for something the reader has already bought. */}
        {!(r2Config?.enabled && r2Config.configured) ? <p className="cloud-pitch">
          <ShieldCheck aria-hidden="true" />
          <span>{t('console.r2Pitch')}</span>
        </p> : null}
        {/*
          * An account that has never turned R2 on. Said first and said plainly,
          * because the sign-in worked, every permission asked for was granted,
          * and nothing else on this card can account for there still being no
          * bucket. It is also the only trouble here that is fixed somewhere
          * else, so it carries the way there.
          */}
        {cloudflare?.problem === 'r2_not_enabled' ? <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{t('console.cfR2NotEnabledTitle')}</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>{t('console.cfR2NotEnabledBody')}</span>
            <a className="font-medium underline underline-offset-4" href={CLOUDFLARE_R2_URL} target="_blank" rel="noopener noreferrer">{t('console.cfR2NotEnabledAction')}</a>
          </AlertDescription>
        </Alert> : null}
        {/*
          * The manager put this machine's data back by itself, before anybody
          * opened the console. Said here because it is otherwise
          * indistinguishable from a machine that happened to still have it.
          */}
        {r2Config?.lastRecovery ? <Alert>
          <History />
          <AlertTitle>{t('console.r2RecoveredTitle')}</AlertTitle>
          {/* How much came back, not how many files: a size is something the
              reader can weigh against what they remember having. A recovery
              recorded before the size was kept says the rest without it,
              rather than claiming 0 B came back. */}
          <AlertDescription>{r2Config.lastRecovery.sizeBytes === undefined
            ? t('console.r2RecoveredBodyNoSize', { when: new Date(r2Config.lastRecovery.createdAt).toLocaleString() })
            : t('console.r2RecoveredBody', { when: new Date(r2Config.lastRecovery.createdAt).toLocaleString(), size: formatBytes(r2Config.lastRecovery.sizeBytes) })}</AlertDescription>
        </Alert> : null}
        <div>
          {/* Whether anything leaves this machine at all, first: it is the
              question everything else on the card only answers the details of.
              How often rides in the same row, as its hint, because the interval
              is only a question while the answer to this one is yes. */}
          <DetailRow
            label={t('console.r2Enabled')}
            hint={!r2Config?.configured ? t('console.r2NeedsSetup') : r2Config.enabled ? r2ScheduleSummary(t, r2Config) : t('console.r2EnabledOffHint')}
          >
            {r2Config?.configured && r2Config.enabled
              ? <Button variant="outline" size="sm" onClick={() => setR2ScheduleOpen(true)}>{t('console.r2Change')}</Button>
              : null}
            {/* Pressable with nothing set up, because pressing it is how somebody
                says they want this on - and the form that makes it possible is
                what that press should open. A switch that is simply dead, with a
                sentence underneath naming a prerequisite, leaves the reader to
                find the prerequisite themselves. Closed without finishing, the
                switch goes back to off: nothing was turned on. */}
            <Switch
              aria-label={t('console.r2Enabled')}
              checked={(r2Config?.enabled ?? false) && (r2Config?.configured ?? false)}
              disabled={r2Toggling}
              onCheckedChange={(checked) => { if (checked && !r2Config?.configured) setDestinationOpen(true); else void setR2Enabled(checked); }}
            />
          </DetailRow>
          {/* Then where it goes. One row whichever way the bucket is reached,
              because it is one question; the two ways of answering it are both
              inside the one form behind this button. */}
          <DetailRow label={t('console.r2Destination')} hint={destination}>
            <Button variant="outline" size="sm" onClick={() => setDestinationOpen(true)}>{r2Config?.configured ? t('console.r2Change') : t('console.r2DestinationSet')}</Button>
          </DetailRow>
          {/* Then the two things there are to do with a bucket: send to it now,
              and look at it. Everything else that used to be a button here
              answered some part of "look at it" and is folded into Check. */}
          {r2Config?.configured ? <DetailRow label={t('console.r2LastUpload')} hint={r2Config.lastUploadAt ? new Date(r2Config.lastUploadAt).toLocaleString() : '—'}>
            {/* One under the other, not side by side. Two buttons in a row
                needed more width than the card has on a phone, and what gave
                way was the label beside them. Stacked, each keeps its own
                width and the name of the row stays on one line. */}
            <div className="grid gap-2">
              <Button size="sm" onClick={() => void uploadR2()} disabled={r2Busy !== null || !r2Config.enabled}><Upload />{t('console.r2UploadLatest')}</Button>
              <Tooltip><TooltipTrigger asChild><span className="inline-flex">
                <Button variant="outline" size="sm" className="w-full" onClick={() => void checkR2()} disabled={r2Busy !== null}><ShieldCheck />{t('console.r2CheckNow')}</Button>
              </span></TooltipTrigger><TooltipContent>{t('console.r2CheckHint')}</TooltipContent></Tooltip>
            </div>
            {/* Backups taken under the old whole-file scheme. Nothing reads them
                any more, but they are the operator's, so removing them is asked
                for rather than assumed - and this menu exists only when there
                is something in it. */}
            {r2Config.usage.legacyObjectCount > 0 ? <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t('console.r2More')} disabled={r2Busy !== null}><Ellipsis /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => void removeLegacy()}><Trash2 />{t('console.r2LegacyRemove')} ({formatBytes(r2Config.usage.legacyBytes)})</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu> : null}
          </DetailRow> : null}
        </div>
        {/* What the last look at the bucket found, kept where the reader was
            looking when they asked for it. */}
        {r2Check ? <R2CheckLine t={t} check={r2Check} /> : null}
        {r2Busy ? <OperationProgress t={t} label={r2Busy} progress={operationProgress} canStop={runningJobId !== null} stopping={stopping} onStop={() => void stopOperation()} warning={null} /> : null}
        {signedIn && cloudflare?.restReason ? <Alert><TriangleAlert /><AlertDescription>{t(cloudflare.restReason === 'workers_not_granted' ? 'console.cfSlowNotGranted' : 'console.cfSlowUnavailable')}</AlertDescription></Alert> : null}
        {r2Config?.configured && activeProfile === null && r2Snapshots.length > 0
          ? <Alert><Cloud /><AlertDescription>{t('console.r2AwaitingInstall', { count: r2Snapshots.length })}</AlertDescription></Alert>
          : r2Config?.configured && r2Config.lastUploadAt === null && r2Snapshots.length > 0
            ? <Alert><Cloud /><AlertDescription>{t('console.cfNewMachine', { count: r2Snapshots.length })}</AlertDescription></Alert>
            : null}
        {r2Config?.configured ? <>
          {/* One set of figures, not two: Cloudflare's own when it can be asked,
              because it sees every machine on the bucket, and the manager's
              count when it cannot. */}
          {signedIn
            ? <CloudflareUsagePanel t={t} lastUploadAt={r2Config.lastUploadAt} fallback={<R2Usage t={t} config={r2Config} />} onRegisterRefresh={(fn) => { usageRefresh.current = fn; }} />
            : <R2Usage t={t} config={r2Config} />}
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">{t('console.r2Snapshots')}</h3>
            <DataTable
              rows={r2Snapshots}
              columns={snapshotColumns}
              rowKey={(snapshot) => `${snapshot.profileId}/${snapshot.id}`}
              query={snapshotQuery}
              onQueryChange={setSnapshotQuery}
              labels={labels}
              sortValue={snapshotSortValue}
              pageSizes={[5, 10, 25]}
              empty={<EmptyState icon={<Cloud />} title={t('console.r2NoSnapshots')} description={t('console.r2NoSnapshotsBody')} />}
            />
            <p className="text-xs text-muted-foreground">{t('console.r2FetchNote')}</p>
          </div>
        </> : null}
      </CardContent>
    </Card>

    <NameDialog
      t={t}
      open={profileOpen}
      onOpenChange={setProfileOpen}
      title={t('console.newProfile')}
      label={t('console.profileName')}
      hint={t('console.profileNameHint')}
      submitLabel={t('common.create')}
      onSubmit={createProfile}
    />
    <NameDialog
      t={t}
      open={backupOpen}
      onOpenChange={setBackupOpen}
      title={t('console.manualBackup')}
      label={t('common.name')}
      hint={t('console.backupNameHint')}
      submitLabel={t('console.manualBackup')}
      optional
      onSubmit={(name) => startBackup('manual', name)}
    />
    <NameDialog
      t={t}
      open={renameTarget !== null}
      onOpenChange={(next) => { if (!next) setRenameTarget(null); }}
      title={t('console.renameBackupTitle')}
      label={t('common.name')}
      initial={renameTarget ? displayName(renameTarget).replace(/\.zip$/u, '') : ''}
      submitLabel={t('common.rename')}
      onSubmit={renameBackup}
    />
    <ConfirmDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      title={t('console.deleteBackupTitle', { name: deleteTarget ? displayName(deleteTarget) : '' })}
      description={t('console.deleteBackupBody')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={deleteBackup}
    />
    <RestoreDialog t={t} catalog={catalog} displayName={displayName} backup={selectedBackup} preview={selectedPreview} mode={restoreMode} onModeChange={setRestoreMode} onClose={closeRestore} onRestore={restoreSelected} />
    <R2DestinationDialog
      t={t}
      open={destinationOpen}
      onOpenChange={setDestinationOpen}
      startEnabled={!r2Config?.enabled}
      config={r2Config}
      busy={cloudflareBusy}
      signInUrl={cloudflareSignInUrl}
      onDismissSignIn={() => setCloudflareSignInUrl(null)}
      onConnect={() => void connectCloudflare()}
      onChooseAccount={chooseCloudflareAccount}
      onChooseBucket={chooseCloudflareBucket}
      onDisconnect={() => setDisconnectOpen(true)}
      onUseCloudflare={backUpToCloudflare}
      onSaveKeys={saveR2Keys}
    />
    <R2ScheduleDialog t={t} open={r2ScheduleOpen} onOpenChange={setR2ScheduleOpen} config={r2Config} onSave={saveR2Schedule} />
    <ConfirmDialog
      open={disconnectOpen}
      onOpenChange={setDisconnectOpen}
      title={t('console.cfDisconnectTitle')}
      description={t('console.cfDisconnectBody')}
      confirmLabel={t('console.cfDisconnect')}
      cancelLabel={t('common.cancel')}
      onConfirm={disconnectCloudflare}
    />
  </div>;
}

/** Where backups go, in the reader's words, whichever way the bucket is reached. */
function destinationText(t: Translate, config: R2Config | null): string {
  if (!config?.configured) return t('console.r2DestinationNone');
  const bucket = (config.mode === 'cloudflare' ? config.cloudflare?.bucket : config.bucket) || t('console.r2DestinationUnnamed');
  return config.mode === 'cloudflare'
    ? t('console.r2DestinationCloudflare', { bucket, account: config.cloudflare?.account?.name ?? '' })
    : t('console.r2DestinationKeys', { bucket });
}

/** Cloudflare's own R2 page, where an account that has not enabled R2 enables it. */
const CLOUDFLARE_R2_URL = 'https://dash.cloudflare.com/?to=/:account/r2/overview';

/**
 * What the last look at the bucket found.
 *
 * One line, in the place the button that asked for it is, and it stays until
 * something replaces it. The three buttons this replaced each answered in a
 * notification that was gone in a few seconds, which meant the reader could
 * press a button, look away, and be left exactly as uncertain as before.
 */
function R2CheckLine({ t, check }: { t: Translate; check: R2CheckResult }) {
  const when = new Date(check.checkedAt);
  const fresh = Date.now() - when.getTime() < 60_000;
  if (!check.failure) {
    return <p className="text-xs text-muted-foreground">
      <span className="font-medium text-(--success)">{fresh ? t('console.r2CheckedJustNow') : t('console.r2CheckedAt', { time: when.toLocaleTimeString() })}</span>
      {' \u00b7 '}
      {t('console.r2CheckOk', { size: formatBytes(check.totalBytes), points: check.snapshotCount.toLocaleString() })}
    </p>;
  }
  return <Alert variant="destructive"><TriangleAlert /><AlertDescription>{t('console.r2CheckFailed', { error: check.failure.message })}</AlertDescription></Alert>;
}

/**
 * What is happening now, and the way to stop it.
 *
 * A backup, a restore, an import and a send to R2 all report the same way, so
 * one block says it rather than each card writing out its own bar, its own
 * percentage and its own Stop button in its own place.
 */
function OperationProgress({ t, label, progress, canStop, stopping, onStop, warning }: { t: Translate; label: string; progress: { percent: number; step: string } | null; canStop: boolean; stopping: boolean; onStop: () => void; warning: string | null }) {
  return <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" role="status">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <TaskLine task={label} step={progress?.step ?? t('console.taskPreparing')} {...(progress ? { percent: progress.percent } : {})} />
      {canStop ? <Button variant="destructive" size="sm" onClick={onStop} disabled={stopping} aria-busy={stopping}>{stopping ? <LoaderCircle className="animate-spin" /> : <CircleStop />}{stopping ? t('console.stopping') : t('common.stop')}</Button> : null}
    </div>
    <TaskBar {...(progress ? { percent: Math.max(2, progress.percent) } : {})} />
    {warning ? <span className="text-xs text-destructive">{warning}</span> : null}
  </div>;
}

/**
 * What kind of work this is, what it is doing, and how far it has got.
 *
 * The kind is a small label of its own - Install, Start, Backup, Restore - so
 * a glance says which of the manager's few jobs is running before the sentence
 * says which part of it. The sentence carries the sweep, the way a reply being
 * written does, because a sentence that is visibly still being worked on is
 * easier to wait on than a bar alone.
 */
function TaskLine({ task, step, percent }: { task: string; step: string; percent?: number }) {
  return <span className="task-line">
    <span className="task-kind">{task}</span>
    <span className="thinking task-step">{step}</span>
    {percent === undefined ? null : <span className="task-percent">{Math.round(percent)}%</span>}
  </span>;
}

/**
 * A bar for work in progress: striped and moving, filled to the share done
 * when that is known and all the way when it is not. The meters that are
 * readings rather than work - CPU, memory, storage, the R2 allowance - keep
 * their plain bars.
 */
function TaskBar({ percent }: { percent?: number }) {
  return <span className="progress-track task-track">
    <span className="task-stripes" data-indeterminate={percent === undefined || undefined} style={percent === undefined ? undefined : { width: `${Math.max(0, Math.min(100, percent))}%` }} />
  </span>;
}

/**
 * One field, and the button that uses it.
 *
 * Naming a new profile, naming a backup and renaming one are the same question
 * asked three times. None of them is `window.prompt` any more, which could not
 * be translated, could not be styled, and asked in the browser's voice rather
 * than this program's.
 */
function NameDialog({ t, open, onOpenChange, title, label, hint, initial = '', submitLabel, optional = false, onSubmit }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; title: string; label: string; hint?: string; initial?: string; submitLabel: string; optional?: boolean; onSubmit: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted, so what was typed last time is cleared on the way
  // in rather than on the way out: a rename has to open on the name of the row
  // that was actually pressed.
  useEffect(() => { if (open) { setName(initial); setError(null); } }, [open, initial]);
  const ready = optional || name.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      const failure = await onSubmit(name.trim());
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <DialogBody className="grid gap-4">
        <Field label={label} hint={hint}>
          <Input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} autoComplete="off" />
        </Field>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => void submit()} disabled={busy || !ready}>{submitLabel}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * The one question a restore has to answer before it runs.
 *
 * What happens to the data already in the profile used to be a dropdown
 * labelled "Restore mode" holding the words "Replace" and "Merge", sitting on
 * the page beside a button that did it. The two outcomes are written out now
 * where the choice is made, and the choice is made in a dialog, because one of
 * them deletes everything that is there.
 */
function RestoreDialog({ t, catalog, displayName, backup, preview, mode, onModeChange, onClose, onRestore }: { t: Translate; catalog: Record<string, unknown>; displayName: (backup: BackupManifest) => string; backup: BackupManifest | null; preview: RestorePreview | null; mode: RestoreMode; onModeChange: (mode: RestoreMode) => void; onClose: () => void; onRestore: () => Promise<void> }) {
  const group = useId();
  if (!backup || !preview) return null;
  /*
   * Replace is the one to reach for, and says so.
   *
   * It leaves the profile exactly as the backup was. Merge keeps whatever the
   * backup does not mention, so the result is a mixture nobody took a backup
   * of - occasionally what is wanted, usually not.
   */
  const options: Array<{ value: RestoreMode; label: string; body: string; recommended: boolean }> = [
    { value: 'replace', label: t('console.replaceRestore'), body: t('console.restoreReplaceBody'), recommended: true },
    { value: 'merge', label: t('console.mergeRestore'), body: t('console.restoreMergeBody'), recommended: false },
  ];
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.restoreTitle', { name: displayName(backup) })}</DialogTitle>
        <DialogDescription>{t('console.restoreCounts', { files: preview.fileCount, size: formatBytes(preview.totalBytes) })}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as RestoreMode)} aria-label={t('console.restoreChoose')}>
          {options.map((option) => <div key={option.value} className="flex items-start gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <RadioGroupItem id={`${group}-${option.value}`} value={option.value} className="mt-0.5" />
            <div className="grid gap-1">
              <Label htmlFor={`${group}-${option.value}`} className="flex flex-wrap items-center gap-2 font-medium">{option.label}{option.recommended ? <Badge variant="secondary" className="bg-(--success-background) text-(--success)">{t('console.restoreRecommended')}</Badge> : null}</Label>
              <p className="text-xs text-muted-foreground">{option.body}</p>
            </div>
          </div>)}
        </RadioGroup>
        {preview.warnings.length > 0 ? <Alert><AlertDescription>{preview.warnings.map((warning) => translateStep(warning.message, catalog, warning.code, warning.params)).join(' ')}</AlertDescription></Alert> : null}
        <p className="text-xs text-muted-foreground">{t('console.restoreSafety')}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant={mode === 'replace' ? 'destructive' : 'default'} onClick={() => void onRestore()}>{t('console.restoreStart')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * The Cloudflare sign-in address, for a page that cannot open it itself.
 *
 * Cloudflare's sign-in refuses to load in a frame, so a console shown inside
 * another page has to hand the address over instead of following it. That used
 * to be a notification, which is the wrong shape for it twice over: it goes
 * away while the reader is still looking at it, and it left them nothing to
 * press but Copy - so the one path out of a framed console was copy the link,
 * find the address bar, paste. A banner stays, and carries both: open it here,
 * or take the address somewhere else.
 */
function CloudflareSignInBanner({ t, url, onDismiss }: { t: Translate; url: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // The address is on screen and can be selected, so a clipboard the
      // browser will not hand over is worth saying and nothing more.
      toast({ title: t('console.copyFailed'), tone: 'destructive' });
    }
  };
  return <Alert>
    <CloudflareMark />
    <AlertTitle>{t('console.cfConnectOpenHere')}</AlertTitle>
    <AlertDescription className="grid gap-2">
      <span>{t('console.cfConnectPopupBlocked')}</span>
      <a className="break-all font-mono text-xs underline underline-offset-4" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ArrowUpRight />{t('console.openInTab')}</a></Button>
        <Button variant="outline" size="sm" onClick={() => void copy()}><Copy />{copied ? t('console.linkCopied') : t('dashboard.copyLink')}</Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>{t('common.close')}</Button>
      </div>
    </AlertDescription>
  </Alert>;
}

/**
 * Where backups go, asked once, with both ways of answering it in view.
 *
 * There is one question here - which bucket, reached how - and the card used to
 * ask it as two rows that each had a state, a hint and a button of their own:
 * a Cloudflare row with five shapes and a keys row with three, plus two
 * confirmations for moving between them and a third dialog for the bucket. A
 * reader who had signed in was still being shown a row inviting them to go and
 * copy keys, and a reader who had entered keys was shown the other. Neither row
 * said which one the backups were actually going through without being read
 * carefully.
 *
 * It is one form now. Two answers side by side, the one in force marked as
 * such, and everything each answer needs - signing in, picking an account,
 * picking a bucket, signing out, the four fields - inside the answer it belongs
 * to. Saving means "use this one", which is the choice that used to need a
 * confirmation dialog of its own, asked here where it is being made.
 */
function R2DestinationDialog({ t, open, onOpenChange, config, busy, startEnabled, signInUrl, onDismissSignIn, onConnect, onChooseAccount, onChooseBucket, onDisconnect, onUseCloudflare, onSaveKeys }: {
  t: Translate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: R2Config | null;
  busy: boolean;
  /** Opened by a switch somebody just turned on, so finishing here turns it on. */
  startEnabled: boolean;
  /** Set when this page could not open Cloudflare's sign-in and handed it over instead. */
  signInUrl: string | null;
  onDismissSignIn: () => void;
  onConnect: () => void;
  onChooseAccount: (accountId: string) => Promise<string | null>;
  onChooseBucket: (name: string) => Promise<string | null>;
  onDisconnect: () => void;
  onUseCloudflare: () => Promise<void>;
  onSaveKeys: (form: R2KeysForm & { readonly enabled?: boolean }) => Promise<string | null>;
}) {
  const group = useId();
  const cloudflare = config?.cloudflare ?? null;
  const mode = config?.mode ?? 'keys';
  /*
   * Which answer the form opens on.
   *
   * Whatever is already carrying the backups, and the sign-in when nothing is.
   * It used to open on the keys - the stored default before anything had been
   * chosen - which put four empty fields in front of somebody on a form whose
   * recommended answer, one line above, was greyed out until they had already
   * done the thing the form was for.
   */
  const [choice, setChoice] = useState<R2ConnectionMode>(mode);
  const [keys, setKeys] = useState<R2KeysForm>(() => r2KeysFrom(config));
  const [account, setAccount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog stays mounted, so what was typed last time is cleared on the way
  // in. Opening it after a sign-in that is waiting on a choice of account opens
  // it on the Cloudflare side, which is the side that is waiting.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setKeys(r2KeysFrom(config));
    setAccount(cloudflare?.accounts[0]?.id ?? '');
    setChoice(!cloudflare ? 'keys' : config?.configured ? mode : 'cloudflare');
  }, [open]);

  // Set in `.env`: shown so the reader knows where the value comes from, and
  // not editable, because the server reads `.env` on every start and would
  // ignore the edit.
  const fromEnvironment = new Set<string>(config?.environmentFields ?? []);
  const keysReady = Boolean(keys.endpoint.trim() && keys.bucket.trim() && keys.accessKeyId.trim() && (keys.secretAccessKey.trim() || config?.secretAccessKeyConfigured));
  const connected = cloudflare?.state === 'connected';
  // Choosing the sign-in is allowed before signing in - that is how somebody
  // says which way they want to go. What waits for it is Save, because there is
  // no bucket to save yet, and the row below says so rather than leaving a dead
  // button to be puzzled over.
  const canSave = choice === 'keys' ? keysReady : connected;
  const cloudflarePending = choice === 'cloudflare' && Boolean(cloudflare) && !connected;

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true); setError(null);
    try {
      // Saving is choosing. Keys are sent with the mode that uses them; the
      // sign-in has nothing to send but the choice itself.
      if (choice === 'keys') {
        const failure = await onSaveKeys({ ...keys, ...(startEnabled ? { enabled: true } : {}) });
        setError(failure);
        if (failure) return;
      } else if (mode !== 'cloudflare' || startEnabled) {
        await onUseCloudflare();
      }
      onOpenChange(false);
    } finally { setSaving(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{t('console.r2DestinationTitle')}</DialogTitle>
        <DialogDescription>{t('console.r2DestinationBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        {fromEnvironment.size > 0 ? <Alert><AlertDescription>{t('console.r2FromEnv')}</AlertDescription></Alert> : null}
        {signInUrl ? <CloudflareSignInBanner t={t} url={signInUrl} onDismiss={onDismissSignIn} /> : null}
        <RadioGroup value={choice} onValueChange={(value) => setChoice(value as R2ConnectionMode)} aria-label={t('console.r2DestinationTitle')}>
          {/* Signing in first, and marked as the one to reach for: it makes the
              bucket, keeps its own keys and is the only one that can show what
              Cloudflare says the account has used. */}
          {cloudflare ? <div className="grid gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <div className="flex items-start gap-3">
              <RadioGroupItem id={`${group}-cloudflare`} value="cloudflare" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor={`${group}-cloudflare`} className="flex flex-wrap items-center gap-2 font-medium">
                  <CloudflareMark />{t('console.r2MethodCloudflare')}
                  <Badge variant="secondary" className="bg-(--success-background) text-(--success)">{t('console.r2Recommended')}</Badge>
                  {mode === 'cloudflare' && connected ? <Badge variant="outline">{t('console.r2MethodInUse')}</Badge> : null}
                </Label>
                <p className="text-xs text-muted-foreground">{t('console.r2MethodCloudflareBody')}</p>
              </div>
            </div>
            <CloudflareMethod
              t={t}
              status={cloudflare}
              busy={busy || saving}
              account={account}
              onAccountChange={setAccount}
              onConnect={onConnect}
              onChooseAccount={async () => { setError(await onChooseAccount(account)); }}
              onChooseBucket={async (name) => { setError(await onChooseBucket(name)); }}
              onDisconnect={onDisconnect}
            />
          </div> : null}
          <div className="grid gap-3 rounded-lg border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
            <div className="flex items-start gap-3">
              <RadioGroupItem id={`${group}-keys`} value="keys" className="mt-0.5" />
              <div className="grid gap-1">
                <Label htmlFor={`${group}-keys`} className="flex flex-wrap items-center gap-2 font-medium">
                  {t('console.r2MethodKeys')}
                  {mode === 'keys' && config?.configured ? <Badge variant="outline">{t('console.r2MethodInUse')}</Badge> : null}
                </Label>
                <p className="text-xs text-muted-foreground">{t('console.r2MethodKeysBody')}</p>
              </div>
            </div>
            {/* The fields are here rather than behind a further button: this is
                already the form for answering the question, and a form that
                opens a second form to be filled in is one step too many. */}
            {choice === 'keys' ? <div className="grid gap-3">
              <Field label={t('console.r2Endpoint')}><Input value={keys.endpoint} onChange={(event) => setKeys({ ...keys, endpoint: event.target.value })} placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com" autoComplete="off" disabled={fromEnvironment.has('endpoint')} /></Field>
              <Field label={t('console.r2Bucket')}><Input value={keys.bucket} onChange={(event) => setKeys({ ...keys, bucket: event.target.value })} autoComplete="off" disabled={fromEnvironment.has('bucket')} /></Field>
              <Field label={t('console.r2AccessKey')}><Input value={keys.accessKeyId} onChange={(event) => setKeys({ ...keys, accessKeyId: event.target.value })} autoComplete="off" disabled={fromEnvironment.has('accessKeyId')} /></Field>
              <Field label={t('console.r2SecretKey')}><PasswordInput revealLabel={t('setup.reveal')} hideLabel={t('setup.hide')} value={keys.secretAccessKey} onChange={(event) => setKeys({ ...keys, secretAccessKey: event.target.value })} autoComplete="new-password" disabled={fromEnvironment.has('secretAccessKey')} /></Field>
              <p className="text-xs text-muted-foreground">{t('console.r2SetupBody')}</p>
            </div> : null}
          </div>
        </RadioGroup>
        {/* An account that has not enabled R2 already says so, in the row where
            it was chosen and with the way to fix it attached. Saying it again
            down here in the general failure slot is the same sentence twice. */}
        {error && !(choice === 'cloudflare' && cloudflare?.problem === 'r2_not_enabled') ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        {cloudflarePending ? <span className="mr-auto text-xs text-muted-foreground">{t('console.r2SaveNeedsCloudflare')}</span> : null}
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{t('common.cancel')}</Button>
        <Button onClick={() => void save()} disabled={saving || !canSave}>{t('common.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * The Cloudflare half of that question, in whatever state the sign-in is in.
 *
 * Four states and one of them - connected - carries the bucket picker, because
 * which bucket of the account is part of the same answer and not worth a
 * dialog of its own on top of this one. The buckets are asked for when this
 * first shows connected, which is the only moment the list is wanted.
 */
function CloudflareMethod({ t, status, busy, account, onAccountChange, onConnect, onChooseAccount, onChooseBucket, onDisconnect }: {
  t: Translate;
  status: NonNullable<R2Config['cloudflare']>;
  busy: boolean;
  account: string;
  onAccountChange: (id: string) => void;
  onConnect: () => void;
  onChooseAccount: () => Promise<void>;
  onChooseBucket: (name: string) => Promise<void>;
  onDisconnect: () => void;
}) {
  // Cloudflare's own colour, because this button hands the reader over to
  // Cloudflare and they decide whether to trust it by recognising it.
  const brand = { backgroundColor: CLOUDFLARE_ORANGE, color: '#fff' };
  const [buckets, setBuckets] = useState<CloudflareBucketOption[] | null>(null);
  const [bucketError, setBucketError] = useState<string | null>(null);
  const connected = status.state === 'connected';
  useEffect(() => {
    if (!connected) { setBuckets(null); return undefined; }
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch('/api/v1/r2/cloudflare/buckets', { credentials: 'same-origin' });
        const payload = await response.json() as { buckets?: CloudflareBucketOption[]; error?: { message?: string } };
        if (cancelled) return;
        if (!response.ok || !payload.buckets) { setBucketError(payload.error?.message ?? t('console.cfBucketsFailed')); return; }
        setBuckets(payload.buckets);
      } catch { if (!cancelled) setBucketError(t('console.cfBucketsFailed')); }
    })();
    return () => { cancelled = true; };
  }, [connected, status.bucket]);

  if (status.state === 'disconnected') {
    return <Button size="sm" style={brand} className="w-fit hover:opacity-90" onClick={onConnect} disabled={busy}><CloudflareMark />{t('console.cfConnect')}</Button>;
  }
  if (status.state === 'reconnect_required') {
    return <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t('console.cfReconnectHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" style={brand} className="hover:opacity-90" onClick={onConnect} disabled={busy}><RefreshCw />{t('console.cfReconnect')}</Button>
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
      </div>
    </div>;
  }
  if (status.state === 'choose_account') {
    return <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t('console.cfChooseAccount')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={account} onValueChange={onAccountChange}>
          <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>
            {status.accounts.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => void onChooseAccount()} disabled={busy || !account}>{t('console.cfUseAccount')}</Button>
        {/* Signed in, with the account still to pick - and no way back out. The
            grant exists from this point on, so the way to give it back has to
            exist from this point on too, and this is where somebody who has
            just seen that the account cannot be used needs it. Outlined, not
            ghosted: it ends a connection, and it has to read as something that
            can be pressed. */}
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
      </div>
      {/* An account that has not turned R2 on fails the moment it is chosen,
          with the sign-in itself in perfect order. The way out is on Cloudflare. */}
      {status.problem === 'r2_not_enabled' ? <Alert variant="destructive"><TriangleAlert /><AlertDescription className="grid gap-2">
        <span>{t('console.cfR2NotEnabledBody')}</span>
        <a className="font-medium underline underline-offset-4" href={CLOUDFLARE_R2_URL} target="_blank" rel="noopener noreferrer">{t('console.cfR2NotEnabledAction')}</a>
      </AlertDescription></Alert> : null}
    </div>;
  }
  return <div className="grid gap-2">
    <p className="text-xs text-muted-foreground">{t('console.cfConnectedAs', { account: status.account?.name ?? '', bucket: status.bucket ?? '' })}</p>
    <div className="flex flex-wrap items-center gap-2">
      {buckets === null && !bucketError
        ? <Skeleton className="h-9 w-56" />
        : buckets?.length === 0
        ? <p className="text-xs text-muted-foreground">{t('console.cfBucketsEmpty')}</p>
        : <Select value={status.bucket ?? ''} onValueChange={(name) => { if (name !== status.bucket) void onChooseBucket(name); }} disabled={busy || buckets === null}>
          <SelectTrigger className="w-56" aria-label={t('console.cfBucketLabel')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {(buckets ?? []).map((bucket) => <SelectItem key={`${bucket.jurisdiction}/${bucket.name}`} value={bucket.name}>{bucket.name}</SelectItem>)}
          </SelectContent>
        </Select>}
      <Button variant="outline" size="sm" onClick={onDisconnect} disabled={busy}>{t('console.cfDisconnect')}</Button>
    </div>
    <p className="text-xs text-muted-foreground">{t('console.cfBucketBody')}</p>
    {bucketError ? <p className="text-xs text-destructive">{bucketError}</p> : null}
  </div>;
}

/**
 * How often changes go up, and how far back they can be brought back.
 *
 * The dialog used to ask for six numbers, three of them retention: "keep
 * recovery points", "then keep one a day", "then keep one a week". Each was
 * accurate and together they were a puzzle - nobody could say how far back
 * 48, 14 and 8 let them go without working it out. The question people have
 * is how far back, so that is what is asked, and each answer is a set of the
 * same numbers the server has always taken. The numbers are still there, under
 * "Exact numbers", and a combination that matches no answer reads as Custom.
 */
function R2ScheduleDialog({ t, open, onOpenChange, config, onSave }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; config: R2Config | null; onSave: (form: R2ScheduleForm) => Promise<string | null> }) {
  const [form, setForm] = useState<R2ScheduleForm>(() => r2ScheduleFrom(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setForm(r2ScheduleFrom(config)); setError(null); } }, [open, config]);
  const set = (patch: Partial<R2ScheduleForm>) => setForm((current) => ({ ...current, ...patch }));
  const number = (value: string, fallback: number) => { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) ? parsed : fallback; };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onSave(form);
      setError(failure);
      if (!failure) onOpenChange(false);
    } finally { setBusy(false); }
  };

  const upload = uploadChoice(form.hotIntervalMinutes, form.coldIntervalHours);
  const history = historyChoice(form.keepRecent, form.keepDaily, form.keepWeekly);
  const exact: Array<{ label: string; value: number; apply: (value: number) => Partial<R2ScheduleForm>; min: number }> = [
    { label: t('console.r2HotEvery'), value: form.hotIntervalMinutes, apply: (value) => ({ hotIntervalMinutes: value }), min: 1 },
    { label: t('console.r2ColdEvery'), value: form.coldIntervalHours, apply: (value) => ({ coldIntervalHours: value }), min: 1 },
    { label: t('console.r2KeepRecent'), value: form.keepRecent, apply: (value) => ({ keepRecent: value }), min: 1 },
    { label: t('console.r2KeepDaily'), value: form.keepDaily, apply: (value) => ({ keepDaily: value }), min: 0 },
    { label: t('console.r2KeepWeekly'), value: form.keepWeekly, apply: (value) => ({ keepWeekly: value }), min: 0 },
  ];

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('console.r2ScheduleTitle')}</DialogTitle>
        <DialogDescription>{t('console.r2ScheduleBody')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <ChoiceSelect
          label={t('console.r2UploadEvery')}
          hint={t('console.r2UploadEveryHint')}
          value={upload?.id ?? CUSTOM_CHOICE}
          choices={R2_UPLOAD_CHOICES.map((choice) => ({ id: choice.id, text: t(choice.label) }))}
          customLabel={t('console.r2Custom')}
          onChange={(id) => { const choice = R2_UPLOAD_CHOICES.find((item) => item.id === id); if (choice) set({ hotIntervalMinutes: choice.hotIntervalMinutes, coldIntervalHours: choice.coldIntervalHours }); }}
        />
        <div className="grid gap-1.5">
          <ChoiceSelect
            label={t('console.r2History')}
            hint={t('console.r2HistoryHint')}
            value={history?.id ?? CUSTOM_CHOICE}
            choices={R2_HISTORY_CHOICES.map((choice) => ({ id: choice.id, text: t(choice.label) }))}
            customLabel={t('console.r2Custom')}
            onChange={(id) => { const choice = R2_HISTORY_CHOICES.find((item) => item.id === id); if (choice) set({ keepRecent: choice.keepRecent, keepDaily: choice.keepDaily, keepWeekly: choice.keepWeekly }); }}
          />
          {/* The choice above says "3 months" - this says what that means in
              the same numbers the server stores, so "Custom" reads as a
              specific set of numbers rather than an unexplained label. */}
          <p className="text-xs text-muted-foreground">{t('console.r2HistoryExplain', { recent: String(form.keepRecent), daily: String(form.keepDaily), weekly: String(form.keepWeekly) })}</p>
          {!history ? <p className="text-xs text-muted-foreground">{t('console.r2CustomHint')}</p> : null}
        </div>
        <details className="r2-advanced" open={!upload || !history}>
          <summary>{t('console.r2Advanced')}</summary>
          <div className="grid gap-4 pt-3 sm:grid-cols-2">
            {exact.map((row) => <Field key={row.label} label={row.label}>
              <Input type="number" min={row.min} value={row.value} onChange={(event) => set(row.apply(number(event.target.value, row.value)))} />
            </Field>)}
          </div>
        </details>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => void save()} disabled={busy}>{t('common.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** One bucket as the server lists them for the picker. */
interface CloudflareBucketOption {
  readonly name: string;
  readonly jurisdiction: string;
}

function cloudflareErrorText(t: Translate, code: string): string {
  if (code === 'login_required') return t('console.cfErrorLoginRequired');
  if (code === 'cloudflare_state_mismatch') return t('console.cfErrorStateMismatch');
  if (code === 'cloudflare_authorization_denied') return t('console.cfErrorDenied');
  if (code === 'cloudflare_not_available') return t('console.cfErrorUnavailable');
  if (code === 'cloudflare_r2_not_enabled') return t('console.cfErrorR2NotEnabled');
  return t('console.cfErrorGeneric', { code: code || 'unknown' });
}

/**
 * What Cloudflare itself says was used, beside the manager's own count.
 *
 * The manager's count only sees its own requests. Cloudflare sees the bucket
 * from every machine and the account as a whole, which is what the free tier is
 * measured against. It is asked for when the page opens, after each backup, and
 * on request; the server keeps it for fifteen minutes in between.
 */
function CloudflareUsagePanel({ t, lastUploadAt, fallback, onRegisterRefresh }: { t: Translate; lastUploadAt: string | null; fallback: ReactNode; onRegisterRefresh: (fn: () => void) => void }) {
  const [response, setResponse] = useState<R2UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (refresh: boolean) => {
    setLoading(true);
    try {
      const reply = await apiFetch(`/api/v1/r2/usage${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin' });
      if (reply.ok) setResponse(await reply.json() as R2UsageResponse);
    } catch {
      // Kept as it was; the overflow menu's refresh item tries again.
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(false); }, [lastUploadAt]);
  // The refresh action lives in the card's one overflow menu rather than a
  // second button next to this heading; this just hands that menu a way in.
  useEffect(() => { onRegisterRefresh(() => void load(true)); });

  // Until Cloudflare has answered - and if it cannot, because the permission
  // was not granted or the query failed - the manager's own count is shown
  // rather than nothing at all.
  if (!response) return <>{fallback}</>;
  if (response.unavailable === 'analytics_not_granted') return <div className="grid gap-3">{fallback}<p className="text-xs text-muted-foreground">{t('console.cfUsageNotGranted')}</p></div>;
  const usage = response.usage;
  if (!usage) return <div className="grid gap-3">{fallback}{response.error ? <p className="text-xs text-muted-foreground">{t('console.cfUsageFailed', { error: response.error })}</p> : null}</div>;

  const bars = cloudflareBars(t, usage);
  return <div className="grid gap-3">
    <div className="flex items-center gap-2">
      <h3 className="text-sm font-medium">{t('console.cfUsageTitle')}</h3>
      {loading ? <RefreshCw className="size-3 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
    </div>
    {usage.warnings.length > 0 ? <Alert variant="destructive"><TriangleAlert /><AlertDescription>
      {usage.warnings.map((warning) => <span className="block" key={`${warning.scope}-${warning.metric}`}>{warningText(t, warning)}</span>)}
    </AlertDescription></Alert> : null}
    {/* Whole-account figures only. The bucket's own month-to-date numbers
        used to repeat here too, but the account totals are what the free
        tier is measured against, and the bucket ones just doubled the page
        without answering a different question. */}
    <span className="text-xs font-medium">{t('console.cfUsageAccount')}</span>
    {bars.map((bar) => <div className="grid gap-1" key={bar.label}>
      <span className={cn('text-xs', bar.filled >= 0.8 ? 'text-destructive' : 'text-muted-foreground')}>{bar.label}: {bar.text}</span>
      <span className="progress-track"><span className="progress-value" style={{ width: `${Math.max(1, bar.filled * 100)}%` }} /></span>
    </div>)}
    {response.error ? <p className="text-xs text-muted-foreground">{t('console.cfUsageFailed', { error: response.error })}</p> : null}
  </div>;
}

function cloudflareBars(t: Translate, usage: R2CloudflareUsage): Array<{ label: string; text: string; filled: number }> {
  const storage = usage.account.storageBytes;
  return [
    {
      label: t('console.cfStorage'),
      text: storage === null ? t('console.cfNotReported') : t('console.cfOfFree', { used: formatBytes(storage), limit: formatBytes(usage.freeTier.storageBytes) }),
      filled: ratio(storage ?? 0, usage.freeTier.storageBytes),
    },
    { label: t('console.cfClassA'), text: t('console.cfOfFree', { used: usage.account.operations.classA.toLocaleString(), limit: usage.freeTier.classA.toLocaleString() }), filled: ratio(usage.account.operations.classA, usage.freeTier.classA) },
    { label: t('console.cfClassB'), text: t('console.cfOfFree', { used: usage.account.operations.classB.toLocaleString(), limit: usage.freeTier.classB.toLocaleString() }), filled: ratio(usage.account.operations.classB, usage.freeTier.classB) },
  ];
}

function warningText(t: Translate, warning: R2UsageWarning): string {
  const metric = t(warning.metric === 'storage' ? 'console.cfStorage' : warning.metric === 'classA' ? 'console.cfClassA' : 'console.cfClassB');
  const percent = `${Math.round((warning.used / warning.limit) * 100)}%`;
  return t(warning.scope === 'account' ? 'console.cfWarningAccount' : 'console.cfWarningBucket', { metric, percent });
}

/** One plain question with a few answers, and "Custom" only when none of them fits. */
function ChoiceSelect({ label, hint, value, choices, customLabel, onChange }: { label: string; hint: string; value: string; choices: ReadonlyArray<{ id: string; text: string }>; customLabel: string; onChange: (id: string) => void }) {
  return <Field label={label} hint={hint}>
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {choices.map((choice) => <SelectItem key={choice.id} value={choice.id}>{choice.text}</SelectItem>)}
        {value === CUSTOM_CHOICE ? <SelectItem value={CUSTOM_CHOICE} disabled>{customLabel}</SelectItem> : null}
      </SelectContent>
    </Select>
  </Field>;
}

/**
 * What the bucket is holding, against what it is allowed to hold.
 *
 * The point of the whole incremental design is that a free account stays free,
 * and the operator cannot check that from the number of files. Two bars say it
 * directly: how full the storage is, and how much of the month's charged writes
 * have gone. Both turn to the attention colour before they are reached, not
 * after - a backup that has already refused is too late to be a warning.
 */
function R2Usage({ t, config }: { t: Translate; config: R2Config }) {
  const bars: Array<{ label: string; text: string; filled: number }> = [
    { label: t('console.r2Estimate'), text: `${formatBytes(config.usage.storageBytes)} / ${formatBytes(config.limits.maxStorageBytes)}`, filled: ratio(config.usage.storageBytes, config.limits.maxStorageBytes) },
    { label: t('console.r2Writes'), text: `${config.usage.writeOperations.toLocaleString()} / ${config.limits.maxWriteOperations.toLocaleString()}`, filled: ratio(config.usage.writeOperations, config.limits.maxWriteOperations) },
    // Reads are what a restore costs. They are reported but never enforced:
    // refusing someone their data back to avoid a small bill is the wrong way
    // round.
    { label: t('console.r2Reads'), text: `${config.usage.readOperations.toLocaleString()} / ${config.limits.maxReadOperations.toLocaleString()}`, filled: ratio(config.usage.readOperations, config.limits.maxReadOperations) },
  ];
  return <div className="grid gap-3">
    {bars.map((bar) => <div className="grid gap-1" key={bar.label}>
      <span className={cn('text-xs', bar.filled >= 0.9 ? 'text-destructive' : 'text-muted-foreground')}>{bar.label}: {bar.text}</span>
      <span className="progress-track"><span className="progress-value" style={{ width: `${Math.max(1, bar.filled * 100)}%` }} /></span>
    </div>)}
    <p className="text-xs text-muted-foreground">{t('console.r2UsageNote')}</p>
  </div>;
}

function ratio(value: number, limit: number): number {
  return limit > 0 ? Math.max(0, Math.min(1, value / limit)) : 0;
}


function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * What this machine is doing, read once for everything that asks.
 *
 * The same snapshot answers three questions on the overview - how loaded the
 * machine is, how much room is left, and how large the data has grown - and
 * they are asked in three different cards. One poll serves all of them rather
 * than each card opening its own.
 */
function useSystemSnapshot(csrfToken: string): { snapshot: SystemSnapshot | null; remeasure: () => Promise<void> } {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const remeasure = async () => {
    try {
      const response = await apiFetch('/api/v1/system/measure', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': csrfToken } });
      if (response.ok) setSnapshot(await response.json() as SystemSnapshot);
    } catch {
      // The next poll reports the sizes whether or not this request landed.
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await apiFetch('/api/v1/system', { credentials: 'same-origin', signal: controller.signal });
        if (response.ok && !controller.signal.aborted) setSnapshot(await response.json() as SystemSnapshot);
      } catch {
        // A dropped reading is replaced by the next one.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  return { snapshot, remeasure };
}

/**
 * How hard this machine is working, and nothing about what is stored on it.
 *
 * The card used to end with two directory sizes - what the manager keeps and
 * what SillyTavern's data weighs - which put a number for the whole
 * installation directly above a number for one profile inside it, with no way
 * to tell that the second was part of the first. Both have moved to where the
 * thing they measure is managed; this card is now three live readings and a
 * core count nobody was acting on has gone with them.
 */
function SystemPanel({ t, snapshot }: { t: Translate; snapshot: SystemSnapshot | null }) {
  const rows: Array<{ key: string; label: string; value: string; ratio?: number }> = [];
  if (snapshot) {
    const { cpu, memory, storage } = snapshot;
    rows.push({
      key: 'cpu',
      label: t('system.cpu'),
      value: cpu.usagePercent === null ? '—' : `${cpu.usagePercent}%`,
      ...(cpu.usagePercent === null ? {} : { ratio: cpu.usagePercent / 100 }),
    });
    rows.push({
      key: 'memory',
      label: t('system.memory'),
      value: `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`,
      ratio: memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0,
    });
    if (storage.totalBytes !== null && storage.freeBytes !== null) {
      const used = storage.totalBytes - storage.freeBytes;
      rows.push({
        key: 'disk',
        label: t('system.disk'),
        value: `${formatBytes(storage.freeBytes)} ${t('system.free')} / ${formatBytes(storage.totalBytes)}`,
        ratio: storage.totalBytes > 0 ? used / storage.totalBytes : 0,
      });
    }
  }

  return <Card data-tour="system" className="overview-pair"><PanelHeading icon={<Cpu />}>{t('system.title')}</PanelHeading><CardContent className="flex-1">
    {snapshot ? <dl className="system-list">{rows.map((row) => <div key={row.key}>
      <dt>{row.label}</dt>
      <dd>
        <span>{row.value}</span>
        {row.ratio === undefined ? null : <span className="system-track"><span className="system-value" style={{ width: `${Math.round(Math.max(0, Math.min(1, row.ratio)) * 100)}%` }} /></span>}
      </dd>
    </div>)}</dl> : <dl className="system-list" aria-busy="true">{/* The shape the readings will take, rather than the word "Loading" in
        the middle of a card that is about to be full of numbers. */}
      {['cpu', 'memory', 'disk'].map((key) => <div key={key}>
        <dt><Skeleton className="h-3 w-20" /></dt>
        <dd><Skeleton className="h-4 w-36" /></dd>
      </div>)}
    </dl>}
  </CardContent></Card>;
}

/**
 * What the providers have been asked for.
 *
 * The page opened with four tiles written at three different sizes, one of
 * which hid six more numbers behind a disclosure triangle drawn as an
 * ellipsis, and ended with two lists that were not tables: a `role="table"`
 * div, a hand-drawn bar per row, and a hard cap at eight rows with no way to
 * reach the ninth. The tiles are one shape now, the detail is behind a named
 * button rather than a triangle, and the two lists are the same table as
 * everywhere else - so they can be searched, sorted and paged through.
 */
function MetricsPage({ t }: { t: Translate }) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [days, setDays] = useState(30);
  const [refresh, setRefresh] = useState(0);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [providerQuery, setProviderQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 10, sort: 'requests', direction: 'desc' }));
  const [modelQuery, setModelQuery] = useState<TableQuery>(() => initialQuery({ pageSize: 10, sort: 'requests', direction: 'desc' }));
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await apiFetch(`/api/v1/metrics?days=${days}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('metrics request failed');
        const payload = await response.json() as MetricsSnapshot;
        if (!cancelled) { setSnapshot(payload); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [days, refresh]);

  const labels = tableLabels(t);
  const columns: DataTableColumn<MetricsBucket>[] = [
    {
      id: 'key',
      header: t('common.name'),
      sortable: true,
      cell: (row) => <div className="grid min-w-0">
        <span className="truncate font-medium" title={row.key}>{row.key}</span>
        {row.completionSource ? <span className="truncate text-xs text-muted-foreground">{row.completionSource}</span> : null}
      </div>,
    },
    { id: 'requests', header: t('console.metricRequests'), sortable: true, align: 'end', cell: (row) => <span className="tabular-nums">{row.requests.toLocaleString()}</span> },
    { id: 'totalTokens', header: t('console.metricTokens'), sortable: true, align: 'end', showFrom: 'sm', cell: (row) => <span className="tabular-nums text-muted-foreground">{row.totalTokens.toLocaleString()}</span> },
    { id: 'averageLatencyMs', header: t('console.metricLatency'), sortable: true, align: 'end', showFrom: 'md', cell: (row) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{metricDuration(row.averageLatencyMs)}</span> },
  ];

  return <div className="grid min-w-0 gap-4">
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Tabs value={String(days)} onValueChange={(value) => { const next = Number(value); if (next !== days) { setSnapshot(null); setDays(next); } }}>
        <TabsList aria-label={t('console.metricsPeriod')}>
          {([7, 30, 90] as const).map((value) => <TabsTrigger key={value} value={String(value)}>{value} {t('console.metricsDays')}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <Button variant="ghost" size="icon-sm" aria-label={t('common.refresh')} onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button>
    </div>
    {!snapshot
      ? error
        ? <Card><CardContent className="px-0"><EmptyState icon={<BarChart3 />} title={t('console.metricsLoadFailed')} /></CardContent></Card>
        : <MetricsSkeleton />
      : <>
        {error ? <Alert variant="destructive"><AlertDescription>{t('console.metricsLoadFailed')}</AlertDescription></Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={<BarChart3 />} label={t('console.metricRequests')} value={snapshot.totals.requests.toLocaleString()} />
          <StatTile
            icon={<Database />}
            label={t('console.metricTokens')}
            value={snapshot.totals.totalTokens.toLocaleString()}
            hint={`${metricCompact(snapshot.totals.inputTokens)} ${t('console.metricInput')} · ${metricCompact(snapshot.totals.outputTokens)} ${t('console.metricOutput')}`}
            action={<Button variant="ghost" size="icon-sm" aria-label={t('console.metricBreakdown')} onClick={() => setBreakdownOpen(true)}><Ellipsis /></Button>}
          />
          <StatTile
            icon={<Database />}
            label={t('console.metricCacheHit')}
            value={formatMetricRate(snapshot.totals.cacheHitRate)}
            {...(snapshot.totals.cacheObservedRequests > 0 ? { hint: `${snapshot.totals.cacheObservedRequests.toLocaleString()} ${t('console.metricCacheRequests')}` } : {})}
          />
          <StatTile icon={<Clock3 />} label={t('console.metricLatency')} value={metricDuration(snapshot.totals.averageLatencyMs)} />
        </div>
        <TrendChart t={t} daily={snapshot.daily} to={snapshot.range.to} days={days} />
        <div className="grid min-w-0 gap-4">
          <Card>
            <PanelHeading icon={<BarChart3 />} action={<Badge variant="outline">{snapshot.providers.length}</Badge>}>{t('console.metricProviders')}</PanelHeading>
            <CardContent>
              <DataTable rows={snapshot.providers} columns={columns} rowKey={(row) => row.key} query={providerQuery} onQueryChange={setProviderQuery} labels={labels} searchText={metricsSearchText} sortValue={metricsSortValue} pageSizes={[10, 25, 50]} empty={<EmptyState icon={<BarChart3 />} title={t('console.noMetrics')} />} />
            </CardContent>
          </Card>
          <Card>
            <PanelHeading icon={<BrainCircuit />} action={<Badge variant="outline">{snapshot.models.length}</Badge>}>{t('console.metricModels')}</PanelHeading>
            <CardContent>
              <DataTable rows={snapshot.models} columns={columns} rowKey={(row) => row.key} query={modelQuery} onQueryChange={setModelQuery} labels={labels} searchText={metricsSearchText} sortValue={metricsSortValue} pageSizes={[10, 25, 50]} empty={<EmptyState icon={<BrainCircuit />} title={t('console.noMetrics')} />} />
            </CardContent>
          </Card>
        </div>
        <TokenBreakdown t={t} open={breakdownOpen} onOpenChange={setBreakdownOpen} totals={snapshot.totals} />
      </>}
  </div>;
}

/**
 * The page, before the first answer arrives.
 *
 * A card with the word "Loading" in the middle of it tells a reader nothing
 * about what is coming and moves everything when it does. These are the
 * shapes the tiles, the chart and the tables will occupy, in their places.
 */
function MetricsSkeleton() {
  return <div className="grid min-w-0 gap-4" aria-busy="true">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((tile) => <Card key={tile} className="gap-0 py-4"><CardContent className="grid gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-28" />
      </CardContent></Card>)}
    </div>
    <Card><CardContent className="py-6"><Skeleton className="h-56 w-full" /></CardContent></Card>
    <Card><CardContent className="grid gap-3 py-6">
      {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-5 w-full" />)}
    </CardContent></Card>
  </div>;
}

/**
 * The numbers only somebody tuning a prompt cache wants.
 *
 * They used to hang off an ellipsis in the corner of a tile, in a popover that
 * closed when the pointer left it. Behind a named button they can be read at
 * leisure, and the tile above is four numbers shorter.
 */
function TokenBreakdown({ t, open, onOpenChange, totals }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; totals: MetricsSnapshot['totals'] }) {
  // Cached tokens are reported by the provider, not counted here. Nothing
  // observed means nothing to say, which is not the same as zero.
  const cached = (value: number) => totals.cacheObservedRequests === 0 ? '—' : value.toLocaleString();
  const rows: Array<{ label: string; value: string }> = [
    { label: t('console.metricInput'), value: totals.inputTokens.toLocaleString() },
    { label: t('console.metricOutput'), value: totals.outputTokens.toLocaleString() },
    { label: t('console.metricCacheRead'), value: cached(totals.cacheReadTokens) },
    { label: t('console.metricCacheWrite'), value: cached(totals.cacheWriteTokens) },
    { label: t('console.metricReasoning'), value: totals.reasoningTokens.toLocaleString() },
    { label: t('console.metricStreaming'), value: totals.streamRequests.toLocaleString() },
  ];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('console.metricBreakdown')}</DialogTitle></DialogHeader>
      <DialogBody>
        {rows.map((row) => <DetailRow key={row.label} label={row.label}><span className="tabular-nums">{row.value}</span></DetailRow>)}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/**
 * How wide an element is right now, kept current as it changes.
 *
 * The activity chart was drawn once at 880 units and scaled to fit its card.
 * On a phone that is a scale of about 0.4, which took its ten-pixel labels
 * down to four - present, and unreadable. Drawn at the width it is shown at,
 * one unit is one pixel and a label is the size the stylesheet says.
 */
function useElementWidth<T extends HTMLElement>(fallback: number): { ref: RefObject<T | null>; width: number } {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function TrendChart({ t, daily, to, days }: { t: Translate; daily: readonly MetricsSnapshot['daily'][number][]; to: string; days: number }) {
  const [measure, setMeasure] = useState<'requests' | 'totalTokens'>('requests');
  const [selected, setSelected] = useState<string | null>(null);
  const { ref, width: measured } = useElementWidth<HTMLDivElement>(880);
  const byDay = new Map(daily.map((bucket) => [bucket.key, bucket]));
  const end = new Date(to.slice(0, 10));
  const series = Array.from({ length: days }, (_, index) => {
    const key = new Date(end.getTime() - (days - index - 1) * 86_400_000).toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    return { key, requests: bucket?.requests ?? 0, totalTokens: bucket?.totalTokens ?? 0 };
  });
  const maximum = Math.max(1, ...series.map((bucket) => bucket[measure]));
  const scale = maximum <= 4 ? maximum : Math.ceil(maximum / 4) * 4;
  const ticks = scale < 4 ? Array.from({ length: scale + 1 }, (_, i) => i) : [0, scale / 4, scale / 2, scale * .75, scale];
  const width = Math.max(260, measured);
  const compact = width < 560;
  const height = compact ? 200 : 250;
  const pad = { top: 12, right: compact ? 14 : 24, bottom: 28, left: compact ? 40 : 52 };
  const plotWidth = width - pad.left - pad.right; const plotHeight = height - pad.top - pad.bottom;
  const step = plotWidth / Math.max(1, series.length - 1);
  const xFor = (index: number) => pad.left + index * step;
  const yFor = (value: number) => pad.top + plotHeight * (1 - value / scale);
  // A date roughly every 64 pixels, whatever the width - five labels across a
  // desktop card, three on a phone - and never one crowding the last.
  const labelEvery = Math.max(1, Math.ceil(64 / step));
  const labelled = (index: number) => index === 0 || index === days - 1 || (index % labelEvery === 0 && days - 1 - index >= labelEvery * 0.75 && index >= labelEvery * 0.75);
  const anchor = (index: number) => index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle';
  const points = series.map((bucket, index) => `${xFor(index)},${yFor(bucket[measure])}`).join(' ');
  const selection = series.find((bucket) => bucket.key === selected) ?? series.at(-1)!;
  return <Card>
    <PanelHeading icon={<BarChart3 />} action={<Tabs value={measure} onValueChange={(value) => setMeasure(value as 'requests' | 'totalTokens')}>
      <TabsList aria-label={t('console.metricActivity')}>
        <TabsTrigger value="requests">{t('console.metricRequests')}</TabsTrigger>
        <TabsTrigger value="totalTokens">{t('console.metricTokens')}</TabsTrigger>
      </TabsList>
    </Tabs>}>{t('console.metricActivity')}</PanelHeading>
    <CardContent>
      <div ref={ref} className="min-w-0">
        <div className="trend-selection" style={{ marginLeft: pad.left }} aria-live="polite"><time dateTime={selection.key}>{new Date(selection.key).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })}</time><strong>{selection[measure].toLocaleString()}</strong><span>{t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}</span></div>
        {daily.length === 0 ? <EmptyState icon={<BarChart3 />} title={t('console.noMetrics')} /> : <div className="metrics-chart-shell">
          <svg className="metrics-chart-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('console.metricActivity')}>
            {ticks.map((value) => <g key={value}><line x1={pad.left} x2={width - pad.right} y1={yFor(value)} y2={yFor(value)} className="trend-grid-line" /><text x={pad.left - 8} y={yFor(value) + 4} textAnchor="end" className="trend-axis-label">{metricCompact(value)}</text></g>)}
            <polygon points={`${pad.left},${yFor(0)} ${points} ${width - pad.right},${yFor(0)}`} className="trend-area" />
            <polyline points={points} className="trend-line trend-line-request" />
            {series.map((bucket, index) => <g key={bucket.key}>
              {bucket.key === selection.key ? <line x1={xFor(index)} x2={xFor(index)} y1={pad.top} y2={yFor(0)} className="trend-cursor" /> : null}
              {bucket[measure] > 0 ? <circle cx={xFor(index)} cy={yFor(bucket[measure])} r={compact ? 2.5 : 3} className="trend-point trend-point-request" /> : null}
              {labelled(index) ? <text x={xFor(index)} y={height - 8} textAnchor={anchor(index)} className="trend-axis-label">{bucket.key.slice(5).replace('-', '/')}</text> : null}
              <rect x={xFor(index) - step / 2} y={pad.top} width={step} height={plotHeight} fill="transparent" tabIndex={0} role="button" aria-label={`${bucket.key}: ${bucket[measure]} ${t(measure === 'requests' ? 'console.metricRequestsShort' : 'console.metricTokens')}`} onPointerEnter={() => setSelected(bucket.key)} onFocus={() => setSelected(bucket.key)} onClick={() => setSelected(bucket.key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(bucket.key); } }} />
            </g>)}
          </svg>
        </div>}
      </div>
    </CardContent>
  </Card>;
}

function metricCompact(value: number): string { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }
function metricDuration(value: number): string { return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`; }
function formatMetricRate(value: number | null): string { return value === null ? '—' : `${(value * 100).toFixed(1)}%`; }

/**
 * The two passwords' page, and SillyTavern's own settings.
 *
 * A thirty-line YAML editor used to sit open at the bottom of it. It is the
 * one control here that can stop SillyTavern from starting, and it was the
 * largest thing on the page - so it is behind a button now, where somebody who
 * wants it will still find it and nobody else has to scroll past it.
 *
 * Whether a save worked was decided by testing the message for the English
 * word "Could", which meant a Vietnamese failure was shown in the colour of a
 * note. Success and failure are separate states now, and success is a toast,
 * because saving restarts SillyTavern and redraws the page underneath it.
 */
type FlagKey = Exclude<Extract<keyof ConfigSettingsInput, string>, 'memoryCacheCapacity' | 'chatBackupCount'>;

const MEMORY_CACHE_SIZES = ['0', '50mb', '100mb', '250mb', '500mb'] as const;
const CHAT_BACKUP_COUNTS = ['5', '20', '50', '100', '200'] as const;

/**
 * The settings the console offers, lifted out of everything the file says.
 *
 * The rest of `ConfigSettings` is reported rather than editable - the port,
 * the listen address, the two password mechanisms the gateway replaces - and
 * sending any of it back would be asking the server to refuse it.
 */
function offeredSettings(settings: ConfigSettings): ConfigSettingsInput {
  return {
    lazyLoadCharacters: settings.lazyLoadCharacters,
    useDiskCache: settings.useDiskCache,
    memoryCacheCapacity: settings.memoryCacheCapacity,
    requestCompression: settings.requestCompression,
    extensions: settings.extensions,
    extensionAutoUpdate: settings.extensionAutoUpdate,
    allowKeysExposure: settings.allowKeysExposure,
    chatBackups: settings.chatBackups,
    chatBackupCount: settings.chatBackupCount,
  };
}

/** `1.19.0` is a number; `v1.19.0` is a version. */
function versionLabel(ref: string): string {
  return /^[0-9]/u.test(ref) ? `v${ref}` : ref;
}

/** `config.yaml`, or `config.yml` where that is what the version wrote. */
function configFileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? 'config.yaml';
}

/**
 * The three ports, and the one of them this page can move.
 *
 * The console's own and the gateway's are shown but not editable: they are read
 * from the environment once, at startup, and moving the port a page is served
 * on from that page takes the page down with it. Saying so on the row is worth
 * more than a control that would have to explain why it did nothing.
 *
 * SillyTavern's is checked here before it is sent, because the reader is still
 * looking at the field; the server checks it again, because a panel is not what
 * guarantees two services do not land on one port.
 */
/**
 * What the manager does with SillyTavern when it opens.
 *
 * Its own card rather than a row among SillyTavern's settings: everything
 * there is written into the installed runtime's config.yaml and belongs to the
 * version installed. This belongs to the manager and outlives every version it
 * installs - which is also why it is not in the file the Edit button opens.
 */
function StartupCard({ t, startup, onSetAutoStart }: { t: Translate; startup: StartupSettings | null; onSetAutoStart: (enabled: boolean) => Promise<string | null> }) {
  // What the switch shows while the answer is in flight, so it moves under the
  // press rather than a second later.
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const checked = pending ?? startup?.autoStartSillyTavern ?? null;
  const save = async (next: boolean) => {
    setPending(next); setBusy(true);
    try {
      const failure = await onSetAutoStart(next);
      if (failure) { toast({ title: failure, tone: 'destructive' }); return; }
      // Not `configSaved`: nothing was written into SillyTavern's own config and
      // nothing restarted. What changed is what the next start will do.
      toast({ title: t('console.startupSaved'), tone: 'success' });
    } finally { setPending(null); setBusy(false); }
  };
  return <Card>
    <PanelHeading icon={<Play />}>{t('console.startupTitle')}</PanelHeading>
    <CardContent>
      <DetailRow label={t('console.autoStartSillyTavern')} hint={t('console.autoStartSillyTavernHint')}>
        {checked === null
          ? <Skeleton className="h-5 w-9" />
          : <Switch checked={checked} disabled={busy} onCheckedChange={(next) => void save(next)} aria-label={t('console.autoStartSillyTavern')} />}
      </DetailRow>
    </CardContent>
  </Card>;
}

function PortsCard({ t, ports, process, busy, onPortChange }: { t: Translate; ports: PortSettings | null; process: ProcessState; busy: boolean; onPortChange: (port: number) => Promise<string | null> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputId = useId();
  // Reset when the server's answer changes, so a half-typed number is not left
  // sitting over a port that has since moved.
  useEffect(() => { if (ports) { setValue(ports.port.toString(10)); setError(null); } }, [ports]);
  if (!ports) return null;

  const typed = Number(value.trim());
  const refusal = portRefusal(value, ports.reserved);
  const failure = refusal ? t(refusal.key, refusal.params) : null;
  const unchanged = refusal === null && typed === ports.port;
  const running = process.status === 'running';

  const save = async () => {
    setSaving(true); setError(null);
    try {
      setError(await onPortChange(typed));
    } finally { setSaving(false); }
  };

  return <Card>
    <PanelHeading icon={<Globe2 />}>{t('console.portsTitle')}</PanelHeading>
    <CardContent>
      <div>
        <DetailRow label={<Label htmlFor={inputId}>{t('console.sillyTavernPort')}</Label>} hint={t('console.sillyTavernPortHint')}>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              className="w-28"
              inputMode="numeric"
              autoComplete="off"
              value={value}
              disabled={busy || saving}
              aria-invalid={failure !== null}
              onChange={(event) => { setValue(event.target.value); setError(null); }}
            />
            <Button size="sm" disabled={busy || saving || unchanged || failure !== null} onClick={() => setConfirmOpen(true)}>
              {saving ? <LoaderCircle className="animate-spin" /> : null}{t('common.save')}
            </Button>
          </div>
        </DetailRow>
        <DetailRow label={t('console.managerPort')} hint={t('console.managerPortHint')}>
          <code className="font-mono text-sm text-muted-foreground">{ports.reserved.manager}</code>
        </DetailRow>
        <DetailRow label={t('console.accessPort')} hint={t('console.accessPortHint')}>
          <code className="font-mono text-sm text-muted-foreground">{ports.reserved.access}</code>
        </DetailRow>
      </div>
      {failure ?? error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{failure ?? error}</AlertDescription></Alert> : null}
    </CardContent>
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      tone="default"
      title={t('console.portChangeTitle')}
      description={running ? t('console.portChangeBodyRunning', { port: typed }) : t('console.portChangeBody', { port: typed })}
      confirmLabel={t('common.save')}
      cancelLabel={t('common.cancel')}
      onConfirm={save}
    />
  </Card>;
}

/** A name over a run of rows, so one long list reads as three short ones. */
function SettingsGroup({ icon, title }: { icon: ReactNode; title: string }) {
  return <div className="flex items-center gap-2 border-t pt-4 pb-2 text-sm font-medium first:border-t-0 first:pt-0 [&_svg]:size-4 [&_svg]:text-muted-foreground">
    {icon}{title}
  </div>;
}

function ConfigPage({ t, locale, config, security, ports, managerTunnel, process, catalog, startup, onSetAutoStart, onSetManagerTunnel, onPortChange, onConfigUpdate, onConfigReset, onChangeManagerPassword, onSetPassword, onSignOut, onSignOutDevices }: { t: Translate; locale: LocaleCode; config: ConfigDocument | null; security: AccessGatewayState; ports: PortSettings | null; managerTunnel: TunnelState; process: ProcessState; catalog: Record<string, unknown>; startup: StartupSettings | null; onSetAutoStart: (enabled: boolean) => Promise<string | null>; onSetManagerTunnel: (on: boolean) => Promise<string | null>; onPortChange: (port: number) => Promise<string | null>; onConfigUpdate: (input: ConfigUpdateInput) => Promise<string | null>; onConfigReset: () => Promise<string | null>; onChangeManagerPassword: (password: string, confirmPassword: string) => Promise<string | null>; onSetPassword: (password: string, confirmPassword: string) => Promise<string | null>; onSignOut: () => Promise<void>; onSignOutDevices: () => Promise<string | null> }) {
  const [form, setForm] = useState<ConfigSettingsInput>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerPasswordOpen, setManagerPasswordOpen] = useState(false);
  const [sillyPasswordOpen, setSillyPasswordOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [signOutDevicesOpen, setSignOutDevicesOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [managerTunnelBusy, setManagerTunnelBusy] = useState(false);
  const [managerTunnelError, setManagerTunnelError] = useState<string | null>(null);
  const [managerTunnelClosing, setManagerTunnelClosing] = useState(false);
  const [legalOpen, setLegalOpen] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocumentId>('terms');
  const { toast } = useToast();
  // What the switch says, which is what was asked for rather than whether
  // cloudflared has finished connecting - the same reading the sharing card
  // uses, for the same reason.
  const managerTunnelWanted = managerTunnel.mode !== 'off';
  /*
   * The address to show for the console's own link.
   *
   * The Worker's, when Cloudflare is signed in: it is the same address every
   * time, which is the only kind worth writing down or putting on a phone. The
   * tunnel's own is shown underneath it rather than instead of it, because it
   * is what the traffic really goes through and it changes on every restart.
   */
  const managerTunnelLink = managerTunnel.proxyUrl ?? managerTunnel.url;
  const applyManagerTunnel = async (on: boolean) => {
    setManagerTunnelBusy(true); setManagerTunnelError(null);
    try {
      const failure = await onSetManagerTunnel(on);
      setManagerTunnelError(failure);
      if (!failure) toast({ title: on ? t('console.managerTunnelOnDone') : t('console.managerTunnelOffDone'), tone: 'success' });
    } finally { setManagerTunnelBusy(false); }
  };
  useEffect(() => {
    if (!config) return;
    setForm(offeredSettings(config.settings));
  }, [config]);
  const save = async (input: ConfigUpdateInput): Promise<string | null> => {
    setBusy(true); setError(null);
    try {
      const failure = await onConfigUpdate(input);
      setError(failure);
      if (!failure) toast({ title: t('console.configSaved'), tone: 'success' });
      return failure;
    } finally { setBusy(false); }
  };
  const restoreDefaults = async () => {
    setBusy(true); setError(null);
    try {
      const failure = await onConfigReset();
      setError(failure);
      if (!failure) toast({ title: t('console.restoreDefaultsDone'), tone: 'success' });
    } finally { setBusy(false); }
  };
  const saveManagerPassword = async (password: string, confirmPassword: string): Promise<string | null> => {
    const failure = await onChangeManagerPassword(password, confirmPassword);
    if (!failure) toast({ title: t('console.managerPasswordSaved'), tone: 'success' });
    return failure;
  };
  const set = <K extends keyof ConfigSettingsInput>(key: K, value: ConfigSettingsInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const flag = (key: FlagKey, options: { readonly disabled?: boolean } = {}) =>
    <DetailRow key={key} label={t(`console.settings.${key}`)} hint={t(`console.settings.${key}Hint`)} className={options.disabled ? 'opacity-55' : ''}>
      <Switch
        checked={form[key] === true}
        onCheckedChange={(value) => set(key, value)}
        disabled={options.disabled ?? false}
        aria-label={t(`console.settings.${key}`)}
      />
    </DetailRow>;
  const choice = (key: 'memoryCacheCapacity' | 'chatBackupCount', values: readonly string[], options: { readonly disabled?: boolean } = {}) =>
    <DetailRow label={t(`console.settings.${key}`)} hint={t(`console.settings.${key}Hint`)} className={options.disabled ? 'opacity-55' : ''}>
      <Select
        value={String(form[key] ?? '')}
        onValueChange={(value) => set(key, (key === 'chatBackupCount' ? Number(value) : value) as never)}
        disabled={options.disabled ?? false}
      >
        <SelectTrigger size="sm" className="w-32" aria-label={t(`console.settings.${key}`)}><SelectValue /></SelectTrigger>
        <SelectContent>
          {values.map((value) => <SelectItem key={value} value={value}>{value === '0' ? t('console.settings.cacheOff') : value}</SelectItem>)}
        </SelectContent>
      </Select>
    </DetailRow>;

  /*
   * One card for both doors.
   *
   * It is not "Passwords": half of what it holds is signing out, and the two
   * belong together anyway - the reason to change a credential and the reason
   * to end the sessions opened with it are usually the same reason. Each row
   * is one door, with the two things that can be done to it.
   *
   * The labels only appear from `sm` up. On a phone the row has a name, and a
   * pencil next to a name has never needed the word "edit" under it.
   */
  /*
   * The visible word is the short one; the whole sentence stays as the
   * accessible name and the tooltip. Two rows each carrying "Đổi mật khẩu" and
   * "Đổi mã PIN" spelt out is the same verb four times on one card, and the
   * row already says which door it is about. Signing out is the destructive
   * one of the pair, and is coloured as such so the two are not one row of
   * identical grey buttons.
   */
  const rowAction = (icon: ReactNode, label: string, full: string, onClick: () => void, options: { readonly variant?: 'outline' | 'destructive'; readonly disabled?: boolean } = {}) =>
    <Button variant={options.variant ?? 'outline'} size="sm" disabled={options.disabled ?? false} aria-label={full} title={full} onClick={onClick}>
      {icon}<span className="hidden sm:inline">{label}</span>
    </Button>;

  return <div className="grid min-w-0 gap-4">
    <Card>
      <PanelHeading icon={<ShieldCheck />}>{t('console.securityTitle')}</PanelHeading>
      <CardContent>
        <div>
          <DetailRow label={t('console.managerPasswordTitle')} hint={t('console.managerPasswordHint')}>
            <div className="flex items-center gap-1">
              {rowAction(<Pencil />, t('common.edit'), t('console.changeManagerPassword'), () => setManagerPasswordOpen(true), { variant: 'outline' })}
              {rowAction(<LogOut />, t('console.signOut'), t('console.signOutManager'), () => void onSignOut(), { variant: 'destructive' })}
            </div>
          </DetailRow>
          <DetailRow
            label={<span className="flex flex-wrap items-center gap-2">{t('console.passwordSettings')}{security.passwordConfigured ? null : <Badge variant="outline">{t('console.passwordNotSetYet')}</Badge>}</span>}
            hint={t('console.sillyPasswordHint')}
          >
            <div className="flex items-center gap-1">
              {rowAction(<Pencil />, security.passwordConfigured ? t('common.edit') : t('console.setPasscode'), security.passwordConfigured ? t('console.changeSillyPassword') : t('console.setSillyPassword'), () => setSillyPasswordOpen(true), { variant: 'outline' })}
              {rowAction(<LogOut />, t('console.signOut'), security.sessions > 0 ? t('console.signOutDevices') : t('console.signOutDevicesNone'), () => setSignOutDevicesOpen(true), { variant: 'destructive', disabled: security.sessions === 0 })}
            </div>
          </DetailRow>
          {/* Here rather than on the sharing card: that card is about letting
              people into SillyTavern, and this is about letting them as far as
              the console - which is the side that installs software and holds
              the Cloudflare tokens. It belongs next to the password that is the
              only thing guarding it. */}
          {/* The address in full, and clickable, rather than a shortened
              fragment beside a Copy button. What somebody wants from this row
              is to be at that page, or to send it to a phone - and a link they
              can press does the first and lets them copy the second for
              themselves. The button beside it opens the same address, for a
              reader whose eye goes to the buttons rather than to the text. */}
          <DetailRow
            label={t('console.managerTunnel')}
            hint={managerTunnelLink
              ? <a className="break-all font-mono underline underline-offset-4" href={managerTunnelLink} target="_blank" rel="noopener noreferrer">{managerTunnelLink}</a>
              : t('console.managerTunnelHint')}
          >
            <div className="flex items-center gap-1">
              {managerTunnelLink
                ? <Button variant="outline" size="sm" aria-label={t('console.openInTab')} title={t('console.openInTab')} asChild>
                  <a href={managerTunnelLink} target="_blank" rel="noopener noreferrer"><ArrowUpRight /><span className="hidden sm:inline">{t('console.openInTab')}</span></a>
                </Button>
                : null}
              <Switch
                checked={managerTunnelWanted}
                disabled={managerTunnelBusy}
                onCheckedChange={(next) => { if (next) void applyManagerTunnel(true); else setManagerTunnelClosing(true); }}
                aria-label={t('console.managerTunnel')}
              />
            </div>
          </DetailRow>
        </div>
        {managerTunnelError ? <Alert variant="destructive" className="mt-4"><AlertDescription>{managerTunnelError}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
    <ConfirmDialog
      open={signOutDevicesOpen}
      onOpenChange={setSignOutDevicesOpen}
      title={t('console.signOutDevicesTitle')}
      description={t('console.signOutDevicesBody', { count: security.sessions })}
      confirmLabel={t('console.signOutDevices')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => { await onSignOutDevices(); }}
    />
    <ConfirmDialog
      open={managerTunnelClosing}
      onOpenChange={(open) => { if (!open) setManagerTunnelClosing(false); }}
      title={t('console.managerTunnelOffConfirm')}
      // Closing the link a reader arrived through takes their own page with
      // it, which is worth saying before they press the button rather than
      // leaving them to work out why the console stopped answering.
      description={managerTunnelLink && window.location.origin === managerTunnelLink.replace(/\/$/u, '')
        ? t('console.managerTunnelOffConfirmBodyHere')
        : t('console.managerTunnelOffConfirmBody')}
      confirmLabel={t('common.turnOff')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => applyManagerTunnel(false)}
    />
    <StartupCard t={t} startup={startup} onSetAutoStart={onSetAutoStart} />
    <PortsCard t={t} ports={ports} process={process} busy={busy} onPortChange={onPortChange} />
    <PasswordDialog t={t} open={managerPasswordOpen} onOpenChange={setManagerPasswordOpen} title={t('console.managerPasswordTitle')} description={t('console.managerPasswordHint')} note={t('console.passwordChangeSignsOut')} minLength={MIN_MANAGER_PASSWORD} hint={t('console.managerPasswordMin')} submitLabel={t('console.changePassword')} onSubmit={saveManagerPassword} />
    <PasscodeDialog t={t} open={sillyPasswordOpen} onOpenChange={setSillyPasswordOpen} note={security.passwordConfigured ? t('console.passwordChangeSignsOut') : null} onSubmit={onSetPassword} />
    {!config
      ? <Card><CardContent className="px-0"><EmptyState icon={<Settings2 />} title={t('console.noConfiguration')} /></CardContent></Card>
      : <>
        <Card>
          <PanelHeading icon={<Settings2 />} action={<Badge variant="outline">{versionLabel(config.runtimeRef)}</Badge>}>{t('console.configTitle')}</PanelHeading>
          <CardContent className="grid gap-5">
            <div>
              <SettingsGroup icon={<Gauge />} title={t('console.performanceTitle')} />
              {flag('lazyLoadCharacters')}
              {flag('useDiskCache')}
              {choice('memoryCacheCapacity', MEMORY_CACHE_SIZES)}
              {flag('requestCompression')}
            </div>
            <div>
              <SettingsGroup icon={<Blocks />} title={t('console.extensionsTitle')} />
              {flag('extensions')}
              {flag('extensionAutoUpdate', { disabled: form.extensions !== true })}
            </div>
            <div>
              <SettingsGroup icon={<KeyRound />} title={t('console.apiKeysTitle')} />
              {flag('allowKeysExposure')}
            </div>
            <div>
              <SettingsGroup icon={<History />} title={t('console.chatBackupsTitle')} />
              {flag('chatBackups')}
              {choice('chatBackupCount', CHAT_BACKUP_COUNTS, { disabled: form.chatBackups !== true })}
            </div>
            {/* Still in this card - every switch above is a line in this
                file - but set into a block of its own, because editing the
                file by hand is a different act from flipping a switch and
                should not read as the next row down. */}
            <div className="mt-2 grid gap-3 rounded-xl border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="flex items-center gap-2 text-sm font-medium"><FileCode2 className="size-4 text-muted-foreground" />{t('console.configFileTitle')}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><TriangleAlert className="size-3.5" />{t('console.configFileCaution')}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('console.configFileHint')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="mr-auto font-mono text-sm">{configFileName(config.path)}</code>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetOpen(true)}><RotateCcw />{t('console.restoreDefaults')}</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setYamlOpen(true)}><Pencil />{t('common.edit')}</Button>
              </div>
            </div>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {/* Saving stops SillyTavern, writes the file and starts it again,
                which takes as long as a start does. The dialog is gone by
                then, so the progress is here, step by step. */}
            {busy ? <div className="grid gap-2 rounded-lg border bg-muted/40 p-3" role="status">
              <TaskLine task={t('console.taskSettings')} step={(process.status === 'starting' || process.status === 'stopping') && process.stepCode ? translateStep('', catalog, process.stepCode, process.stepParams) : t('console.settingsWriting')} />
              <TaskBar />
            </div> : null}
          </CardContent>
          <CardFooter className="justify-end">
            <Button onClick={() => setSaveOpen(true)} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : null}{t('console.saveChanges')}</Button>
          </CardFooter>
        </Card>
        <ConfirmDialog
          open={saveOpen}
          onOpenChange={setSaveOpen}
          tone="default"
          title={t('console.saveChangesTitle')}
          description={t('console.saveChangesBody')}
          confirmLabel={t('console.saveChanges')}
          cancelLabel={t('common.cancel')}
          onConfirm={async () => { await save({ settings: form }); }}
        />
        <ConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          title={t('console.restoreDefaultsTitle')}
          description={t('console.restoreDefaultsBody')}
          confirmLabel={t('console.restoreDefaults')}
          cancelLabel={t('common.cancel')}
          onConfirm={restoreDefaults}
        />
      </>}
    {config ? <YamlDialog t={t} open={yamlOpen} onOpenChange={setYamlOpen} initial={config.rawYaml} busy={busy} onApply={(rawYaml) => save({ rawYaml })} /> : null}
    <AboutPanel t={t} locale={locale} onOpenLegal={(id) => { setLegalDocument(id); setLegalOpen(true); }} />
    <LegalDialog
      t={t}
      locale={locale}
      open={legalOpen}
      onOpenChange={setLegalOpen}
      document={legalDocument}
      onDocumentChange={setLegalDocument}
    />
  </div>;
}

/**
 * What this is, which version, and where it came from.
 *
 * Every open-source application answers these three questions somewhere, and
 * this is the page people already come to when they want to know what their
 * copy is doing. It is also the only place after the first run where the terms
 * can be read again, which is the point of having asked somebody to accept
 * them: an agreement you cannot reread is not one you can hold to.
 */
function AboutPanel({ t, locale, onOpenLegal }: { t: Translate; locale: LocaleCode; onOpenLegal: (document: LegalDocumentId) => void }) {
  const bundle = legalBundle(locale);
  const links = [
    { href: LEGAL_REVISION.repository, icon: <GithubMark className="size-4" />, label: t('console.aboutSource') },
    { href: LEGAL_REVISION.site, icon: <Globe2 />, label: t('console.aboutSite') },
    { href: LEGAL_REVISION.issues, icon: <Bug />, label: t('console.aboutIssues') },
  ];
  return <Card>
    <PanelHeading icon={<Scale />} action={<Badge variant="outline">v{__STM_VERSION__}</Badge>}>{t('console.aboutTitle')}</PanelHeading>
    <CardContent className="grid gap-4">
      <div className="about-lockup">
        <BrandMark size={44} />
        <div className="grid gap-1">
          <span className="text-sm font-semibold">SillyTavern Manager</span>
          <p className="text-xs text-muted-foreground">{t('console.aboutBody')}</p>
        </div>
      </div>
      <div className="about-links">
        {links.map(({ href, icon, label }) => (
          <a key={href} href={href} target="_blank" rel="noreferrer noopener">{icon}<span>{label}</span><ArrowUpRight className="size-3.5 opacity-60" /></a>
        ))}
      </div>
      <div className="about-documents">
        {bundle.documents.map((document) => (
          <Button key={document.id} variant="outline" size="sm" onClick={() => onOpenLegal(document.id)}>{document.short}</Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('console.aboutLicence')}</p>
    </CardContent>
  </Card>;
}

/** SillyTavern's own configuration file, for whoever wants to edit it directly. */
function YamlDialog({ t, open, onOpenChange, initial, busy, onApply }: { t: Translate; open: boolean; onOpenChange: (open: boolean) => void; initial: string; busy: boolean; onApply: (rawYaml: string) => Promise<string | null> }) {
  const [rawYaml, setRawYaml] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // Opening reloads the file as it is on disk, so an edit abandoned last time
  // is not silently re-applied over a change made since.
  useEffect(() => { if (open) { setRawYaml(initial); setError(null); } }, [open, initial]);

  const apply = async () => {
    const failure = await onApply(rawYaml);
    setError(failure);
    if (!failure) onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle className="font-mono">{t('console.configFile')}</DialogTitle>
        <DialogDescription>{t('console.rawYamlHint')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-3">
        <textarea className="config-editor" value={rawYaml} onChange={(event) => setRawYaml(event.target.value)} spellCheck={false} aria-label={t('console.configFile')} />
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common.cancel')}</Button>
        <Button onClick={() => void apply()} disabled={busy}>{t('console.applyYaml')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ResourcePanel({ page, t }: { page: Exclude<PageId, 'overview' | 'data'>; t: Translate }) {
  const emptyMessage = { metrics: 'console.noMetrics', config: 'console.noConfiguration' } as const;
  return <Card className="resource-panel"><CardContent className="resource-empty"><p>{t(emptyMessage[page])}</p></CardContent></Card>;
}
