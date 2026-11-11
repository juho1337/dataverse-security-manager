import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryOperationStore } from '../../application/operations/memoryOperationStore';
import { beginOperation, endOperation, recordStepResult } from '../../domain/history/record';
import { approvePlan, createWritePlan, plannedWrite, refused } from '../../domain/operations';
import type { OperationRecord } from '../../domain/history/types';
import { copyText, type ClipboardLike } from './clipboard';
import type { DownloadFile } from './download';
import { OperationsModule } from './OperationsModule';

const U = '22222222-2222-2222-2222-222222222222';
const R = '11111111-1111-1111-1111-111111111111';
const BU = '55555555-5555-5555-5555-555555555555';
const ENV = 'abcdef12-3333-3333-3333-333333333333';
const T = Date.UTC(2026, 10, 3, 19, 40, 12);

function begin(id: string, at: number, write = plannedWrite.assignRole(U, R, `Assign role for ${id}`)) {
  return beginOperation(approvePlan(createWritePlan([write]), ENV, 'Tool user (confirmed in the PPTB UI)', 1, { operationId: id }), at, { correlationId: `corr-${id}` });
}

const verified = (id: string, at: number): OperationRecord => {
  const o = begin(id, at);
  return endOperation(recordStepResult(o, o.steps[0]!.key, { outcome: 'succeeded', message: 'Confirmed.', failure: 'none' }, at + 1, { verified: true }), at + 2);
};
const failed = (id: string, at: number): OperationRecord => {
  const o = begin(id, at, plannedWrite.moveUser(U, BU, `Move user for ${id}`));
  return endOperation(recordStepResult(o, o.steps[0]!.key, refused('permission', 'No rights.'), at + 1), at + 2);
};
const uncertain = (id: string, at: number): OperationRecord => {
  const o = begin(id, at);
  return endOperation(recordStepResult(o, o.steps[0]!.key, { outcome: 'uncertain', message: 'Timed out.', failure: 'timeout' }, at + 1), at + 2);
};
const noWrite = (id: string, at: number): OperationRecord => {
  const o = begin(id, at);
  const s = recordStepResult(o, o.steps[0]!.key, refused('validation', 'Nothing was sent.'), at + 1);
  return endOperation({ ...s, steps: s.steps.map((x) => ({ ...x, outcome: 'skipped' as const })) }, at + 2);
};

async function setup(opts: { clipboard?: ClipboardLike | null } = {}) {
  const store = new MemoryOperationStore();
  await store.put(verified('ok', T));
  await store.put(failed('bad', T + 60_000));
  await store.put(uncertain('unc', T + 120_000));
  await store.put(noWrite('skip', T + 180_000));
  const files: DownloadFile[] = [];
  const user = userEvent.setup();
  const clipboard = opts.clipboard === undefined ? { writeText: vi.fn(async () => undefined) } : opts.clipboard;
  render(<OperationsModule store={store} now={() => Date.UTC(2026, 10, 3, 20, 0, 0)} download={(f) => files.push(f)} clipboard={clipboard} timeZone="Europe/Helsinki" />);
  await screen.findByRole('table', { name: /Recorded operations/ });
  return { store, files, user, clipboard };
}

