import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixtureReader } from '../adapters/fixture/fixtureReader';
import type { HostWindow } from '../adapters/pptb/connection';
import { MemoryOperationStore } from '../application/operations/memoryOperationStore';
import { OperationRecorder } from '../application/operations/recorder';
import { approvePlan, createWritePlan, plannedWrite } from '../domain/operations';
import { App } from './App';
import { DEFAULT_MODULES, type AppModule } from './modules';
import { useConnectionWatch } from './useConnectionWatch';

interface Conn { id: string; name: string; url: string }
const DEV: Conn = { id: 'c-dev', name: 'Dev', url: 'https://org-dev.crm4.dynamics.com' };
const PROD: Conn = { id: 'c-prod', name: 'Prod', url: 'https://org-prod.crm4.dynamics.com' };

/** A host whose active connection a test can switch; counts how often the connection was read. */
function makeHost(initial: Conn = DEV) {
  let active: Conn | null = initial;
  let slots = 2;
  const reads = { active: 0 };
  // Lets a test act between two host calls: runs after call number n (counted from `resetCalls`), and the call answers only once it resolved.
  const hooks: { afterCall?: (n: number) => Promise<void> | void } = {};
  let callNo = 0;
  const host: HostWindow = {
    toolboxAPI: {
      connections: {
        getActiveConnection: async () => {
          reads.active++;
          const value = active;
          await hooks.afterCall?.(++callNo);
          return value;
        },
        getConnections: async () => Array.from({ length: slots }, () => ({ url: 'https://x' })),
      },
    },
  };
  return {
    host,
    reads,
    switchTo(next: Conn | null) { active = next; },
    hooks,
    resetCalls() { callNo = 0; },
    setSlots(n: number) { slots = n; },
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useConnectionWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('reads the connection once and does nothing while the fingerprint is unchanged', async () => {
    const h = makeHost();
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    expect(result.current.connection).toMatchObject({ kind: 'host', name: 'Dev' });
    const first = result.current.connection;
    await tick(1500 * 5);
    expect(result.current.epoch).toBe(0);
    expect(result.current.notice).toBeNull();
    expect(result.current.connection).toBe(first);
  });

  it('on a change updates the connection, bumps the epoch and says what happened', async () => {
    const h = makeHost();
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    h.switchTo(PROD);
    await tick(1500);
    expect(result.current.epoch).toBe(1);
    expect(result.current.connection).toMatchObject({ kind: 'host', name: 'Prod' });
    expect(result.current.notice).toContain('changed to Prod');
    expect(result.current.notice).toContain('Unconfirmed edits, previews and loaded data were discarded');
    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });

  it('a change of the set of connections also reloads (the fingerprint includes it)', async () => {
    const h = makeHost();
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    h.setSlots(3);
    await tick(1500);
    expect(result.current.epoch).toBe(1);
  });

  it('losing the connection clears the data and says so', async () => {
    const h = makeHost();
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    h.switchTo(null);
    await tick(1500);
    expect(result.current.epoch).toBe(1);
    expect(result.current.connection).toEqual({ kind: 'none' });
    expect(result.current.notice).toContain('No connection is selected any more');
  });

  it('does not poll while the page is hidden and checks at once when it gets focus', async () => {
    const h = makeHost();
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    setHidden(true);
    h.switchTo(PROD);
    const before = h.reads.active;
    await tick(1500 * 4);
    expect(h.reads.active).toBe(before);
    expect(result.current.epoch).toBe(0);
    setHidden(false);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.epoch).toBe(1);
  });

  it('initial header and baseline come from one consistent read when the connection switches during initialization', async () => {
    const h = makeHost(DEV);
    // The state read (call 2) answers Dev, then the user switches to Prod before the second fingerprint read.
    h.hooks.afterCall = (n) => {
      if (n === 2) h.switchTo(PROD);
    };
    const { result } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    expect(result.current.connection).toMatchObject({ kind: 'host', name: 'Prod' });
    await tick(1500 * 3);
    // the baseline is Prod too: nothing is "corrected" later and there was no reload
    expect(result.current.epoch).toBe(0);
    expect(result.current.connection).toMatchObject({ name: 'Prod' });
  });

  it('a write confirmed while the new state is being read keeps its screen; the reload waits for the write', async () => {
    const h = makeHost();
    let busy = false;
    const { result } = renderHook(() => useConnectionWatch(h.host, { isBusy: () => busy }));
    await tick(0);
    let release: () => void = () => undefined;
    h.resetCalls();
    // after the switch: call 1 = change detection, 2 = fingerprint, 3 = the state read (held), 4 = fingerprint
    h.hooks.afterCall = (n) => (n === 3 ? new Promise<void>((r) => { release = r; }) : undefined);
    h.switchTo(PROD);
    await tick(1500);
    expect(result.current.epoch).toBe(0);
    busy = true; // the user confirms a write while the state read is pending
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.epoch).toBe(0);
    expect(result.current.connection).toMatchObject({ name: 'Dev' });
    expect(result.current.notice).toContain('while a change was running');
    h.hooks.afterCall = undefined;
    busy = false;
    await tick(1500);
    expect(result.current.epoch).toBe(1);
    expect(result.current.connection).toMatchObject({ name: 'Prod' });
  });

  it('leaves no timer or listener behind after unmount', async () => {
    const h = makeHost();
    const { unmount } = renderHook(() => useConnectionWatch(h.host));
    await tick(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    const before = h.reads.active;
    h.switchTo(PROD);
    window.dispatchEvent(new Event('focus'));
    await tick(1500 * 3);
    expect(h.reads.active).toBe(before);
  });

  it('has nothing to watch without a host connections API (demo, no timers)', async () => {
    const noApiHost = {} as HostWindow; // a stable reference, like the real window object
    const { result } = renderHook(() => useConnectionWatch(noApiHost));
    await tick(0);
    expect(result.current.connection).toEqual({ kind: 'demo' });
    expect(vi.getTimerCount()).toBe(0);
    const { result: none } = renderHook(() => useConnectionWatch(undefined));
    await tick(1500 * 3);
    expect(none.current.epoch).toBe(0);
  });

  it('waits while a write is running, keeps the screen and its result, then reloads', async () => {
    const h = makeHost();
    let busy = true;
    const { result } = renderHook(() => useConnectionWatch(h.host, { isBusy: () => busy }));
    await tick(0);
    h.switchTo(PROD);
    await tick(1500);
    expect(result.current.epoch).toBe(0);
    expect(result.current.connection).toMatchObject({ name: 'Dev' });
    expect(result.current.notice).toContain('while a change was running');
    busy = false;
    await tick(1500);
    expect(result.current.epoch).toBe(1);
    expect(result.current.connection).toMatchObject({ name: 'Prod' });
  });
});

