import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MemoryOperationStore } from '../../application/operations/memoryOperationStore';
import type { RestoreReaders } from '../../application/operations/restore';
import { stateChecksum } from '../../domain/history/state';
import type { OperationRecord, RoleHeldState, StepRecord } from '../../domain/history/types';
import { plannedWrite, type OperationResult } from '../../domain/operations';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { OperationRecorder } from '../../application/operations/recorder';
import { flakyStore } from '../../test/ledger';
import { OperationsModule } from './OperationsModule';
import { OperationRecorderContext } from './RecorderContext';
import type { RestoreWiring } from './useRestore';

// The restore flow of the Operations screen against an in-memory Dataverse (synthetic only; no host involved).

const ENV = '00000000-0000-4000-8000-000000000002';
const ROLE = '11111111-1111-1111-1111-111111111111';
const USER = '33333333-3333-3333-3333-333333333333';
const BU = '50000000-0000-0000-0000-000000000000';
const T = Date.UTC(2026, 10, 3, 19, 40, 12);

const held = (value: boolean): RoleHeldState => ({ kind: 'roleHeld', userId: USER, roleId: ROLE, held: value });

/** A verified, recorded role assignment (not held -> held): restoring it removes the role again. */
function assignmentRecord(id: string): OperationRecord {
  const key = plannedWrite.assignRole(USER, ROLE, '').key;
  const before = held(false);
  const after = held(true);
  const step: StepRecord = { index: 0, key, kind: 'assignRole', description: 'Assign role', outcome: 'succeeded', verified: true, failure: 'none', message: 'Confirmed.', before, after, stateChecksum: stateChecksum(key, before, after), stateIntegrity: 'ok' };
  return { schemaVersion: 2, operationId: id, correlationId: `c-${id}`, environmentId: ENV, actor: 'Owner', planHash: 'h', source: 'user', startedAtMs: T, endedAtMs: T + 100, steps: [step] };
}

function world(startHolding = true) {
  const roles = new Set<string>(startHolding ? [ROLE] : []);
  const log: string[] = [];
  const accepted: OperationResult = { outcome: 'notVerified', message: 'accepted', failure: 'none' };
  const writer = {
    unassignRole: async (_a: unknown, user: string, role: string) => { log.push(`unassign:${user}:${role}`); roles.delete(role); return accepted; },
    assignRole: async () => accepted,
    addPrivilege: async () => accepted,
    removePrivilege: async () => accepted,
    moveUser: async () => accepted,
  } as unknown as SecurityDataWriter;
  const readers: RestoreReaders = {
    rolePrivileges: async () => null,
    userState: async () => ({ businessUnitId: BU, directRoleIds: [...roles], rolesComplete: true }),
  };
  return { roles, log, writer, readers };
}

const wiringOf = (w: ReturnType<typeof world>, extra: Partial<RestoreWiring> = {}): RestoreWiring => ({
  readers: w.readers, writer: w.writer, environmentId: ENV, environmentLabel: 'Dev (https://dev.example)', actor: 'Owner', ...extra,
});

async function open(restore: RestoreWiring | null, recorder: OperationRecorder | null = null) {
  const store = new MemoryOperationStore();
  await store.put(assignmentRecord('op-1'));
  const user = userEvent.setup();
  render(<OperationRecorderContext.Provider value={recorder}><OperationsModule store={store} now={() => T + 60_000} restore={restore} /></OperationRecorderContext.Provider>);
  await screen.findByRole('table', { name: /Recorded operations/ });
  return user;
}

const startButton = () => screen.getByRole('button', { name: /Preview restore of selected operations/ }) as HTMLButtonElement;