const rowBox = (id: string) => screen.getByRole('checkbox', { name: `Select operation ${id}` }) as HTMLInputElement;
const headerBox = () => screen.getByRole('checkbox', { name: 'Select all visible operations' }) as HTMLInputElement;
const selectionText = () => screen.getByRole('status', { name: 'Selection' }).textContent;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('operation selection', () => {
  it('selects one operation, shows the count and keeps the others unselected', async () => {
    const { user } = await setup();
    expect(selectionText()).toBe('0 of 4 operations selected');
    await user.click(rowBox('bad'));
    expect(rowBox('bad').checked).toBe(true);
    expect(rowBox('ok').checked).toBe(false);
    expect(selectionText()).toBe('1 of 4 operations selected');
    await user.click(rowBox('bad'));
    expect(selectionText()).toBe('0 of 4 operations selected');
  });

  it('selects all visible with the header box and the button, and clears the selection', async () => {
    const { user } = await setup();
    await user.click(headerBox());
    expect(selectionText()).toBe('4 of 4 operations selected');
    expect(headerBox().checked).toBe(true);
    await user.click(headerBox());
    expect(selectionText()).toBe('0 of 4 operations selected');
    await user.click(button('Select all visible'));
    expect(selectionText()).toBe('4 of 4 operations selected');
    expect(button('Select all visible').disabled).toBe(true);
    await user.click(button('Clear selection'));
    expect(selectionText()).toBe('0 of 4 operations selected');
    expect(button('Clear selection').disabled).toBe(true);
  });

  it('select all visible respects the filter and the header box shows a mixed state', async () => {
    const { user } = await setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'failed');
    const rows = within(screen.getByRole('table', { name: /Recorded operations/ })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(selectionText()).toBe('0 of 4 operations selected (1 shown by the filter)');
    await user.click(headerBox());
    expect(selectionText()).toBe('1 of 4 operations selected (1 shown by the filter)');
    expect(headerBox().checked).toBe(true);
    expect(headerBox().indeterminate).toBe(false);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'all');
    expect(headerBox().checked).toBe(false);
    expect(headerBox().indeterminate).toBe(true);
    // with everything visible again, selecting all then clearing only the visible ones
    await user.click(headerBox());
    expect(selectionText()).toBe('4 of 4 operations selected');
  });

  it('shows a message when no operation matches the filter', async () => {
    const { user } = await setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'notVerified');
    expect(screen.getByText('No operations match this filter.')).toBeTruthy();
    expect(button('Select all visible').disabled).toBe(true);
  });

  it('is operable with the keyboard: Space toggles the focused checkbox', async () => {
    const { user } = await setup();
    rowBox('unc').focus();
    await user.keyboard(' ');
    expect(rowBox('unc').checked).toBe(true);
    await user.keyboard(' ');
    expect(rowBox('unc').checked).toBe(false);
    headerBox().focus();
    await user.keyboard(' ');
    expect(selectionText()).toBe('4 of 4 operations selected');
  });

  it('keeps the selection across a refresh for operations that still exist, and drops the ones that are gone', async () => {
    const { store, user } = await setup();
    await user.click(rowBox('ok'));
    await user.click(rowBox('bad'));
    await store.put(verified('later', T + 300_000));
    await user.click(button('Refresh'));
    await screen.findByRole('checkbox', { name: 'Select operation later' });
    expect(selectionText()).toBe('2 of 5 operations selected');
    expect(rowBox('ok').checked).toBe(true);
    expect(rowBox('later').checked).toBe(false);
    const real = store.list.bind(store);
    vi.spyOn(store, 'list').mockImplementation(async () => {
      const r = await real();
      return { ...r, records: r.records.filter((x) => x.operationId !== 'ok') };
    });
    await user.click(button('Refresh'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Select operation ok' })).toBeNull());
    expect(selectionText()).toBe('1 of 4 operations selected');
  });

  it('keeps inspection and selection independent', async () => {
    const { user } = await setup();
    await user.click(rowBox('ok'));
    await user.click(screen.getByRole('button', { name: 'Show bad' }));
    expect(screen.getByRole('heading', { name: 'Operation bad' })).toBeTruthy();
    expect(selectionText()).toBe('1 of 4 operations selected');
    expect(rowBox('bad').checked).toBe(false);
    expect(rowBox('ok').checked).toBe(true);
  });

  it('shows a different chip for verified, failed, uncertain and no-write operations (text plus symbol)', async () => {
    await setup();
    const rows = within(screen.getByRole('table', { name: /Recorded operations/ })).getAllByRole('row').slice(1);
    const text = (id: string) => rows.find((r) => r.textContent?.includes(`Show ${id}`))!.textContent ?? '';
    expect(text('ok')).toContain('Succeeded (verified)');
    expect(text('bad')).toContain('Failed');
    expect(text('unc')).toContain('Uncertain');
    expect(text('skip')).toContain('No write');
    expect(text('skip')).not.toContain('Succeeded');
  });
});

