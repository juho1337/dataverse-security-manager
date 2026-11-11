import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FixtureAccessReader } from '../../adapters/fixture/accessFixture';
import { createPptbAccessReader } from '../../adapters/pptb/accessReader';
import { AccessSearchController } from '../../application/access/searchController';
import type { AccessReader, TeamAccess, UserHit } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import type { UserAccess } from '../../domain/buMove/types';
import type { ModuleContext } from '../modules';
import { useReadResult } from '../useAsync';
import { AssignPreviewDialog, AssignResultPanel } from './assign/AssignDialogs';
import { useRoleAssignments } from './assign/useRoleAssignments';
import { SearchPanel, type Selection } from './SearchPanel';
import { TeamDetail } from './TeamDetail';
import { UserDetail } from './UserDetail';
import './access.css';

const NO_STATE = { subscribe: () => () => undefined, getState: () => null };

export interface AssignmentWiring {
  /** The approved writer; null or absent when nothing may be written (demo mode, or a host without the Dataverse API). */
  readonly writer?: SecurityDataWriter | null;
  /** The environment changes are confirmed for (the write boundary compares it with the approved environment). */
  readonly environmentId?: string;
  readonly environmentLabel?: string;
}

function Explorer({ reader, demo, debounceMs, wiring }: { readonly reader: AccessReader; readonly demo: boolean; readonly debounceMs?: number; readonly wiring?: AssignmentWiring }) {
  const [controller, setController] = useState<AccessSearchController | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);

  // Created in an effect (not during render) so that React StrictMode's mount/unmount/mount cycle never leaves a disposed controller.
  useEffect(() => {
    const c = new AccessSearchController(reader, debounceMs);
    setController(c);
    return () => c.dispose();
  }, [reader, debounceMs]);

  const searchState = useSyncExternalStore(controller?.subscribe ?? NO_STATE.subscribe, controller?.getState ?? NO_STATE.getState);
  const candidates: readonly UserHit[] = searchState?.users && searchState.users.status !== 'error' ? searchState.users.data : [];

  // Bumped when a refresh of the person has FINISHED: the table privileges are then read again from the refreshed access (a role's privileges can
  // change without the person's roles changing, and a role can move from direct to team-derived). Bumping at the start would read them from the old snapshot.
  const [epoch, setEpoch] = useState(0);
  const user = useReadResult<UserAccess>(selected?.kind === 'user' ? () => reader.loadUserAccess(selected.id) : null, `u:${selected?.id ?? ''}`);
  const team = useReadResult<TeamAccess>(selected?.kind === 'team' ? () => reader.loadTeamAccess(selected.id) : null, `t:${selected?.id ?? ''}`);

  // Role changes exist only with an approved writer for a known environment; demo data is never writable.
  const assignment = useRoleAssignments({
    reader,
    writer: !demo && wiring?.writer && wiring.environmentId ? wiring.writer : null,
    actor: 'Tool user (confirmed in the PPTB UI)',
    environmentId: wiring?.environmentId ?? '',
    onReload: user.retry,
  });
  const refreshUser = user.refresh;
  const refreshTeam = team.refresh;
  const refreshing = user.refreshing || team.refreshing;
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (wasRefreshing.current && !refreshing) setEpoch((e) => e + 1);
    wasRefreshing.current = refreshing;
  }, [refreshing]);
  const resetAssignment = assignment.reset;
  const selectedUserId = selected?.kind === 'user' ? selected.id : null;
  // A different user selected: requests staged for the previous user are dropped. The search and the selection themselves are untouched.
  useEffect(() => {
    resetAssignment();
  }, [selectedUserId, resetAssignment]);

  return (
    <section className="access-explorer" aria-label="Access Explorer">
      <h2>Access Explorer</h2>
      {demo && <p className="access-hint">Demo data: fictional users, teams and roles. Nothing is read from an environment.</p>}
      <p className="access-hint">Shows which roles a user holds, directly and through teams, and where each comes from.{assignment.available ? ' Direct role changes are previewed and confirmed before anything is written.' : ' Read-only in this session.'}</p>
      <div className="access-layout">
        {controller && <SearchPanel controller={controller} selected={selected} onSelect={setSelected} />}
        <div className="access-main" aria-live="polite">
          {!selected && <p className="access-hint">Select a user or team from the results.</p>}
          {selected?.kind === 'user' && <UserDetail state={user.state} reader={reader} candidates={candidates} onRetry={user.retry} onRefresh={refreshUser} refreshing={user.refreshing} refreshEpoch={epoch} assignment={assignment} />}
          {selected?.kind === 'team' && <TeamDetail reader={reader} state={team.state} onRetry={team.retry} onRefresh={refreshTeam} refreshing={team.refreshing} refreshEpoch={epoch} onSelect={setSelected} />}
        </div>
      </div>
      <AssignPreviewDialog assign={assignment} environmentLabel={wiring?.environmentLabel ?? 'the connected environment'} />
      <AssignResultPanel assign={assignment} />
    </section>
  );
}

/** The Access Explorer module (read side). Live inside a PPTB host, synthetic demo data otherwise; the two are never mixed. */
export function AccessExplorerModule({ host, dataSource, reader, debounceMs, ...wiring }: Partial<Pick<ModuleContext, 'host' | 'dataSource'>> & AssignmentWiring & { readonly reader?: AccessReader; readonly debounceMs?: number }) {
  const access = useMemo<AccessReader>(
    () => reader ?? (dataSource === 'live' ? createPptbAccessReader(host) : new FixtureAccessReader({ latencyMs: 150 })),
    [reader, dataSource, host],
  );
  return <Explorer reader={access} demo={!reader && dataSource !== 'live'} wiring={wiring} {...(debounceMs !== undefined ? { debounceMs } : {})} />;
}
