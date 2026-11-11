import { useEffect, useMemo, useState } from 'react';
import { Icon, MODULE_ICON } from './Icon';
import type { HostWindow } from '../adapters/pptb/connection';
import type { DataSource } from '../app/dataSource';
import { requiresProductionAcknowledgement, type EnvironmentResolver } from '../app/environment';
import { normalizeUrl, type VerifiedEnvironment } from '../adapters/pptb/identity';
import type { SecurityDataReader } from '../ports/securityDataReader';
import type { SecurityDataWriter } from '../ports/securityDataWriter';
import { EnvironmentIndicator } from './EnvironmentIndicator';
import { DEFAULT_MODULES, type AppModule } from './modules';
import { ReportContext, DEFAULT_REPORT_SERVICES, type ReportServices } from './reports/ReportContext';
import { OperationRecorderContext } from './operations/RecorderContext';
import { getOperationRecorder } from './operations/storeProvider';
import { useConnectionWatch } from './useConnectionWatch';

interface Props {
  readonly reader: SecurityDataReader;
  readonly host?: HostWindow;
  /** Where the data comes from; defaults to synthetic (the demo reader). */
  readonly dataSource?: DataSource;
  /** The modules of the shell; features register here, the shell itself does not change. */
  readonly modules?: readonly AppModule[];
  /** The approved writer (only inside a PPTB host that provides the Dataverse API). Without one nothing can be written. */
  readonly writer?: SecurityDataWriter | null;
  /** The environment edits are confirmed for (a fixed one: tests and lock builds). Without it the environment is identified at run time through `resolveEnvironment`. */
  readonly environmentId?: string;
  /** Identifies the connected environment (decision D1: no fixed environment). Runs again whenever the connection changes. */
  readonly resolveEnvironment?: EnvironmentResolver;
  /** Overrides for report export (clock, downloader, clipboard, environment name); tests inject these. */
  readonly report?: Partial<ReportServices>;
}

/** When identifying the environment fails, it is tried again after these delays (ms); then the person can check again by hand. */
const IDENTIFY_RETRY_MS: readonly number[] = [2000, 5000, 10000];

