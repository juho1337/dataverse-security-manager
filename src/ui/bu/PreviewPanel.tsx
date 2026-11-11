import type { PlannedMove, RoleOption } from '../../application/buManager/service';
import type { RoleDecision, UserMovePlan } from '../../domain/buMove/types';
import { DEPTH_LABEL } from '../labels';
import { BLOCK_TEXT, DECISION_TEXT, LEVEL_TEXT } from './labels';
import type { BuManager, UserRoleMode } from './useBuManager';

const depth = (d: keyof typeof DEPTH_LABEL | null): string => (d === null ? 'Not held' : DEPTH_LABEL[d]);

function DecisionRow({ user, d, manager, locked, roleOptions }: { readonly user: UserMovePlan; readonly d: RoleDecision; readonly manager: BuManager; readonly locked: boolean; readonly roleOptions: readonly RoleOption[] }) {
  const mine = manager.choices[user.user.id]?.find((c) => c.sourceRoleId === d.source.id);
  const needsPick = !locked && (d.outcome === 'blocked' || d.candidates.length > 1 || user.strategy === 'custom');
  const chosen = d.chosen;
  const showDiff = chosen !== null && (chosen.differences.length > 0 || chosen.escalation || chosen.reducedAccess);
  // The privileges could not be compared completely: the match is unverified and needs its own explicit acknowledgement, even when the rows
  // that WERE read show no difference (the checkbox below is otherwise the only way to confirm).
  const incompleteMatch = chosen !== null && !showDiff && (d.blockReason === 'privilegeDataIncomplete' || mine?.confirmed === true);
  // Custom strategy: the planner offers no candidates until a role is chosen, so the picker lists every role of the environment.
  // After a selection the planner returns only the selected role as a candidate, so the full list stays for every custom decision (a person can switch or clear).
  const customPick = !locked && (user.strategy === 'custom' || (d.candidates.length === 0 && d.blockReason === 'needsChoice'));
  return (
    <tr data-outcome={d.outcome}>
      <th scope="row">{d.source.name} <span className="hint">({d.sourceBusinessUnitName})</span></th>
      <td>
        <strong>{d.outcome === 'blocked' ? '⚠ ' : d.outcome === 'restore' ? '✔ ' : ''}{DECISION_TEXT[d.outcome]}</strong>
        {d.outcome === 'blocked' && d.blockReason !== 'none' && <div>{BLOCK_TEXT[d.blockReason]}</div>}
        {d.duplicateMapping && <div className="hint">Another role of this user maps to the same target role; it is assigned once.</div>}
      </td>
      <td>
        {customPick ? (
          <label>
            <span className="sr-only">Role to assign for {d.source.name}</span>
            <select
              value={mine?.chosenRoleId ?? ''}
              onChange={(e) => {
                if (e.target.value === '') manager.clearChoice(user.user.id, d.source.id);
                else manager.choose(user.user.id, d.source.id, e.target.value, false, false);
              }}
            >
              <option value="">Choose a role…</option>
              {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.businessUnitName})</option>)}
            </select>
          </label>
        ) : needsPick && d.candidates.length > 0 ? (
          <label>
            <span className="sr-only">Target role for {d.source.name}</span>
            <select
              value={mine?.chosenRoleId ?? chosen?.role.id ?? ''}
              onChange={(e) => {
                if (e.target.value !== '') manager.choose(user.user.id, d.source.id, e.target.value, false, false);
              }}
            >
              <option value="">Choose a role…</option>
              {d.candidates.map((c) => (
                <option key={c.role.id} value={c.role.id}>{c.role.name} ({c.businessUnitName}) · {LEVEL_TEXT[c.level]}</option>
              ))}
            </select>
          </label>
        ) : chosen ? (
          <span>{chosen.role.name} <span className="hint">({chosen.businessUnitName}, {LEVEL_TEXT[chosen.level]})</span></span>
        ) : (
          <span className="hint">None</span>
        )}
        {incompleteMatch && chosen && !locked && (
          <div className="bu-diff">
            <p><strong>⚠ Unverified match.</strong> The privileges of the roles could not be read completely, so it is not known whether {chosen.role.name} gives the same access as {d.source.name}.</p>
            <label>
              <input
                type="checkbox"
                checked={mine?.confirmed === true}
                onChange={(e) => manager.choose(user.user.id, d.source.id, chosen.role.id, e.target.checked, true)}
              />{' '}
              I accept this unverified match for {d.source.name}
            </label>
          </div>
        )}
        {showDiff && chosen && !locked && (
          <div className="bu-diff">
            <p>
              {chosen.escalation && <strong>⚠ Gives more access. </strong>}
              {chosen.reducedAccess && <strong>⚠ Gives less access. </strong>}
              Differences from the current role:
            </p>
            <table className="preview-table">
              <caption className="sr-only">Privilege differences for {d.source.name}</caption>
              <thead><tr><th scope="col">Table</th><th scope="col">Privilege</th><th scope="col">Now</th><th scope="col">Target role</th></tr></thead>
              <tbody>
                {chosen.differences.map((l) => (
                  <tr key={`${l.entity}:${l.operation}`}><td>{l.entity}</td><td>{l.operation}</td><td>{depth(l.sourceDepth)}</td><td>{depth(l.candidateDepth)}</td></tr>
                ))}
              </tbody>
            </table>
            <label>
              <input
                type="checkbox"
                checked={mine?.confirmed === true}
                onChange={(e) => manager.choose(user.user.id, d.source.id, chosen.role.id, e.target.checked, true)}
              />{' '}
              I accept these differences for {d.source.name}
            </label>
          </div>
        )}
      </td>
      <td>{d.explanation}</td>
    </tr>
  );
}

