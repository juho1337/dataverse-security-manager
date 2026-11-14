import { useEffect, useId, useMemo, useState } from 'react';
import { confirmAndApplyBulk, planBulkAssignments, summarizeApplied, type BulkApplied, type BulkPlan } from '../../../application/assignments/bulk';
import type { Role, UserAccess } from '../../../domain/buMove/types';
import { normalizeId } from '../../../domain/operations';
import type { AccessReader, AssignmentContext, UserHit } from '../../../ports/accessReader';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { Icon } from '../../Icon';
import { useOperationRecorder } from '../../operations/RecorderContext';
import { useReadResult } from '../../useAsync';

// Assign the same roles of ONE target Business Unit to several users. Choosing writes nothing; the preview lists every user, role and target
// unit, and only "Confirm and apply" sends. Each user is approved, applied and verified on its own (application/assignments/bulk.ts).

interface Props {
  readonly reader: AccessReader;
  readonly writer: SecurityDataWriter;
  readonly actor: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}

type Step =
  | { readonly kind: 'choose' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'preview'; readonly plan: BulkPlan }
  | { readonly kind: 'applying'; readonly plan: BulkPlan }
  | { readonly kind: 'done'; readonly plan: BulkPlan; readonly applied: BulkApplied };

const STATUS_TEXT = { planned: 'Will be assigned', alreadyAssigned: 'Already assigned', notAssigned: 'Not assigned', refused: 'Not sent' } as const;