describe('App: a connection change reloads every screen', () => {
  it('remounts Role Analyzer, Access Explorer, BU Manager and Operations and reads the tables again', async () => {
    const h = makeHost();
    const reader = new FixtureReader();
    const listTables = vi.spyOn(reader, 'listTables');
    const { container } = render(<App reader={reader} host={h.host} />);
    await screen.findByRole('combobox');
    const names = ['Access Explorer', 'BU Manager', 'Operations'];
    for (const n of names) fireEvent.click(screen.getByRole('button', { name: n }));
    fireEvent.click(screen.getByRole('button', { name: 'Role Analyzer' }));
    const ids = ['analyzer', 'explorer', 'bu', 'operations'];
    const before = ids.map((id) => container.querySelector(`[data-module="${id}"]`));
    expect(before.every((el) => el !== null)).toBe(true);
    const readsBefore = listTables.mock.calls.length;

    h.switchTo(PROD);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/changed to Prod; data was reloaded/)).toBeTruthy();

    ids.forEach((id, i) => {
      const now = container.querySelector(`[data-module="${id}"]`);
      expect(now).not.toBeNull();
      expect(now).not.toBe(before[i]);
      expect(before[i]?.isConnected).toBe(false);
    });
    await waitFor(() => expect(listTables.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(screen.getByRole('status', { name: 'Environment' }).textContent).toContain('Prod');
  });

  function Draft() {
    const [text, setText] = useState('');
    return <input aria-label="staged edit" value={text} onChange={(e) => setText(e.target.value)} />;
  }
  const draftModule: AppModule = { id: 'draft', label: 'Draft', keepAlive: true, render: () => <Draft /> };

  it('drops staged, unconfirmed work (also in keep-alive screens) and tells the user', async () => {
    const h = makeHost();
    render(<App reader={new FixtureReader()} host={h.host} modules={[draftModule, ...DEFAULT_MODULES]} />);
    const input = await screen.findByLabelText('staged edit');
    fireEvent.change(input, { target: { value: 'Read: User -> Business Unit' } });
    expect((screen.getByLabelText('staged edit') as HTMLInputElement).value).toContain('Business Unit');
    h.switchTo(PROD);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/Unconfirmed edits, previews and loaded data were discarded/)).toBeTruthy();
    expect((screen.getByLabelText('staged edit') as HTMLInputElement).value).toBe('');
  });

  it('keeps the screen of a write that is still running and reloads after it finished', async () => {
    const h = makeHost();
    const recorder = new OperationRecorder(new MemoryOperationStore());
    const plan = approvePlan(createWritePlan([plannedWrite.assignRole('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Assign')]), 'env-1', 'ann', 1, { operationId: 'op-conn-1' });
    render(<App reader={new FixtureReader()} host={h.host} modules={[draftModule]} />);
    const input = await screen.findByLabelText('staged edit');
    fireEvent.change(input, { target: { value: 'result of a running write' } });

    const op = await recorder.begin(plan);
    h.switchTo(PROD);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/while a change was running/)).toBeTruthy();
    expect((screen.getByLabelText('staged edit') as HTMLInputElement).value).toBe('result of a running write');

    await recorder.end(op.operationId);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByText(/changed to Prod; data was reloaded/)).toBeTruthy();
    expect((screen.getByLabelText('staged edit') as HTMLInputElement).value).toBe('');
  });
});
