import { useCallback, useRef, useState } from 'react';
import { planAssignments, type AssignmentAction, type AssignmentPlan } from '../../../application/assignments/planner';
import { confirmAndApplyAssignments, type AppliedAssignments } from '../../../application/assignments/service';
import type { BusinessUnit, Role, Tri, UserAccess } from '../../../domain/buMove/types';
import { normalizeId } from '../../../domain/operations';
import type { AccessReader } from '../../../ports/accessReader';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { useOperationRecorder } from '../../operations/RecorderContext';

// State of direct role assignment in the Access Explorer (issue #270). The planner and the apply service hold the rules; this hook only
// sequences the screens: staging (idle) -> previewing -> applying -> done. Nothing is written by staging or by opening the preview; the only
// write path is `confirm`, called after the person pressed Confirm in the preview. It lives above the user detail so the preview and the
// result survive the reload of the user's access, and the search and the selected user are never touched.

export type AssignPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'previewing'; readonly plan: AssignmentPlan }
  | { readonly kind: 'applying'; readonly plan: AssignmentPlan }
  | { readonly kind: 'done'; readonly plan: AssignmentPlan; readonly applied: AppliedAssignments }
  /** The apply call itself threw: what was applied is not known until the user's roles are read again. */
  | { readonly kind: 'unknown'; readonly plan: AssignmentPlan; readonly message: string };

export interface RoleAssignmentConfig {
  readonly reader: Pick<AccessReader, 'loadUserAccess'>;
  /** Null when nothing may be written (demo mode, or a host without the Dataverse API): role changes are then not offered at all. */
  readonly writer: SecurityDataWriter | null;
  readonly actor: string;
  /** The environment the preview is confirmed for; the write boundary compares it with the approved environment. */
  readonly environmentId: string;
  /** Reload the selected user's access (the re-read result is shown first). */
  readonly onReload: () => void;
}

/** What the planner needs besides the user's access: whether other Business Units may be used and their names. */
export interface AssignContextInput {
  readonly crossBuAssignment: Tri;
  readonly businessUnits: readonly BusinessUnit[];
}

export interface RoleAssignments {
  readonly available: boolean;
  readonly phase: AssignPhase;
  /** Requested changes of the user being edited, by normalized role id. */
  readonly staged: ReadonlyMap<string, AssignmentAction>;
  /** Why a preview could not open or a change was refused; null when there is nothing to say. */
  readonly notice: string | null;
  toggle(userId: string, roleId: string, action: AssignmentAction): void;
  discard(): void;
  openPreview(access: UserAccess, catalog: readonly Role[], context?: AssignContextInput): void;
  cancelPreview(): void;
  confirm(): Promise<void>;
  finish(): void;
  /** The selected user changed: staged requests of the previous user are dropped (a running or finished operation is kept). */
  reset(): void;
  /** The chosen target Business Unit and the roles read for each unit live here, above the detail tabs, so they survive switching tabs together with the staged requests. */
  readonly target: { readonly user: string; readonly bu: string } | null;
  setTarget(userId: string, businessUnitId: string): void;
  remember(userId: string, businessUnitId: string, roles: readonly Role[]): void;
  rememberedRoles(userId: string): readonly Role[];
}

