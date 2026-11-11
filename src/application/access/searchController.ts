import type { AccessReader, ReadResult, TeamSummary, UserHit } from '../../ports/accessReader';

// Debounced search with stale-response protection. Framework-free: the UI subscribes to the state. Host calls cannot be cancelled, so a
// response for an older query is simply ignored.

export const MIN_QUERY_LENGTH = 2;

export type SearchPhase = 'idle' | 'loading' | 'done';

export interface SearchState {
  readonly query: string;
  readonly phase: SearchPhase;
  /** True when the text is too short to search (idle with a hint, not an empty result). */
  readonly tooShort: boolean;
  readonly users: ReadResult<readonly UserHit[]> | null;
  readonly teams: ReadResult<readonly TeamSummary[]> | null;
}

export interface Timers {
  readonly set: (fn: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

const unexpected = { status: 'error', errorClass: 'unknown', message: 'The search failed unexpectedly.' } as const;

export class AccessSearchController {
  private state: SearchState = { query: '', phase: 'idle', tooShort: false, users: null, teams: null };
  private readonly listeners = new Set<() => void>();
  private handle: unknown = null;
  private seq = 0;
  private disposed = false;

  constructor(private readonly reader: AccessReader, private readonly debounceMs = 300, private readonly timers: Timers = REAL_TIMERS) {}

  getState = (): SearchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setQuery(query: string): void {
    if (this.disposed) return;
    this.cancelPending();
    const seq = ++this.seq;
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      this.set({ query, phase: 'idle', tooShort: q.length > 0, users: null, teams: null });
      return;
    }
    this.set({ query, phase: 'loading', tooShort: false, users: null, teams: null });
    this.handle = this.timers.set(() => {
      this.handle = null;
      void this.run(seq, q);
    }, this.debounceMs);
  }

  /** Re-runs the current query immediately (retry). */
  retry(): void {
    const q = this.state.query.trim();
    if (this.disposed || q.length < MIN_QUERY_LENGTH) return;
    this.cancelPending();
    const seq = ++this.seq;
    this.set({ ...this.state, phase: 'loading', users: null, teams: null });
    void this.run(seq, q);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.listeners.clear();
  }

  private async run(seq: number, q: string): Promise<void> {
    const [users, teams] = await Promise.all([
      this.reader.searchUsers(q).catch(() => unexpected),
      this.reader.searchTeams(q).catch(() => unexpected),
    ]);
    if (this.disposed || seq !== this.seq) return;
    this.set({ ...this.state, phase: 'done', users, teams });
  }

  private cancelPending(): void {
    if (this.handle !== null) this.timers.clear(this.handle);
    this.handle = null;
  }

  private set(next: SearchState): void {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
}
