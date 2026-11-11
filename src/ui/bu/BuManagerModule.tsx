import { useMemo } from 'react';
import { createSyntheticBuManagerReader } from '../../adapters/fixture/buManagerFixture';
import { createPptbBuManagerReader } from '../../adapters/pptb/buManagerReader';
import { connectionFingerprint } from '../../adapters/pptb/identity';
import type { BuManagerReader } from '../../application/buManager/ports';
import type { BusinessUnit } from '../../domain/buMove/types';
import type { ModuleContext } from '../modules';
import { useReadResult } from '../useAsync';
import { BuWizard } from './BuWizard';
import type { UnitsView } from './TargetStep';
import type { Downloader } from './download';
import { useBuManager } from './useBuManager';
import './bu.css';

type Props = Partial<Pick<ModuleContext, 'host' | 'dataSource' | 'connection' | 'writer' | 'environmentId'>> & {
  /** Test seam: replaces the reader the module would create. */
  readonly reader?: BuManagerReader;
  readonly download?: Downloader;
  /** Test seam: replaces the live connection fingerprint read. */
  readonly readFingerprint?: () => Promise<string | null>;
  /** Opens another screen of the app (the result links to Operations & History). */
  readonly openModule?: (id: string) => void;
};

function Composer({ reader, writer, environmentId, connection, demo, download, readFingerprint, openModule }: {
  readonly reader: BuManagerReader;
  readonly writer: ModuleContext['writer'] | undefined;
  readonly environmentId: string | undefined;
  readonly connection: ModuleContext['connection'] | undefined;
  readonly demo: boolean;
  readonly download: Downloader | undefined;
  readonly readFingerprint: (() => Promise<string | null>) | undefined;
  readonly openModule: ((id: string) => void) | undefined;
}) {
  const hostConnection = connection?.kind === 'host' ? connection : null;
  const manager = useBuManager({
    reader,
    writer: demo ? null : (writer ?? null),
    actor: 'Tool user (confirmed in the PPTB UI)',
    environmentId: demo ? null : (environmentId ?? null),
    connectionKey: hostConnection ? `${hostConnection.name}|${hostConnection.url}` : null,
    ...(readFingerprint ? { readFingerprint } : {}),
  });
  const units = useReadResult<readonly BusinessUnit[]>(() => reader.listBusinessUnits(), 'bus');
  const environmentLabel = hostConnection ? `${hostConnection.name} (${hostConnection.url})` : 'the connected environment';
  const unitsView: UnitsView = {
    loading: units.state.phase === 'loading',
    error: units.state.phase === 'done' && units.state.result.status === 'error' ? units.state.result.message : null,
    notes: units.state.phase === 'done' && units.state.result.status === 'partial' ? units.state.result.notes : [],
    list: units.state.phase === 'done' && units.state.result.status !== 'error' ? units.state.result.data : [],
    retry: units.retry,
  };

  return (
    <section className="bu-manager" aria-label="BU Manager">
      <h2>BU Manager</h2>
      {demo && <p className="hint">Demo data: fictional users and business units. Nothing is read from or written to an environment, and executing is not available.</p>}
      <p className="hint">Move users to another business unit: preview first, confirm explicitly, and every step is verified by reading the user again.</p>
      {manager.notice && <p role="alert" className="msg msg-warn">{manager.notice}</p>}
      <BuWizard
        reader={reader}
        manager={manager}
        units={unitsView}
        environmentLabel={environmentLabel}
        demo={demo}
        download={download}
        onOpenOperations={openModule ? () => openModule('operations') : undefined}
      />
    </section>
  );
}

/**
 * The BU Manager module. Live inside a PPTB host, synthetic demo data otherwise; the two are never mixed (a failed live read is an error, never
 * demo data), and the demo can never execute. Writes go only through the approved writer after a person confirms the exact plan.
 */
export function BuManagerModule({ host, dataSource, connection, writer, environmentId, reader, download, readFingerprint, openModule }: Props) {
  const live = dataSource === 'live';
  const resolved = useMemo<BuManagerReader>(() => reader ?? (live ? createPptbBuManagerReader(host) : createSyntheticBuManagerReader({ latencyMs: 150 })), [reader, live, host]);
  // Live: the real host connection (id + URL + slot count) is read again at preview, while it is open and at confirmation.
  const liveFingerprint = useMemo<(() => Promise<string | null>) | undefined>(
    () => readFingerprint ?? (live && host ? () => connectionFingerprint(host.toolboxAPI?.connections) : undefined),
    [readFingerprint, live, host],
  );
  return <Composer reader={resolved} writer={writer} environmentId={environmentId} connection={connection} demo={!reader && !live} download={download} readFingerprint={liveFingerprint} openModule={openModule} />;
}
