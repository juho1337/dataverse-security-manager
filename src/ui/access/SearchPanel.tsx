import { useId, useState, useSyncExternalStore } from 'react';
import type { AccessSearchController } from '../../application/access/searchController';
import { narrowByBusinessUnit } from '../../application/access/narrow';
import { statusLabel } from '../../application/access/userAccessView';
import type { ReadResult, TeamSummary, UserHit } from '../../ports/accessReader';

export interface Selection {
  readonly kind: 'user' | 'team';
  readonly id: string;
}

interface Props {
  readonly controller: AccessSearchController;
  readonly selected: Selection | null;
  readonly onSelect: (s: Selection) => void;
}

function Notes({ result }: { readonly result: ReadResult<unknown> }) {
  if (result.status !== 'partial') return null;
  return (
    <p className="access-partial" role="note">
      Incomplete: {result.notes.join(' ')}
    </p>
  );
}

function Failure({ result, label, onRetry }: { readonly result: ReadResult<unknown>; readonly label: string; readonly onRetry: () => void }) {
  if (result.status !== 'error') return null;
  return (
    <div className="access-error" role="alert">
      <p>
        {label} search failed: {result.message}
      </p>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function UserRow({ hit, selected, onSelect }: { readonly hit: UserHit; readonly selected: boolean; readonly onSelect: () => void }) {
  const status = statusLabel(hit.user);
  return (
    <li>
      <button type="button" className="access-result" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <span className="access-result-name">{hit.user.fullName}</span>
        <span className="access-badge" data-status={status}>{status === 'enabled' ? 'active' : status}</span>
        <span className="access-result-meta">
          {hit.user.email || 'no email'} &middot; {hit.businessUnitName ?? 'business unit not read'}
        </span>
      </button>
    </li>
  );
}

function TeamRow({ team, selected, onSelect }: { readonly team: TeamSummary; readonly selected: boolean; readonly onSelect: () => void }) {
  return (
    <li>
      <button type="button" className="access-result" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <span className="access-result-name">{team.name}</span>
        <span className="access-badge">{team.type === 'Default' ? 'default team' : `${team.type.toLowerCase()} team`}</span>
        <span className="access-result-meta">{team.businessUnitName ?? 'business unit not read'}</span>
      </button>
    </li>
  );
}

type Kind = 'all' | 'users' | 'teams';

/** Search box, an All/Users/Teams filter and the compact result lists. Results announce their count in a live region. */
export function SearchPanel({ controller, selected, onSelect }: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const inputId = useId();
  const [kind, setKind] = useState<Kind>('all');
  const [buText, setBuText] = useState('');
  const hintId = `${inputId}-hint`;
  const allUsers = state.users && state.users.status !== 'error' ? state.users.data : [];
  const allTeams = state.teams && state.teams.status !== 'error' ? state.teams.data : [];
  const narrowedUsers = narrowByBusinessUnit(allUsers, (h) => h.businessUnitName, buText);
  const narrowedTeams = narrowByBusinessUnit(allTeams, (t) => t.businessUnitName, buText);
  const users = narrowedUsers.shown;
  const teams = narrowedTeams.shown;
  const hiddenByBu = narrowedUsers.hidden + narrowedTeams.hidden;
  const unknownBu = narrowedUsers.unknownKept + narrowedTeams.unknownKept;

  let summary = '';
  if (state.phase === 'loading') summary = 'Searching...';
  else if (state.phase === 'done' && state.users && state.teams) {
    summary = `${users.length} user${users.length === 1 ? '' : 's'} and ${teams.length} team${teams.length === 1 ? '' : 's'} found.`;
  }

  return (
    <section className="access-search" aria-label="Search">
      <form role="search" onSubmit={(e) => { e.preventDefault(); controller.retry(); }}>
        <label htmlFor={inputId}>Search users and teams</label>
        <input
          id={inputId}
          type="search"
          autoComplete="off"
          aria-describedby={hintId}
          value={state.query}
          onChange={(e) => controller.setQuery(e.target.value)}
        />
        <p id={hintId} className="access-hint">
          Name or email for users, name for teams (at least 2 characters). Disabled and application users are labelled.
        </p>
      </form>
      <p className="access-live" role="status" aria-live="polite">{summary}</p>
      {state.tooShort && <p className="access-hint">Keep typing: at least 2 characters are needed.</p>}
      {state.phase === 'idle' && !state.tooShort && <p className="access-hint">Nothing searched yet.</p>}

      {state.phase === 'done' && state.users && state.teams && (
        <div className="access-results">
          <label htmlFor={`${inputId}-bu`}>Narrow by Business Unit</label>
          <input id={`${inputId}-bu`} type="search" autoComplete="off" value={buText} onChange={(e) => setBuText(e.target.value)} />
          {buText.trim() !== '' && (
            <p className="access-hint" role="status">
              Narrows the results below (at most 50 per kind), it does not search again: {hiddenByBu} hidden.{unknownBu > 0 ? ` ${unknownBu} kept because their Business Unit could not be read.` : ''}
            </p>
          )}
          <div role="group" aria-label="Show" className="access-filter">
            {(['all', 'users', 'teams'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {k === 'all' ? 'All' : k === 'users' ? `Users (${users.length})` : `Teams (${teams.length})`}
              </button>
            ))}
          </div>
          {kind !== 'teams' && <h3>Users</h3>}
          {kind !== 'teams' && <Failure result={state.users} label="User" onRetry={() => controller.retry()} />}
          {kind !== 'teams' && <Notes result={state.users} />}
          {kind !== 'teams' && state.users.status !== 'error' && users.length === 0 && <p className="access-hint">No users match this search.</p>}
          {kind !== 'teams' && <ul aria-label="User results">
            {users.map((h) => (
              <UserRow key={h.user.id} hit={h} selected={selected?.kind === 'user' && selected.id === h.user.id} onSelect={() => onSelect({ kind: 'user', id: h.user.id })} />
            ))}
          </ul>}
          {kind !== 'users' && <h3>Teams</h3>}
          {kind !== 'users' && <Failure result={state.teams} label="Team" onRetry={() => controller.retry()} />}
          {kind !== 'users' && <Notes result={state.teams} />}
          {kind !== 'users' && state.teams.status !== 'error' && teams.length === 0 && <p className="access-hint">No teams match this search.</p>}
          {kind !== 'users' && <ul aria-label="Team results">
            {teams.map((t) => (
              <TeamRow key={t.id} team={t} selected={selected?.kind === 'team' && selected.id === t.id} onSelect={() => onSelect({ kind: 'team', id: t.id })} />
            ))}
          </ul>}
        </div>
      )}
    </section>
  );
}