describe('report actions', () => {
  it('copies the selected operations as one text report and says how many', async () => {
    const { user, clipboard } = await setup();
    await user.click(rowBox('ok'));
    await user.click(rowBox('bad'));
    await user.click(button('Copy as text'));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Report result' }).textContent).toBe('Copied 2 operations to the clipboard as text.'));
    const text = (clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText.mock.calls[0]![0] as string;
    expect(text).toContain('DATAVERSE SECURITY MANAGER - OPERATIONS REPORT');
    expect(text).toContain('Operations in this report: 2');
    expect(text).toContain('Operation id: ok');
    expect(text).toContain('Operation id: bad');
    expect(text).not.toContain('Operation id: unc');
    expect(text).toContain('Generated: 2026-11-03 22:00:00 UTC+02:00 (Europe/Helsinki)');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('copies one operation from its detail view', async () => {
    const { user, clipboard } = await setup();
    await user.click(screen.getByRole('button', { name: 'Show unc' }));
    await user.click(button('Copy this operation as text'));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Report result' }).textContent).toBe('Copied 1 operation to the clipboard as text.'));
    const text = (clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText.mock.calls[0]![0] as string;
    expect(text).toContain('[1/1] UNCERTAIN');
    expect(text).not.toContain('Operation id: ok');
  });

  it('shows the text for manual copying when the clipboard refuses', async () => {
    const { user } = await setup({ clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    await user.click(rowBox('ok'));
    await user.click(button('Copy as text'));
    const box = (await screen.findByLabelText('Report text (select all and copy)')) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.value).toContain('OPERATIONS REPORT');
    expect(screen.getByRole('status', { name: 'Report result' }).textContent).toBe('Could not copy: select the text below and copy it manually.');
  });

  it('does not crash and shows the text when there is no clipboard at all', async () => {
    const { user } = await setup({ clipboard: null });
    await user.click(rowBox('ok'));
    await user.click(button('Copy as text'));
    expect(((await screen.findByLabelText('Report text (select all and copy)')) as HTMLTextAreaElement).value).toContain('Operation id: ok');
  });

  it('exports the selection as a .txt file with CRLF line ends and a file name from the environment and time', async () => {
    const { user, files } = await setup();
    await user.click(rowBox('bad'));
    await user.click(button('Export as .txt'));
    expect(files).toHaveLength(1);
    expect(files[0]!.mime).toBe('text/plain');
    expect(files[0]!.filename).toBe('dsm-operations-abcdef12-20261103-200000.txt');
    expect(files[0]!.content).toContain('OPERATIONS REPORT\r\n');
    expect(files[0]!.content).not.toMatch(/[^\r]\n/);
    expect(files[0]!.content).toContain('Operation id: bad');
    expect(screen.getByRole('status', { name: 'Report result' }).textContent).toBe('Saved 1 operation as a text file.');
  });

  it('offers the whole history explicitly and uses it for text, JSON and CSV', async () => {
    const { user, files, clipboard } = await setup();
    await user.click(screen.getByRole('radio', { name: /Whole history \(4\)/ }));
    await user.click(button('Copy as text'));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Report result' }).textContent).toContain('Copied 4 operations'));
    expect(((clipboard as { writeText: ReturnType<typeof vi.fn> }).writeText.mock.calls[0]![0] as string)).toContain('Operations in this report: 4');
    await user.click(button('Export as JSON'));
    await user.click(button('Export as CSV'));
    expect(files.map((f) => f.filename)).toEqual(['dsm-operation-history-20261103-200000.json', 'dsm-operation-history-20261103-200000.csv']);
    expect(JSON.parse(files[0]!.content).operations).toHaveLength(4);
  });

  it('exports the selected operations as JSON and CSV (secondary formats)', async () => {
    const { user, files } = await setup();
    await user.click(rowBox('ok'));
    await user.click(button('Export as JSON'));
    await user.click(button('Export as CSV'));
    expect(files[0]!.filename).toBe('dsm-operations-selected-20261103-200000.json');
    expect(JSON.parse(files[0]!.content).operations.map((o: { operationId: string }) => o.operationId)).toEqual(['ok']);
    expect(files[1]!.content).toContain('ok');
    expect(files[1]!.content).not.toContain('corr-bad');
  });

  it('disables every report action until something is selected, and says what to do', async () => {
    const { user } = await setup();
    for (const name of ['Copy as text', 'Export as .txt', 'Export as JSON', 'Export as CSV']) expect(button(name).disabled).toBe(true);
    expect(screen.getByText('Select one or more operations, or choose Whole history.')).toBeTruthy();
    await user.click(rowBox('ok'));
    for (const name of ['Copy as text', 'Export as .txt', 'Export as JSON', 'Export as CSV']) expect(button(name).disabled).toBe(false);
    expect(screen.queryByText('Select one or more operations, or choose Whole history.')).toBeNull();
  });

  it('puts the text actions first and the structured formats second', async () => {
    await setup();
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('Copy as text')).toBeLessThan(names.indexOf('Export as JSON'));
    expect(names.indexOf('Export as .txt')).toBeLessThan(names.indexOf('Export as CSV'));
    expect(screen.getByText('Structured export:')).toBeTruthy();
  });

  it('reports a partially recorded (interrupted) operation as not done', async () => {
    const store = new MemoryOperationStore();
    await store.put(begin('cut', T));
    const user = userEvent.setup();
    const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>(async () => undefined) };
    render(<OperationsModule store={store} now={() => T} clipboard={clipboard} timeZone="UTC" />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select operation cut' }));
    await user.click(button('Copy as text'));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    const text = clipboard.writeText.mock.calls[0]![0] as string;
    expect(text).not.toMatch(/\] VERIFIED - /);
    expect(text).toMatch(/\] (UNCERTAIN|NOT FINISHED) - /);
  });
});

describe('copyText', () => {
  it('uses the async clipboard when it works', async () => {
    const api = { writeText: vi.fn(async () => undefined) };
    expect(await copyText('x', api)).toBe(true);
    expect(api.writeText).toHaveBeenCalledWith('x');
  });

  it('falls back to execCommand when the async clipboard is denied, and cleans up', async () => {
    const api = { writeText: vi.fn(async () => { throw new Error('denied'); }) };
    const exec = vi.fn(() => true);
    Object.assign(document, { execCommand: exec });
    try {
      expect(await copyText('hello', api)).toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      delete (document as unknown as Record<string, unknown>)['execCommand'];
    }
  });

  it('returns false when neither route works', async () => {
    expect(await copyText('x', undefined)).toBe(false);
    expect(await copyText('x', { writeText: async () => { throw new Error('no'); } })).toBe(false);
  });

  it('returns false when execCommand throws or reports failure', async () => {
    Object.assign(document, { execCommand: () => { throw new Error('boom'); } });
    try {
      expect(await copyText('x', undefined)).toBe(false);
      Object.assign(document, { execCommand: () => false });
      expect(await copyText('x', undefined)).toBe(false);
    } finally {
      delete (document as unknown as Record<string, unknown>)['execCommand'];
    }
  });
});