export function useRoleAssignments(config: RoleAssignmentConfig): RoleAssignments {
  const [phase, setPhaseState] = useState<AssignPhase>({ kind: 'idle' });
  const [staged, setStagedState] = useState<ReadonlyMap<string, AssignmentAction>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTargetState] = useState<{ readonly user: string; readonly bu: string } | null>(null);
  const memory = useRef(new Map<string, readonly Role[]>());
  const forget = useCallback(() => {
    memory.current = new Map();
    setTargetState(null);
  }, []);
  const phaseRef = useRef<AssignPhase>(phase);
  const stagedRef = useRef<ReadonlyMap<string, AssignmentAction>>(staged);
  const stagedUser = useRef<string | null>(null);
  const applying = useRef(false);
  const setPhase = useCallback((next: AssignPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const setStaged = useCallback((next: ReadonlyMap<string, AssignmentAction>) => {
    stagedRef.current = next;
    setStagedState(next);
  }, []);
  const { reader, writer, actor, environmentId, onReload } = config;
  const recorder = useOperationRecorder();
  // Stable (the explorer calls it from an effect keyed on the selected user) and a no-op when there is nothing staged.
  const reset = useCallback(() => {
    if (phaseRef.current.kind !== 'idle' || (stagedRef.current.size === 0 && stagedUser.current === null)) return;
    setNotice(null);
    setStaged(new Map());
    stagedUser.current = null;
    forget();
  }, [setStaged, forget]);

  return {
    available: writer !== null,
    phase,
    staged,
    notice,

    toggle(userId, roleId, action) {
      if (phaseRef.current.kind !== 'idle') return;
      const uid = normalizeId(userId);
      const id = normalizeId(roleId);
      const next = new Map(stagedUser.current === uid ? stagedRef.current : []);
      stagedUser.current = uid;
      if (next.get(id) === action) next.delete(id);
      else next.set(id, action);
      setNotice(null);
      setStaged(next);
    },

    discard() {
      if (phaseRef.current.kind === 'applying') return;
      setNotice(null);
      setStaged(new Map());
      forget();
      if (phaseRef.current.kind === 'previewing') setPhase({ kind: 'idle' });
    },

    openPreview(access, catalog, context) {
      if (phaseRef.current.kind !== 'idle' || stagedRef.current.size === 0) return;
      if (stagedUser.current !== normalizeId(access.user.id)) return;
      const plan = planAssignments({ access, catalog, requests: [...stagedRef.current].map(([roleId, action]) => ({ action, roleId })), ...(context ? { crossBuAssignment: context.crossBuAssignment, businessUnits: context.businessUnits } : {}) });
      if (!plan.plan) {
        const why = plan.items.map((i) => `${i.roleName}: ${i.reason}`).join(' ');
        setNotice(`Nothing would be changed. ${why}`.trim());
        return;
      }
      setNotice(null);
      setPhase({ kind: 'previewing', plan });
    },

    cancelPreview() {
      if (phaseRef.current.kind === 'previewing') setPhase({ kind: 'idle' });
    },

    async confirm() {
      const p = phaseRef.current;
      if (p.kind !== 'previewing' || !writer || applying.current) return;
      applying.current = true;
      const plan = p.plan;
      setPhase({ kind: 'applying', plan });
      try {
        const applied = await confirmAndApplyAssignments({ plan, writer, reader, actor, environmentId, ...(recorder ? { recorder } : {}) });
        setPhase(applied ? { kind: 'done', plan, applied } : { kind: 'idle' });
      } catch {
        setPhase({
          kind: 'unknown',
          plan,
          message: 'The change ended with an unexpected error. What was applied is not known: read the user’s roles again before trying anything else.',
        });
      } finally {
        applying.current = false;
      }
    },

    finish() {
      const p = phaseRef.current;
      if (p.kind !== 'done' && p.kind !== 'unknown') return;
      setNotice(null);
      setStaged(new Map());
      stagedUser.current = null;
      forget();
      setPhase({ kind: 'idle' });
      onReload();
    },

    reset,
    target,
    setTarget(userId, businessUnitId) {
      setTargetState({ user: normalizeId(userId), bu: businessUnitId });
    },
    remember(userId, businessUnitId, roles) {
      memory.current.set(`${normalizeId(userId)}|${normalizeId(businessUnitId)}`, roles);
    },
    rememberedRoles(userId) {
      const prefix = `${normalizeId(userId)}|`;
      return [...memory.current].filter(([k]) => k.startsWith(prefix)).flatMap(([, v]) => v);
    },
  };
}