function UserPlan({ u, manager, targetName, locked, roleOptions, mapping }: { readonly u: UserMovePlan; readonly manager: BuManager; readonly targetName: string; readonly locked: boolean; readonly roleOptions: readonly RoleOption[]; readonly mapping: boolean }) {
  const mode: UserRoleMode = manager.userMode[u.user.id] ?? 'batch';
  return (
    <article className="bu-user" aria-label={`Plan for ${u.user.fullName}`}>
      <h4>{u.user.fullName} <span className="hint">{u.currentBusinessUnit ?? 'unknown business unit'} → {targetName}</span></h4>
      {!mapping && <p>{u.statusText}</p>}
      {!mapping && <p>{u.expectedOutcome}</p>}
      {mapping && u.status !== 'ready' && <p className="hint">{u.statusText}</p>}
      {!u.dataComplete && <p role="note" className="msg msg-warn">⚠ Some of this user's access could not be read completely, so this preview may be incomplete.</p>}
      {u.risks.length > 0 && (
        <ul aria-label={`Risks for ${u.user.fullName}`} className="bu-risks">
          {u.risks.map((r) => <li key={r}>⚠ {r}</li>)}
        </ul>
      )}
      {!locked && <label>
        Roles to restore for this user{' '}
        <select value={mode} onChange={(e) => manager.setUserMode(u.user.id, e.target.value as UserRoleMode)}>
          <option value="batch">Use the setting for everyone</option>
          <option value="none">None</option>
          <option value="allDirectRoles">All current direct roles</option>
        </select>
      </label>}
      {u.survival.length > 0 && !locked && (
        <table className="preview-table">
          <caption>Direct roles and what is expected to happen to them in the move</caption>
          <thead><tr><th scope="col">Role</th><th scope="col">Expectation</th><th scope="col">Basis</th></tr></thead>
          <tbody>
            {u.survival.map((s) => (
              <tr key={s.role.id}><th scope="row">{s.role.name} <span className="hint">({s.roleBusinessUnitName})</span></th><td>{s.kind}</td><td>{s.basis}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {u.decisions.length > 0 && (
        <table className="preview-table">
          <caption>Roles to restore after the move</caption>
          <thead><tr><th scope="col">Current role</th><th scope="col">Decision</th><th scope="col">Target role</th><th scope="col">Why</th></tr></thead>
          <tbody>
            {u.decisions.map((d) => <DecisionRow key={d.source.id} user={u} d={d} manager={manager} locked={locked} roleOptions={roleOptions} />)}
          </tbody>
        </table>
      )}
      {u.teamRoles.length > 0 && (
        <p className="hint">Roles this user gets through teams ({u.teamRoles.length}) are never converted to direct roles and are not changed here.</p>
      )}
      {!mapping && u.defaultTeamBefore && u.defaultTeamAfter && (
        <p className="hint">
          Default team roles: {u.defaultTeamBefore.roles.map((r) => r.name).join(', ') || 'none'} ({u.defaultTeamBefore.businessUnitName}) → {u.defaultTeamAfter.roles.map((r) => r.name).join(', ') || 'none'} ({u.defaultTeamAfter.businessUnitName}).
          {(u.defaultTeamBefore.unresolvedRoleIds.length > 0 || u.defaultTeamAfter.unresolvedRoleIds.length > 0) && ' Some default team roles could not be resolved: access through them is unknown, not none.'}
        </p>
      )}
      {!mapping && <details>
        <summary>What this preview cannot verify</summary>
        <ul>{u.cannotVerifyBeforeMove.map((c) => <li key={c}>{c}</li>)}</ul>
      </details>}
    </article>
  );
}

/** The dry-run preview: per user the expected effects, the roles to restore, risks and warnings. Nothing here writes. */
export function PreviewPanel({ planned, manager, targetName, canExecute, demo, mapping = false }: { readonly planned: PlannedMove; readonly manager: BuManager; readonly targetName: string; readonly canExecute: boolean; readonly demo: boolean; /** Wizard step 3: only the role mapping (decisions and overrides); the wizard footer carries the navigation. */ readonly mapping?: boolean }) {
  const { plan, writes } = planned;
  const writeCount = writes.plan?.writes.length ?? 0;
  return (
    <section className="bu-panel" aria-label={mapping ? 'Role mapping' : 'Preview'}>
      {mapping ? <h3>Role mapping</h3> : <h3>{planned.only ? 'Preview of the retry (dry run)' : 'Preview (dry run)'}</h3>}
      {!mapping && <p className="hint">Nothing has been changed. This shows what confirming would send to <strong>{targetName}</strong>.</p>}
      {[...plan.warnings, ...planned.notes].map((w) => <p key={w} role="note" className="msg msg-warn">⚠ {w}</p>)}
      {plan.users.map((u) => <UserPlan key={u.user.id} u={u} manager={manager} targetName={plan.targetBusinessUnitName} locked={planned.only !== undefined} roleOptions={planned.roleOptions} mapping={mapping} />)}
      {!mapping && writes.excluded.length > 0 && (
        <div role="note" className="msg msg-warn">
          <strong>Not part of this move:</strong>
          <ul>{writes.excluded.map((x) => <li key={x.userId}>{x.name}: {x.reason}</li>)}</ul>
        </div>
      )}
      {!mapping && (
        <>
        <div className="bu-actions">
          <button type="button" onClick={() => manager.backToCompose()}>Back</button>
          <button type="button" className="primary" onClick={() => manager.openConfirm()} disabled={!canExecute || writeCount === 0}>
            Review and confirm ({writeCount} change{writeCount === 1 ? '' : 's'})
          </button>
        </div>
        {demo && <p className="hint">Demo data: executing is not available. Nothing is read from or written to an environment.</p>}
        {!demo && !canExecute && <p className="hint">Executing is not available: this host does not provide the approved write path.</p>}
        {writeCount === 0 && <p className="hint">There is nothing to send: every user is excluded or blocked.</p>}
        </>
      )}
    </section>
  );
}
