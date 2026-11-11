import { describeTotal, type UsersTotal } from '../application/roleDetails';
import { formatCount } from '../domain/access';
import { Icon } from './Icon';
import { BULK_LIMIT } from './useRoleDetails';

interface Props {
  readonly total: UsersTotal;
  /** Reads the users of every listed role (unread roles first; when all were read, again). */
  readonly onLoad: () => void;
}

const plural = (n: number, complete: boolean, one: string, many: string): string => (n === 1 && complete ? one : many);

/**
 * The right-hand side of the table title: who holds the listed roles, and the one button that reads it.
 *   - nothing read yet: a plain invitation and a prominent "Load users";
 *   - reading: progress (a bar and "Reading users… 4 of 12"), the button busy and disabled;
 *   - read: the total as chips (people first, then the split) and a quieter "Refresh users".
 * The chips are visual; one sentence with the same numbers (the "Total: …" text) is what a screen reader hears. A partial or lower-bound
 * total says so in the chips ("≥") exactly as the sentence does.
 */
export function UsersToolbar({ total, onLoad }: Props) {
  const { counts: c, complete } = total;
  const busy = total.loading > 0;
  const allRead = total.roles > 0 && total.loaded === total.roles && !busy;
  const done = total.loaded + total.failed;
  const num = (n: number) => formatCount(n, complete).text;

  return (
    <div className="users-bar">
      {busy ? (
        <span className="users-progress-box" role="status" aria-live="polite">
          <progress className="users-progress" max={total.roles} value={done} aria-label="Roles whose users were read" />
          <span>Reading users… {done} of {total.roles}</span>
        </span>
      ) : total.loaded === 0 ? (
        <span className="users-hint" role="status" aria-live="polite">{describeTotal(total) || 'No roles listed'}</span>
      ) : (
        <>
          <span className="users-summary" aria-hidden="true">
            <span className="user-chip user-chip-main"><strong>{num(c.uniqueUsers)}</strong> unique {plural(c.uniqueUsers, complete, 'user', 'users')}</span>
            <span className="user-chip"><strong>{num(c.directUsers)}</strong> direct</span>
            <span className="user-chip">
              <strong>{num(c.teams)}</strong> {plural(c.teams, complete, 'team', 'teams')}
              <span className="user-chip-sub">({num(c.usersViaTeams)} {plural(c.usersViaTeams, complete, 'user', 'users')})</span>
            </span>
            <span className="user-chip user-chip-muted"><strong>{num(c.excludedApplication)}</strong> application {plural(c.excludedApplication, complete, 'user', 'users')}</span>
            {!allRead && <span className="user-chip user-chip-note">{total.loaded} of {total.roles} roles read</span>}
            {total.roles > BULK_LIMIT && <span className="user-chip user-chip-note" title="A long list is read in parts: each click continues where the previous one stopped, and wraps around.">{BULK_LIMIT} roles per click</span>}
            {total.failed > 0 && <span className="user-chip user-chip-warn">{total.failed} failed</span>}
          </span>
          <span className="sr-only" role="status" aria-live="polite">{describeTotal(total)}</span>
        </>
      )}
      <button
        type="button"
        className={`users-button${allRead ? '' : ' primary'}${busy ? ' is-busy' : ''}`}
        onClick={onLoad}
        disabled={busy || total.roles === 0}
        title={
          allRead
            ? 'Read the users of the listed roles again from Dataverse (direct users, teams and their members).'
            : 'Read who holds each listed role (direct users, teams and their members), a few at a time, at most 150 roles per click. You can still open a single role to see its users.'
        }
      >
        <Icon name={busy ? 'spinner' : allRead ? 'refresh' : 'roles'} />
        {busy ? 'Reading…' : allRead ? 'Refresh users' : 'Load users'}
      </button>
    </div>
  );
}
