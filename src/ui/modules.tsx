import { useMemo, useState, type ReactNode } from 'react';
import { FixtureAccessReader } from '../adapters/fixture/accessFixture';
import { createPptbAccessReader } from '../adapters/pptb/accessReader';
import { connectionFingerprint } from '../adapters/pptb/identity';
import { restoreReaders } from '../application/operations/restore';
import type { DataSource } from '../app/dataSource';
import type { ConnectionState, HostWindow } from '../adapters/pptb/connection';
import type { RoleMatrix as RoleMatrixData, TableInfo } from '../domain/privileges';
import type { SecurityDataReader } from '../ports/securityDataReader';
import type { SecurityDataWriter } from '../ports/securityDataWriter';
import { AccessExplorerModule } from './access/AccessExplorerModule';
import { BuManagerModule } from './bu/BuManagerModule';
import { OperationsModule } from './operations/OperationsModule';
import type { RestoreWiring } from './operations/useRestore';
import { getOperationStore } from './operations/storeProvider';
import { RoleMatrix, type EditingConfig } from './RoleMatrix';
import { TableSelector } from './TableSelector';
import { useReadResult } from './useAsync';

// The module registry of the app shell (issue #265). A feature registers a module here (or passes its own list to `App`); it never edits
// `App.tsx`. `App` renders the navigation from the list and keeps a `keepAlive` module mounted (hidden) after its first visit, so the
// selected table, filters and expanded rows survive switching between modules.

export interface ModuleContext {
  readonly reader: SecurityDataReader;
  readonly host?: HostWindow;
  readonly dataSource: DataSource;
  readonly connection: ConnectionState | null;
  /** The approved writer; null or absent when nothing may be written (demo mode, or a host without the Dataverse API). */
  readonly writer?: SecurityDataWriter | null;
  /** The environment edits are confirmed for (the write boundary compares it with the approved environment). */
  readonly environmentId?: string;
  /** Other verified identifiers of the same environment (its environment id and organization id); history recorded under either is restorable. */
  readonly environmentAliases?: readonly string[];
  /** Opens another screen by module id (a result links to Operations & History). */
  readonly openModule?: (id: string) => void;
}

export interface AppModule {
  readonly id: string;
  readonly label: string;
  readonly render: (context: ModuleContext) => ReactNode;
  /** Keep the module mounted (hidden) once visited, preserving its state. Off for placeholders. */
  readonly keepAlive?: boolean;
}

/** The table-first Role Analyzer: table selector, role matrix, expansion. Its selection state lives here, not in the shell. */
export function RoleAnalyzerModule({ reader, editing }: { readonly reader: SecurityDataReader; readonly editing?: EditingConfig }) {
  const [selected, setSelected] = useState<TableInfo | null>(null);
  const tables = useReadResult(() => reader.listTables(), 'tables');
  const matrix = useReadResult<RoleMatrixData>(selected ? () => reader.loadRoleMatrix(selected.logicalName) : null, selected?.logicalName ?? '');
  return (
    <>
      <TableSelector state={tables.state} selected={selected} onSelect={setSelected} onRetry={tables.retry} />
      {selected && (
        <p className="selected-table" aria-live="polite">
          Selected table: <strong>{selected.displayName}</strong> <code>{selected.logicalName}</code>
        </p>
      )}
      <RoleMatrix state={matrix.state} reader={reader} onRetry={matrix.retry} tableKey={selected?.logicalName ?? ''} {...(editing ? { editing } : {})} />
    </>
  );
}

/** Placeholder for a module that is planned and not built yet; says so plainly. */
export function plannedModule(id: string, label: string, planned: string): AppModule {
  return {
    id,
    label,
    render: () => (
      <section className="stub" aria-label={label}>
        <h2>{label}</h2>
        <p>Planned, not implemented in this milestone. {planned}</p>
      </section>
    ),
  };
}

/** Operations and History with restore: restore is offered only where a write is allowed (an approved writer and a confirmed environment). */
function OperationsScreen({ reader, host, dataSource, connection, writer, environmentId, environmentAliases }: ModuleContext) {
  const store = useMemo(() => getOperationStore(host), [host]);
  const restore = useMemo<RestoreWiring | null>(() => {
    if (!writer || !environmentId) return null;
    const access = dataSource === 'live' ? createPptbAccessReader(host) : new FixtureAccessReader({ latencyMs: 0 });
    const connections = host?.toolboxAPI?.connections;
    return {
      readers: restoreReaders(reader, access),
      writer,
      environmentId,
      ...(environmentAliases ? { environmentAliases } : {}),
      environmentLabel: connection?.kind === 'host' ? `${connection.name} (${connection.url})` : 'the connected environment',
      actor: 'Tool user (confirmed in the PPTB UI)',
      ...(dataSource === 'live' && connections ? { readFingerprint: () => connectionFingerprint(connections) } : {}),
    };
  }, [reader, host, dataSource, connection, writer, environmentId, environmentAliases]);
  return <OperationsModule store={store} restore={restore} />;
}

export const DEFAULT_MODULES: readonly AppModule[] = [
  {
    id: 'analyzer',
    label: 'Role Analyzer',
    keepAlive: true,
    render: ({ reader, writer, environmentId, connection }) => (
      <RoleAnalyzerModule
        reader={reader}
        {...(writer && environmentId
          ? {
              editing: {
                writer,
                actor: 'Tool user (confirmed in the PPTB UI)',
                environmentId,
                environmentLabel: connection?.kind === 'host' ? `${connection.name} (${connection.url})` : 'the connected environment',
              },
            }
          : {})}
      />
    ),
  },
  { id: 'explorer', label: 'Access Explorer', keepAlive: true, render: ({ host, dataSource, writer, environmentId, connection }) => (
      <AccessExplorerModule
        {...(host ? { host } : {})}
        dataSource={dataSource}
        {...(writer && environmentId ? { writer, environmentId, environmentLabel: connection?.kind === 'host' ? `${connection.name} (${connection.url})` : 'the connected environment' } : {})}
      />
    ),
  },
  { id: 'bu', label: 'BU Manager', keepAlive: true, render: ({ host, dataSource, connection, writer, environmentId, openModule }) => <BuManagerModule {...(host ? { host } : {})} dataSource={dataSource} connection={connection} {...(writer ? { writer } : {})} {...(environmentId ? { environmentId } : {})} {...(openModule ? { openModule } : {})} /> },
  { id: 'operations', label: 'Operations', keepAlive: true, render: (context) => <OperationsScreen {...context} /> },
];