export function BulkAssign({ reader, writer, actor, environmentId, environmentLabel, onClose }: Props) {
  const recorder = useOperationRecorder();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [message, setMessage] = useState<string | null>(null);
  const [users, setUsers] = useState<readonly UserHit[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [hits, setHits] = useState<readonly UserHit[]>([]);
  const [buId, setBuId] = useState<string>('');
  const [buQuery, setBuQuery] = useState('');
  const [roleQuery, setRoleQuery] = useState('');
  const [roleIds, setRoleIds] = useState<ReadonlySet<string>>(new Set());
  const ids = { user: useId(), bu: useId(), role: useId() };

  const context = useReadResult<AssignmentContext>(reader.loadAssignmentContext ? () => (reader.loadAssignmentContext as NonNullable<AccessReader['loadAssignmentContext']>)() : null, 'bulkctx');
  const ctx = context.state.phase === 'done' && context.state.result.status !== 'error' ? context.state.result.data : null;
  const roles = useReadResult<readonly Role[]>(buId && reader.listRolesOfBusinessUnit ? () => (reader.listRolesOfBusinessUnit as NonNullable<AccessReader['listRolesOfBusinessUnit']>)(buId) : null, `bulkroles:${buId}`);
  const catalog = roles.state.phase === 'done' && roles.state.result.status !== 'error' ? roles.state.result.data : null;

  useEffect(() => {
    const q = userQuery.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      void reader.searchUsers(q).then((r) => {
        if (live) setHits(r.status === 'error' ? [] : r.data);
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [userQuery, reader]);

  const units = useMemo(() => {
    const q = buQuery.trim().toLowerCase();
    return [...(ctx?.businessUnits ?? [])].filter((b) => !b.isDisabled && (q === '' || b.name.toLowerCase().includes(q) || b.id === buId)).sort((a, b) => a.name.localeCompare(b.name));
  }, [ctx, buQuery, buId]);
  const shownRoles = useMemo(() => {
    const q = roleQuery.trim().toLowerCase();
    return [...(catalog ?? [])].filter((r) => q === '' || r.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  }, [catalog, roleQuery]);
  const targetName = ctx?.businessUnits.find((b) => b.id === buId)?.name ?? '';
  const busy = step.kind === 'loading' || step.kind === 'applying';

  const chooseUnit = (id: string) => {
    setBuId(id);
    setRoleIds(new Set());
  };
  const toggleRole = (id: string) =>
    setRoleIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const addUser = (h: UserHit) => setUsers((prev) => (prev.some((u) => normalizeId(u.user.id) === normalizeId(h.user.id)) ? prev : [...prev, h]));

  const preview = async () => {
    if (!ctx || !catalog) return;
    setMessage(null);
    setStep({ kind: 'loading' });
    const accesses: UserAccess[] = [];
    for (const u of users) {
      const r = await reader.loadUserAccess(u.user.id);
      if (r.status === 'error') {
        setMessage(`The roles of ${u.user.fullName} could not be read: ${r.message}. Nothing was changed.`);
        setStep({ kind: 'choose' });
        return;
      }
      accesses.push(r.data);
    }
    setStep({ kind: 'preview', plan: planBulkAssignments({ accesses, catalog, businessUnits: ctx.businessUnits, crossBuAssignment: ctx.crossBuAssignment, roleIds: [...roleIds] }) });
  };

  const confirm = async (plan: BulkPlan) => {
    setStep({ kind: 'applying', plan });
    try {
      setStep({ kind: 'done', plan, applied: await confirmAndApplyBulk({ plan, writer, reader, actor, environmentId, ...(recorder ? { recorder } : {}) }) });
    } catch {
      setMessage('The change ended with an unexpected error. What was applied is not known: read each user’s roles again before trying anything else.');
      setStep({ kind: 'choose' });
    }
  };

  return (
    <section className="access-section bulk-assign" aria-label="Assign roles to several users">
      <div className="role-picker-head">
        <h3><span className="rp-head-icon" aria-hidden="true"><Icon name="roles" /></span>Assign roles to several users</h3>
        <button type="button" onClick={onClose} disabled={busy}>Close</button>
      </div>
      {message && <p role="alert" className="msg msg-warn">{message}</p>}

      {(step.kind === 'choose' || step.kind === 'loading') && (
        <>
          <p className="access-hint">Choose the users, then the business unit and the roles of that unit. Each role below is the copy that belongs to the chosen unit. Nothing is saved until you preview and confirm. To use another unit afterwards, run this again.</p>
          <div className="role-picker-search">
            <label htmlFor={ids.user}>Search users</label>
            <span className="search-field"><Icon name="access" /><input id={ids.user} type="search" autoComplete="off" placeholder="Type at least 2 letters of a name or email" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} /></span>
          </div>
          {hits.length > 0 && (
            <ul aria-label="User search results" className="bulk-hits">
              {hits.map((h) => (
                <li key={h.user.id}>
                  <button type="button" onClick={() => addUser(h)} disabled={users.some((u) => normalizeId(u.user.id) === normalizeId(h.user.id))}>Add {h.user.fullName}</button>
                  <span className="access-result-meta"> {h.businessUnitName ?? 'unknown business unit'}{h.user.isDisabled ? ' · disabled' : ''}</span>
                </li>
              ))}
            </ul>
          )}
          <ul aria-label="Chosen users" className="bulk-users">
            {users.length === 0 && <li className="access-hint">No users chosen yet.</li>}
            {users.map((u) => (
              <li key={u.user.id}>
                <strong>{u.user.fullName}</strong> <span className="access-result-meta">home: {u.businessUnitName ?? 'unknown'}</span>{' '}
                <button type="button" aria-label={`Remove ${u.user.fullName}`} onClick={() => setUsers((p) => p.filter((x) => x !== u))}>Remove</button>
              </li>
            ))}
          </ul>
          {context.state.phase === 'done' && context.state.result.status === 'error' && (
            <div className="access-error" role="alert">
              <p>The business units and the assignment setting could not be loaded: {context.state.result.message} Your chosen users are kept.</p>
              <button type="button" onClick={context.retry}>Retry</button>
            </div>
          )}
          {context.state.phase === 'done' && context.state.result.status === 'partial' && <p className="access-partial" role="note">Incomplete: {context.state.result.notes.join(' ')}</p>}
          {ctx && ctx.crossBuAssignment !== true && (
            <p className="access-hint">
              {ctx.crossBuAssignment === false ? 'Roles of other business units cannot be assigned here: record ownership across business units is turned off.' : 'Whether roles of other business units may be assigned could not be read.'} Users of other units are listed in the preview as not sent.
            </p>
          )}
          <div className="role-picker-search">
            <label htmlFor={ids.bu}>Search business units</label>
            <span className="search-field"><Icon name="access" /><input id={ids.bu} type="search" autoComplete="off" placeholder="Type part of a business unit name" value={buQuery} onChange={(e) => setBuQuery(e.target.value)} /></span>
            <select aria-label="Target business unit" value={buId} onChange={(e) => chooseUnit(e.target.value)}>
              <option value="">Choose a business unit…</option>
              {units.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          {buId && (
            <>
              <div className="role-picker-search">
                <label htmlFor={ids.role}>Search roles of {targetName}</label>
                <span className="search-field"><Icon name="access" /><input id={ids.role} type="search" autoComplete="off" placeholder="Type part of a role name" value={roleQuery} onChange={(e) => setRoleQuery(e.target.value)} /></span>
              </div>
              {roles.state.phase === 'loading' && <p role="status">Loading the roles of {targetName}...</p>}
              {roles.state.phase === 'done' && roles.state.result.status === 'error' && <div className="access-error" role="alert"><p>The roles could not be loaded: {roles.state.result.message}</p><button type="button" onClick={roles.retry}>Retry</button></div>}
              {catalog && (
                <div className="role-table-scroll">
                  <table className="role-table" aria-label={`Roles of ${targetName}`}>
                    <thead><tr><th scope="col" className="role-check"><span className="sr-only">Choose</span></th><th scope="col">Role</th><th scope="col">Business unit</th></tr></thead>
                    <tbody>
                      {shownRoles.map((r) => (
                        <tr key={r.id} data-state={roleIds.has(r.id) ? 'chosen' : 'free'}>
                          <td className="role-check"><input type="checkbox" aria-label={r.name} checked={roleIds.has(r.id)} onChange={() => toggleRole(r.id)} /></td>
                          <th scope="row"><span className="access-result-name">{r.name}</span></th>
                          <td>{targetName}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div className="assign-bar" role="group" aria-label="Bulk assignment actions">
            <span className="assign-summary">{users.length} user{users.length === 1 ? '' : 's'}, {roleIds.size} role{roleIds.size === 1 ? '' : 's'} chosen.</span>
            <button type="button" className="primary" disabled={busy || users.length === 0 || roleIds.size === 0 || !ctx || !catalog} onClick={() => void preview()}>Preview changes</button>
          </div>
        </>
      )}

      {step.kind === 'preview' && (
        <>
          <p className="rd-lead">These changes will be sent to <strong className="rd-chip">{environmentLabel}</strong>, one user at a time.</p>
          <table className="preview-table">
            <caption className="sr-only">Role assignments by user, role and business unit</caption>
            <thead><tr><th scope="col">User</th><th scope="col">Home business unit</th><th scope="col">Role</th><th scope="col">Role’s business unit</th><th scope="col">Result</th></tr></thead>
            <tbody>
              {step.plan.rows.map((r) => (
                <tr key={`${r.userId}|${r.item.roleId}`} data-status={r.item.status}>
                  <th scope="row">{r.userName}</th>
                  <td>{r.homeBusinessUnitName}</td>
                  <td><strong>{r.item.roleName}</strong></td>
                  <td>{r.item.businessUnitName}</td>
                  <td><strong>{STATUS_TEXT[r.item.status]}.</strong> {r.item.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {step.plan.warnings.map((w) => <p key={w} className="msg msg-warn" role="note">{w}</p>)}
          <p className="hint">After applying, each user’s roles are read again and every change is checked against what Dataverse then holds. There is no automatic undo.</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setStep({ kind: 'choose' })}>Back</button>
            <button type="button" className="primary" disabled={step.plan.writeCount === 0} onClick={() => void confirm(step.plan)}>Confirm and apply</button>
          </div>
          {step.plan.writeCount === 0 && <p className="access-hint">Nothing would be changed.</p>}
        </>
      )}

      {step.kind === 'applying' && <p role="status" className="hint assign-applying"><span className="spin-icon" aria-hidden="true"><Icon name="spinner" /></span>Applying role changes… Do not close this window.</p>}

      {step.kind === 'done' && (
        <>
          <p role={step.applied.allVerified ? 'status' : 'alert'} className={`msg assign-banner ${step.applied.allVerified ? 'msg-ok' : 'msg-warn'}`}>
            <strong>{step.applied.allVerified ? 'All changes verified.' : 'Not everything was verified.'}</strong>{' '}
            {step.applied.allVerified
              ? `Every assignment that was sent was read back and confirmed.${step.applied.outcomes.some((o) => o.plan.items.some((i) => i.status === 'refused')) ? ' Some users or roles were not sent; see the table.' : ''}`
              : 'Check the table; users after the first problem were not attempted.'}
          </p>
          <table className="preview-table">
            <caption className="sr-only">Result for each user</caption>
            <thead><tr><th scope="col">User</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {step.applied.outcomes.map((o) => (
                <tr key={o.plan.userId}>
                  <th scope="row">{o.plan.userName}</th>
                  <td>{o.kind === 'applied' ? { verified: 'Verified', alreadyInPlace: 'Already in place', notVerified: 'Not verified' }[summarizeApplied(o.applied.result).status] : o.kind === 'nothingToWrite' ? (o.plan.items.some((i) => i.status === 'refused') ? 'Not sent' : 'Nothing to change') : o.kind === 'notAttempted' ? 'Not attempted' : 'Unknown'}</td>
                  <td>{o.kind === 'applied' ? [...summarizeApplied(o.applied.result).problems, ...o.applied.result.items.filter((i) => i.noChange !== true).map((i) => `${i.item.roleName} (${i.item.businessUnitName}): ${i.message}`)].join(' ') : o.plan.items.map((i) => `${i.roleName} (${i.businessUnitName}): ${i.reason}`).join(' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="primary" onClick={onClose}>Close</button>
        </>
      )}
    </section>
  );
}