export function App({ reader, host, dataSource = 'synthetic', modules = DEFAULT_MODULES, writer = null, environmentId, resolveEnvironment, report }: Props) {
  // One history for this host: the three write paths record into it, the Operations module shows it.
  const recorder = useMemo(() => getOperationRecorder(host), [host]);
  const [activeId, setActiveId] = useState<string>(modules[0]?.id ?? '');
  // Modules already visited and flagged keepAlive stay mounted (hidden) so their state survives a switch.
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set(modules[0] ? [modules[0].id] : []));
  // The active connection is watched for the whole app: a change reloads every screen (see useConnectionWatch).
  const { connection, epoch, notice, dismissNotice } = useConnectionWatch(host);

  // The connected environment, identified per connection epoch. Until it is identified nothing can be written (fail closed).
  const [resolved, setResolved] = useState<{ readonly epoch: number; readonly environment: VerifiedEnvironment | null } | null>(null);
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [identifyAttempt, setIdentifyAttempt] = useState(0);
  useEffect(() => {
    if (!resolveEnvironment || !writer) return undefined;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (attemptNo: number) => {
      void resolveEnvironment().then((environment) => {
        if (!current) return;
        setResolved({ epoch, environment });
        // A transient failure (for example a network error while the organization is read) must not leave editing off for the whole session:
        // retry a few times by itself; after that the person can check again by hand. Writes stay off until an environment is identified.
        const delay = IDENTIFY_RETRY_MS[attemptNo];
        if (environment === null && delay !== undefined) timer = setTimeout(() => run(attemptNo + 1), delay);
      });
    };
    run(0);
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
    };
  }, [resolveEnvironment, writer, epoch, identifyAttempt]);
  const environment = resolved && resolved.epoch === epoch ? resolved.environment : null;
  const identifyFailed = Boolean(resolveEnvironment && writer && resolved && resolved.epoch === epoch && resolved.environment === null);
  const effectiveEnvironmentId = environmentId ?? environment?.key;
  const environmentAliases = useMemo(
    () => (environment ? [environment.key, environment.environmentId, environment.organizationId].filter((k): k is string => typeof k === 'string' && k !== '') : []),
    [environment],
  );
  // The identified environment and the header's connection must be the same one (and its type known): an unavailable or still unread connection
  // state is NOT "no acknowledgement needed", it keeps writes off.
  const typeKnown = environment !== null && connection?.kind === 'host' && normalizeUrl(connection.url) === environment.url;
  // A Production-typed (or untyped) environment needs an acknowledgement, given for that environment only: a different one asks again.
  const needsAcknowledgement = environmentId === undefined && typeKnown && connection?.kind === 'host' && requiresProductionAcknowledgement(connection.environmentType);
  const acknowledgedHere = environment !== null && acknowledged === environment.key;
  const effectiveWriter =
    writer !== null && effectiveEnvironmentId !== undefined && (environmentId !== undefined || typeKnown) && (!needsAcknowledgement || acknowledgedHere) ? writer : null;

  const open = (id: string) => {
    setActiveId(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
  };

  // How the environment is named in exported reports: the real connection, or plainly the demo data.
  const reportServices = useMemo(
    () => ({ ...DEFAULT_REPORT_SERVICES, environment: connection?.kind === 'host' ? `${connection.name} (${connection.url})` : connection?.kind === 'demo' ? 'Demo data (synthetic, not a real environment)' : DEFAULT_REPORT_SERVICES.environment }),
    [connection],
  );
  const reportValue = useMemo(() => ({ ...reportServices, ...report }), [reportServices, report]);
  const context = { reader, ...(host ? { host } : {}), dataSource, connection, writer: effectiveWriter, ...(effectiveWriter && effectiveEnvironmentId ? { environmentId: effectiveEnvironmentId, environmentAliases } : {}), openModule: open };

  return (
    <OperationRecorderContext.Provider value={recorder}>
    <ReportContext.Provider value={reportValue}>
    <div className="app">
      <header className="app-header">
        <h1>Dataverse Security Manager</h1>
        <EnvironmentIndicator
          connection={connection}
          dataSource={dataSource}
          canWrite={effectiveWriter !== null}
          {...(identifyFailed ? { identification: { onRetry: () => setIdentifyAttempt((n) => n + 1) } } : {})}
          {...(needsAcknowledgement && environment ? { acknowledgement: { given: acknowledgedHere, onChange: (on: boolean) => setAcknowledged(on ? environment.key : null) } } : {})}
        />
      </header>
      {notice ? (
        <div className="app-notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={dismissNotice}>Dismiss</button>
        </div>
      ) : null}
      <nav aria-label="Screens" className="nav">
        {modules.map((m) => (
          <button key={m.id} type="button" aria-current={activeId === m.id ? 'page' : undefined} onClick={() => open(m.id)}>
            {MODULE_ICON[m.id] ? <Icon name={MODULE_ICON[m.id] as string} /> : null}
            {m.label}
          </button>
        ))}
      </nav>
      <main>
        {modules.map((m) => {
          const active = m.id === activeId;
          if (!active && !(m.keepAlive && visited.has(m.id))) return null;
          return (
            // Keyed on the connection epoch: after a connection change every screen, keep-alive ones included, starts fresh.
            <div key={`${m.id}:${epoch}`} hidden={!active} data-module={m.id}>
              {m.render(context)}
            </div>
          );
        })}
      </main>
      <footer className="app-footer" data-testid="build-stamp">{__DSM_BUILD__}</footer>
    </div>
    </ReportContext.Provider>
    </OperationRecorderContext.Provider>
  );
}
