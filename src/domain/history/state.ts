import { hashText, normalizeId } from '../operations';
import { DEPTH_IDS, PRIVILEGE_IDS } from '../privileges';
import type { PrivilegeDepthState, RoleHeldState, StepRecord, TargetState, UserPlacementState } from './types';

// Helpers for the minimal states around a step (schema v2): canonical form, checksum, comparison and the target each step touches.
// The checksum is tamper-EVIDENCE for a stored record (like the plan hash it is a 53-bit text hash, not a security primitive).

const norm = (id: string): string => normalizeId(id);

/** A state with every id normalized and the role ids sorted, so equal states have equal text. */
export function canonicalState(state: TargetState): TargetState {
  switch (state.kind) {
    case 'privilegeDepth':
      return { kind: 'privilegeDepth', table: state.table.toLowerCase(), roleId: norm(state.roleId), privilegeId: norm(state.privilegeId), privilege: state.privilege, depth: state.depth };
    case 'roleHeld':
      return { kind: 'roleHeld', userId: norm(state.userId), roleId: norm(state.roleId), held: state.held };
    case 'userPlacement':
      return {
        kind: 'userPlacement',
        userId: norm(state.userId),
        businessUnitId: norm(state.businessUnitId),
        roleIds: state.roleIds === null ? null : [...new Set(state.roleIds.map(norm))].sort(),
      };
  }
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** Checksum over the step key and both states in canonical form. */
export function stateChecksum(key: string, before: TargetState | undefined, after: TargetState | undefined): string {
  return hashText(stable([key, before ? canonicalState(before) : null, after ? canonicalState(after) : null]));
}

export function sameState(a: TargetState, b: TargetState): boolean {
  return stable(canonicalState(a)) === stable(canonicalState(b));
}

/** Stable key of the thing a state is about; two states with the same target key describe the same object at different times. */
export function targetKeyOfState(state: TargetState): string {
  switch (state.kind) {
    case 'privilegeDepth':
      return `privilege:${norm(state.roleId)}:${norm(state.privilegeId)}`;
    case 'roleHeld':
      return `held:${norm(state.userId)}:${norm(state.roleId)}`;
    case 'userPlacement':
      return `user:${norm(state.userId)}`;
  }
}

/** The target a step touches, from its kind and key (`addPrivilege:<role>:<privilege>[:<depth>]`, `assignRole:<user>:<role>`, `moveUser:<user>:<bu>`). */
export function targetKeyOfStep(step: Pick<StepRecord, 'kind' | 'key'>): string | null {
  const parts = step.key.split(':');
  if (parts[0] !== step.kind) return null;
  switch (step.kind) {
    case 'addPrivilege':
    case 'removePrivilege':
      return parts[1] && parts[2] ? `privilege:${norm(parts[1])}:${norm(parts[2])}` : null;
    case 'assignRole':
    case 'unassignRole':
      return parts[1] && parts[2] ? `held:${norm(parts[1])}:${norm(parts[2])}` : null;
    case 'moveUser':
      return parts[1] ? `user:${norm(parts[1])}` : null;
  }
}

/** True when `state` is a state of the target this step names. */
export function stateFitsStep(step: Pick<StepRecord, 'kind' | 'key'>, state: TargetState): boolean {
  const target = targetKeyOfStep(step);
  return target !== null && target === targetKeyOfState(state);
}

// Ids are GUIDs in Dataverse; the check only keeps out anything that is not a plain identifier (no spaces, quotes or control characters).
const GUIDISH = /^[\w.:@-]{1,128}$/;
const TABLE = /^[a-z][a-z0-9_]{0,127}$/i;
export const MAX_ROLE_IDS = 5000;

const isId = (x: unknown): x is string => typeof x === 'string' && GUIDISH.test(x.trim().replace(/^\{|\}$/g, ''));

/** Validates untrusted JSON as a state (allow-list: every field checked, unknown fields dropped). Null when it is not one. */
export function parseState(v: unknown): TargetState | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'privilegeDepth': {
      if (typeof o.table !== 'string' || !TABLE.test(o.table) || !isId(o.roleId) || !isId(o.privilegeId)) return null;
      if (!(PRIVILEGE_IDS as readonly unknown[]).includes(o.privilege) || !(DEPTH_IDS as readonly unknown[]).includes(o.depth)) return null;
      const s: PrivilegeDepthState = {
        kind: 'privilegeDepth',
        table: o.table,
        roleId: norm(o.roleId),
        privilegeId: norm(o.privilegeId),
        privilege: o.privilege as PrivilegeDepthState['privilege'],
        depth: o.depth as PrivilegeDepthState['depth'],
      };
      return s;
    }
    case 'roleHeld': {
      if (!isId(o.userId) || !isId(o.roleId) || typeof o.held !== 'boolean') return null;
      const s: RoleHeldState = { kind: 'roleHeld', userId: norm(o.userId), roleId: norm(o.roleId), held: o.held };
      return s;
    }
    case 'userPlacement': {
      if (!isId(o.userId) || !isId(o.businessUnitId)) return null;
      let roleIds: string[] | null = null;
      if (o.roleIds !== null) {
        if (!Array.isArray(o.roleIds) || o.roleIds.length > MAX_ROLE_IDS || !o.roleIds.every(isId)) return null;
        roleIds = (o.roleIds as string[]).map(norm);
      }
      const s: UserPlacementState = { kind: 'userPlacement', userId: norm(o.userId), businessUnitId: norm(o.businessUnitId), roleIds };
      return s;
    }
    default:
      return null;
  }
}