describe('restore on the Operations screen', () => {
  it('previews, asks for an explicit confirmation of the exact writes, restores and shows the verified result', async () => {
    const w = world();
    const user = await open(wiringOf(w));
    expect(startButton().disabled).toBe(true); // nothing is selected yet
    expect(document.body.textContent).toMatch(/Select one or more operations first/);

    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    expect(preview.textContent).toMatch(/1 of 1 selected operation can be restored, with 1 change to send/);
    expect(within(preview).getByText('Will be restored')).toBeTruthy();
    expect(w.log).toEqual([]); // a preview reads only

    await user.click(within(preview).getByRole('button', { name: 'Continue to confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm the restore' });
    expect(dialog.textContent).toMatch(/Dev \(https:\/\/dev\.example\)/);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })); // Cancel has the initial focus
    const confirm = within(dialog).getByRole('button', { name: 'Confirm and restore' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // not without the acknowledgement
    await user.click(within(dialog).getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    expect(w.log).toEqual([]); // still nothing sent

    await user.click(confirm);
    const result = await screen.findByRole('region', { name: 'Restore result' });
    expect(result.textContent).toMatch(/Restored and verified: 1 of 1 target read back in the earlier state/);
    expect(w.log).toEqual([`unassign:${USER}:${ROLE}`]);
    expect(w.roles.has(ROLE)).toBe(false);
  });

  it('names the role and the user (read for the preview) instead of showing ids, in the preview and in the confirmation, and explains how the restore is kept safe', async () => {
    const w = world();
    const names = new Map([[ROLE, 'demo-play-auditor'], [USER, 'Alex Lahdenperä']]);
    w.readers = { ...w.readers, names: async () => ({ users: new Map([[USER, names.get(USER)!]]), roles: new Map([[ROLE, names.get(ROLE)!]]) }) };
    const user = await open(wiringOf(w));
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    await waitFor(() => expect(preview.textContent).toContain('“demo-play-auditor”'));
    expect(preview.textContent).toContain('“Alex Lahdenperä”');
    expect(preview.textContent).not.toContain(USER.slice(0, 8));
    await user.click(within(preview).getByRole('button', { name: 'Continue to confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm the restore' });
    const steps = within(dialog).getByRole('list', { name: 'Changes in the order they are applied' });
    expect(within(steps).getByText('Remove role')).toBeTruthy(); // what the step does, as a labelled chip
    expect(steps.textContent).toContain('“demo-play-auditor”');
    expect(steps.textContent).toContain('“Alex Lahdenperä”');
    expect(steps.textContent).not.toContain(ROLE); // no raw ids once the names are known
    const safety = within(dialog).getByRole('list', { name: 'How a restore is kept safe' });
    expect(safety.textContent).toMatch(/every target is read again: if anything changed since this preview, nothing is sent/);
    expect(safety.textContent).toMatch(/There is no automatic rollback/);
  });

  it('shows the shortened ids when the names cannot be read, and the preview and confirmation still work', async () => {
    const w = world();
    w.readers = { ...w.readers, names: async () => null };
    const user = await open(wiringOf(w));
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    expect(preview.textContent).toContain('Direct role 11111111 of user 33333333');
    await user.click(within(preview).getByRole('button', { name: 'Continue to confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm the restore' });
    expect(dialog.textContent).toContain(ROLE); // an id without a name stays complete inside the sentence
  });

  it('Cancel in the confirmation returns to the preview and sends nothing; Escape cancels too', async () => {
    const w = world();
    const user = await open(wiringOf(w));
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    await user.click(await screen.findByRole('button', { name: 'Continue to confirmation' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Restore preview' })).toBeTruthy();
    expect(w.log).toEqual([]);
  });

  it('says nothing can be restored when the target is no longer where the operation left it, and sends nothing', async () => {
    const w = world(false); // the role was already removed by someone else
    const user = await open(wiringOf(w));
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    const preview = await screen.findByRole('region', { name: 'Restore preview' });
    expect(within(preview).getByRole('button', { name: 'Continue to confirmation' }).hasAttribute('disabled')).toBe(true);
    expect(w.log).toEqual([]);
  });

  it('is not offered without write access (demo mode, or no approved writer) and says so', async () => {
    const user = await open(null);
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    expect(startButton().disabled).toBe(true);
    expect(document.body.textContent).toMatch(/Restore is available only while connected to a Dataverse environment with write access/);
  });

  it('a preview is discarded when the active connection changes, and a restore is never confirmed for another connection', async () => {
    const w = world();
    let fingerprint: string | null = 'dev|https://dev.example|1';
    const user = await open(wiringOf(w, { readFingerprint: async () => fingerprint }));
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    await screen.findByRole('region', { name: 'Restore preview' });
    fingerprint = 'prod|https://prod.example|1'; // the user switches environment in PPTB
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/connection changed, so the restore preview was discarded/));
    expect(screen.queryByRole('region', { name: 'Restore preview' })).toBeNull();
    expect(w.log).toEqual([]);
  });

  async function runRestore(w: ReturnType<typeof world>, recorder: OperationRecorder | null) {
    const user = await open(wiringOf(w), recorder);
    await user.click(screen.getByRole('checkbox', { name: 'Select operation op-1' }));
    await user.click(startButton());
    await user.click(await screen.findByRole('button', { name: 'Continue to confirmation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm the restore' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm and restore' }));
    return screen.findByRole('region', { name: 'Restore result' });
  }

  it('does not claim a history entry when the history could not be written (nothing was sent)', async () => {
    const w = world();
    const result = await runRestore(w, new OperationRecorder(flakyStore(0)));
    expect(w.log).toEqual([]);
    expect(result.textContent).toMatch(/Nothing was sent/);
    expect(result.textContent).toMatch(/no history entry exists/);
    expect(result.textContent).not.toMatch(/was recorded as its own operation/);
  });

  it('says so when the result of a restore that ran could not be saved to the history', async () => {
    const w = world();
    const result = await runRestore(w, new OperationRecorder(flakyStore(1))); // the intent is saved, the result is not
    expect(w.log).toHaveLength(1);
    expect(result.textContent).toMatch(/history entry could not be saved completely/);
    expect(result.textContent).not.toMatch(/was recorded as its own operation/);
  });

  it('a failed restore whose steps were sent does not say that nothing was restored', async () => {
    const w = world();
    w.writer.unassignRole = async () => ({ outcome: 'failed', message: 'denied', failure: 'permission' }) as OperationResult; // the write is refused
    const result = await runRestore(w, null);
    expect(result.textContent).toMatch(/No target was fully restored/);
    expect(result.textContent).toMatch(/some changes may already have been applied/);
    expect(result.textContent).not.toMatch(/Nothing was restored/);
  });
});
