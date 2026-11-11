import type { ApprovedPlan, FailureClass, OperationResult, Outcome } from '../../domain/operations';
import { plannedWrite } from '../../domain/operations';
import type { TargetState } from '../../domain/history/types';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import type { OperationRecorder } from './recorder';

// Connects one confirmed write operation to the history ledger (issue #274, slice D of #325). Used by the services of the three real write
// paths (role edit, role assignment, Business Unit move). Rules:
//  - the intent is recorded BEFORE anything is sent; when that fails nothing is sent (`begin()` returns false);
//  - each step is marked started right before its request is sent;
//  - the final outcome of each step is the one the path's own re-read decided: an accepted request alone is `notVerified`, never verified;
//  - once the writes have happened a ledger failure never changes or hides the write result (every call below swallows storage errors; the
//    recorder remembers the last one in `lastSaveError`);
//  - nothing here claims rollback or recovery.

/** Shown when the intent could not be written, so the operation was not started. */
export const HISTORY_BLOCKED_MESSAGE = 'The operation history could not be written, so nothing was sent.';

export interface LedgerStep {
  readonly key: string;
  readonly outcome: Outcome;
  readonly message: string;
  /** Overrides the class of the raw write result (for a failure found by the re-read rather than by the write). */
  readonly failure?: FailureClass;
  /** State found by the verifying re-read (recorded as the step's `after`). Leave out when the re-read did not show it. */
  readonly after?: TargetState;
  /** State READ before the write, when the caller has it at finish time (otherwise use `noteBefore`). */
  readonly before?: TargetState;
}

export class LedgerRun {
  private readonly raw = new Map<string, OperationResult>();
  private readonly befores = new Map<string, TargetState>();
  private opened = false;

  constructor(
    private readonly recorder: OperationRecorder,
    private readonly approval: ApprovedPlan,
  ) {}

  /** False when the intent could not be made durable: the caller must not send anything. */
  async begin(): Promise<boolean> {
    try {
      await this.recorder.begin(this.approval);
      this.opened = true;
      return true;
    } catch {
      return false;
    }
  }

  /** The request of this step is about to be sent. */
  async started(key: string): Promise<void> {
    if (!this.opened) return;
    try {
      await this.recorder.stepStarted(this.approval.operationId, key);
    } catch {
      // the write must go on; the recorder keeps the error
    }
  }

  /**
   * Keeps the state of a step's target that was READ before anything was sent. Never call it with a guess: a step without a before-state is
   * simply not restorable.
   */
  noteBefore(key: string, state: TargetState): void {
    this.befores.set(key, state);
  }

  /** Keeps what the writer itself reported (failure class, technical code, whether a request left) for the final record. */
  noteWrite(key: string, result: OperationResult): void {
    this.raw.set(key, result);
  }

  /** Records the final outcome of every step (`succeeded` means a re-read confirmed it) and closes the operation. */
  async finish(steps: readonly LedgerStep[]): Promise<void> {
    if (!this.opened) return;
    for (const s of steps) {
      const w = this.raw.get(s.key);
      // An accepted request has failure 'none'; when the re-read then decides the step FAILED, 'none' would show "Failed (none)" and give the
      // retry advice no class. A final failed step therefore never keeps 'none': the request was accepted but not applied, an execution failure.
      const reported: FailureClass = s.failure ?? w?.failure ?? 'none';
      const failure: FailureClass = s.outcome === 'failed' && reported === 'none' ? 'execution' : reported;
      const result: OperationResult = {
        outcome: s.outcome,
        message: s.message,
        failure,
        ...(w?.technical ? { technical: w.technical } : {}),
        ...(w?.dispatched !== undefined ? { dispatched: w.dispatched } : {}),
      };
      try {
        const before = s.before ?? this.befores.get(s.key);
        await this.recorder.stepResult(this.approval.operationId, s.key, result, {
          verified: s.outcome === 'succeeded',
          ...(before ? { before } : {}),
          ...(s.after ? { after: s.after } : {}),
        });
      } catch {
        // a step the ledger does not know is left out; it must not change the write result
      }
    }
    try {
      await this.recorder.end(this.approval.operationId);
    } catch {
      // see above
    }
  }
}

/** Opens a ledger run when a recorder exists. Without one the writes work as before. */
export function openLedger(recorder: OperationRecorder | undefined, approval: ApprovedPlan): LedgerRun | null {
  return recorder ? new LedgerRun(recorder, approval) : null;
}

/** A writer that marks each step started before the request and keeps the raw result, then returns it unchanged. */
export function recordedWriter(writer: SecurityDataWriter, run: LedgerRun): SecurityDataWriter {
  const through = async (key: string, call: () => Promise<OperationResult>): Promise<OperationResult> => {
    await run.started(key);
    try {
      const result = await call();
      run.noteWrite(key, result);
      return result;
    } catch (e) {
      run.noteWrite(key, { outcome: 'uncertain', message: 'The write ended with an unexpected error; whether it was applied is not known until it is read again.', failure: 'execution' });
      throw e;
    }
  };
  return {
    addPrivilege: (a, roleId, privilegeId, depth) => through(plannedWrite.addPrivilege(roleId, privilegeId, depth, '').key, () => writer.addPrivilege(a, roleId, privilegeId, depth)),
    removePrivilege: (a, roleId, privilegeId) => through(plannedWrite.removePrivilege(roleId, privilegeId, '').key, () => writer.removePrivilege(a, roleId, privilegeId)),
    assignRole: (a, userId, roleId) => through(plannedWrite.assignRole(userId, roleId, '').key, () => writer.assignRole(a, userId, roleId)),
    unassignRole: (a, userId, roleId) => through(plannedWrite.unassignRole(userId, roleId, '').key, () => writer.unassignRole(a, userId, roleId)),
    moveUser: (a, userId, bu) => through(plannedWrite.moveUser(userId, bu, '').key, () => writer.moveUser(a, userId, bu)),
  };
}
