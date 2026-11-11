import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryOperationStore } from '../../application/operations/memoryOperationStore';
import { endOperation, beginOperation, markStepStarted, recordStepResult } from '../../domain/history/record';
import { approvePlan, createWritePlan, plannedWrite, refused } from '../../domain/operations';
import { downloadWithAnchor, type DownloadFile } from './download';
import { OperationsModule } from './OperationsModule';

const U = '22222222-2222-2222-2222-222222222222';
const R = '11111111-1111-1111-1111-111111111111';
const R2 = '44444444-4444-4444-4444-444444444444'; // a different role: two steps on one user+role would supersede each other

function op(id: string, startedAt: number, first: 'verified' | 'timeout') {
  const plan = createWritePlan([plannedWrite.assignRole(U, R, `Assign role for ${id}`), plannedWrite.unassignRole(U, R2, `Remove role for ${id}`)]);
  let o = beginOperation(approvePlan(plan, 'env-1', 'ann@contoso.test', 1, { operationId: id }), startedAt, { correlationId: `corr-${id}` });
  const [a, b] = o.steps.map((s) => s.key) as [string, string];
  o =
    first === 'verified'
      ? recordStepResult(o, a, { outcome: 'succeeded', message: 'Confirmed.', failure: 'none' }, startedAt + 1, { verified: true })
      : recordStepResult(o, a, { outcome: 'uncertain', message: 'Timed out.', failure: 'timeout' }, startedAt + 1);
  o = recordStepResult(o, b, refused('permission', 'No rights.'), startedAt + 2);
  return endOperation(o, startedAt + 3);
}

async function setup() {
  const store = new MemoryOperationStore();
  await store.put(op('old', Date.UTC(2026, 10, 1, 8), 'verified'));
  await store.put(op('new', Date.UTC(2026, 10, 2, 8), 'timeout'));
  const files: DownloadFile[] = [];
  const user = userEvent.setup();
  render(<OperationsModule store={store} now={() => Date.UTC(2026, 10, 2, 12)} download={(f) => files.push(f)} />);
  await screen.findByRole('table', { name: /Recorded operations/ });
  return { files, user };
}

describe('OperationsModule', () => {
  it('says the history is kept for this session only', async () => {
    await setup();
    expect(screen.getByRole('note').textContent).toMatch(/session only.*Export/i);
  });

  it('lists operations newest first with text statuses', async () => {
    await setup();
    const rows = within(screen.getByRole('table', { name: /Recorded operations/ })).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Show new');
    expect(rows[1]!.textContent).toContain('Show old');
    expect(rows[0]!.textContent).toContain('Uncertain');
    expect(rows[0]!.textContent).not.toContain('Succeeded');
    expect(rows[1]!.textContent).toContain('Partially applied');
  });

  it('shows steps, failure class, correlation id and unverified marks for one operation', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Show new' }));
    const steps = screen.getByRole('table', { name: /Steps of operation new/ });
    expect(within(steps).getByText('Assign role for new')).toBeTruthy();
    expect(within(steps).getByText(/Uncertain/)).toBeTruthy();
    expect(within(steps).getByText('timeout')).toBeTruthy();
    expect(within(steps).getByText('permission')).toBeTruthy();
    expect(within(steps).getAllByText('Not verified').length).toBe(2);
    expect(screen.getByText('corr-new')).toBeTruthy();
    expect(screen.getByText(/do not treat this as done/)).toBeTruthy();
  });

  it('lists safe retry candidates and the steps that must not be retried, with no rollback promise', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'Show new' }));
    const heading = screen.getByRole('heading', { name: 'Safe retry candidates' });
    const list = heading.nextElementSibling as HTMLElement;
    expect(within(list).getByText(/Assign role for new/)).toBeTruthy();
    expect(list.textContent).toContain('Read the object again first');
    expect(screen.getByRole('heading', { name: 'Not offered for retry' })).toBeTruthy();
    expect(screen.getAllByText(/no automatic rollback/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Retrying is not available yet/)).toBeTruthy();
  });

  it('exports the whole history and one operation as JSON and CSV', async () => {
    const { user, files } = await setup();
    await user.click(screen.getByRole('radio', { name: /Whole history/ }));
    await user.click(screen.getByRole('button', { name: 'Export as JSON' }));
    await user.click(screen.getByRole('button', { name: 'Export as CSV' }));
    await user.click(screen.getByRole('button', { name: 'Show old' }));
    await user.click(screen.getByRole('button', { name: 'Export this operation as CSV' }));
    await user.click(screen.getByRole('button', { name: 'Export this operation as JSON' }));
    expect(files.map((f) => f.mime)).toEqual(['application/json', 'text/csv', 'text/csv', 'application/json']);
    expect(files[0]!.filename).toBe('dsm-operation-history-20261102-120000.json');
    expect(JSON.parse(files[0]!.content).operations).toHaveLength(2);
    expect(files[1]!.content.split('\r\n')[0]).toContain('operationId');
    expect(files[2]!.content).toContain('old');
    expect(files[2]!.content).not.toContain('corr-new');
  });

  it('is keyboard operable', async () => {
    const { user } = await setup();
    const btn = screen.getByRole('button', { name: 'Show old' });
    btn.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: 'Operation old' })).toBeTruthy();
  });

  it('shows an operation left unfinished by an earlier session as uncertain with retry candidates', async () => {
    const store = new MemoryOperationStore();
    const plan = createWritePlan([plannedWrite.assignRole(U, R, 'Assign interrupted')]);
    const o = beginOperation(approvePlan(plan, 'env-1', 'ann', 1, { operationId: 'cut' }), 1000, { correlationId: 'c' });
    await store.put(markStepStarted(o, o.steps[0]!.key, 1001));
    const user = userEvent.setup();
    render(<OperationsModule store={store} />);
    await user.click(await screen.findByRole('button', { name: 'Show cut' }));
    expect(screen.queryByText(/Still running/)).toBeNull();
    expect(screen.getAllByText(/Uncertain/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Safe retry candidates' }).nextElementSibling?.textContent).toContain('Assign interrupted');
  });

  it('shows an empty state and disables export', async () => {
    render(<OperationsModule store={new MemoryOperationStore()} />);
    expect(await screen.findByText('No operations recorded yet.')).toBeTruthy();
    for (const name of ['Copy as text', 'Export as .txt', 'Export as JSON', 'Export as CSV']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText('Nothing to report yet: no operations are recorded.')).toBeTruthy();
  });

  it('reports an unreadable store', async () => {
    const store = new MemoryOperationStore();
    vi.spyOn(store, 'list').mockRejectedValue(new Error('x'));
    render(<OperationsModule store={store} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read/);
  });
});

describe('downloadWithAnchor', () => {
  it('uses a Blob and an anchor with the file name, then cleans up', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    downloadWithAnchor({ filename: 'f.csv', mime: 'text/csv', content: 'a' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
