import {
  approvalRefusal,
  approvedWriteFor,
  normalizeId,
  refused,
  type ApprovedPlan,
  type FailureClass,
  type OperationResult,
  type PlannedWrite,
} from '../../../domain/operations';
import { classifyHostError, type HostErrorKind } from '../errors';
import { normalizeGuid, type IdentityResult } from '../identity';

// The explicit write boundary (issue #264). This is the ONLY module of the PPTB adapter that may name a mutating host
// method; the read adapter stays read-only (readonly.test.ts) and a test here restricts the mutating names to this folder.
//
// A write is executed only when ALL hold, checked in this order, nothing is sent otherwise:
//   1. the confirmation covers this exact write, is unexpired and was given for this environment (approvalRefusal);
//   2. the environment identity is freshly verified with writes allowed (URL, organization id AND environment id) and
//      equals the approved environment of the confirmation;
//   3. the host call the adapter makes is on the allow-list for this write's kind AND targets exactly the records named
//      in the planned write (the adapter cannot widen a write, e.g. to another user, role or Business Unit).
// Request shapes below are the documented Dataverse operations; their behaviour on the real host is UNVERIFIED until the
// approved write-test plan (#276) is executed. Nothing here claims success: a call that returns yields `notVerified`.

/** Structural subset of the host Dataverse API this boundary may touch. Everything else is deliberately absent. */
export interface RawWriteApi {
  associate?: (
    primaryEntityName: string,
    primaryEntityId: string,
    relationshipName: string,
    relatedEntityName: string,
    relatedEntityId: string,
    target?: 'primary',
  ) => Promise<void>;
  disassociate?: (
    primaryEntityName: string,
    primaryEntityId: string,
    relationshipName: string,
    relatedEntityId: string,
    target?: 'primary',
  ) => Promise<void>;
  execute?: (request: WriteExecuteRequest, target?: 'primary') => Promise<Record<string, unknown>>;
  update?: (entityLogicalName: string, id: string, record: Record<string, unknown>, target?: 'primary') => Promise<void>;
}

export interface WriteExecuteRequest {
  operationName: string;
  operationType: 'action';
  entityName?: string;
  entityId?: string;
  parameters?: Record<string, unknown>;
}

/** The allow-listed surface an executor receives for one write. */
export interface AllowedWriteCalls {
  associate(primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityName: string, relatedEntityId: string): Promise<void>;
  disassociate(primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityId: string): Promise<void>;
  execute(request: WriteExecuteRequest): Promise<void>;
  update(entityLogicalName: string, id: string, record: Record<string, unknown>): Promise<void>;
}

export const USER_ROLE_RELATIONSHIP = 'systemuserroles_association';

/** Operation names permitted per write kind. */
export const ALLOWED_EXECUTE_OPERATIONS = {
  addPrivilege: 'AddPrivilegesRole',
  removePrivilege: 'RemovePrivilegeRole',
} as const;

export class WriteBoundaryViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteBoundaryViolation';
  }
}

export interface WriteBoundaryOptions {
  readonly raw: RawWriteApi;
  /**
   * Runs immediately before the host call is sent (after validation, after any read the executor did). Throw to refuse: nothing is then sent.
   * Used to bind dispatch to the connection that was verified (a lookup between the identity check and the write can outlive a connection switch).
   */
  readonly beforeDispatch?: () => Promise<void> | void;
  /** Freshly verifies the connected environment before EVERY write (no caching inside the boundary). */
  readonly verifyIdentity: () => Promise<IdentityResult>;
  readonly now?: () => number;
}

export interface WriteBoundary {
  /** Executes `write` through `execute`, which may only use the allow-listed calls for that write. */
  run(approval: ApprovedPlan, write: PlannedWrite, execute: (calls: AllowedWriteCalls) => Promise<void>): Promise<OperationResult>;
}

const DEPTH_CODES: Record<string, number> = { Basic: 0, Local: 1, Deep: 2, Global: 3 };
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** True when `obj` has exactly the `required` keys plus any of the `optional` ones, and nothing else. */
function hasKeys(obj: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(obj);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function idIs(value: unknown, id: string): boolean {
  return typeof value === 'string' && normalizeId(value) === normalizeId(id);
}

/** Exact structural validation of the supported request shapes (shapes UNVERIFIED on the real host until the write-test plan runs). */
function validateAddPrivilege(request: WriteExecuteRequest, write: Extract<PlannedWrite, { kind: 'addPrivilege' }>): string | null {
  const params = asRecord(request.parameters);
  if (!params || !hasKeys(params, ['Privileges'])) return 'AddPrivilegesRole takes exactly one Privileges parameter.';
  const list = params.Privileges;
  if (!Array.isArray(list) || list.length !== 1) return 'AddPrivilegesRole must carry exactly the one planned privilege.';
  const entry = asRecord(list[0]);
  if (!entry || !hasKeys(entry, ['PrivilegeId', 'Depth', 'BusinessUnitId'])) return 'The privilege entry must have exactly PrivilegeId, Depth and BusinessUnitId.';
  if (!idIs(entry.PrivilegeId, write.privilegeId)) return 'The request names a different privilege than the plan.';
  const depthOk = entry.Depth === write.depth || entry.Depth === DEPTH_CODES[write.depth];
  if (!depthOk) return 'The request carries a different depth than the plan.';
  if (typeof entry.BusinessUnitId !== 'string' || !GUID.test(entry.BusinessUnitId)) return 'The request needs the Business Unit id of the role.';
  return null;
}

function validateRemovePrivilege(request: WriteExecuteRequest, write: Extract<PlannedWrite, { kind: 'removePrivilege' }>): string | null {
  // Web API reference: RemovePrivilegeRole is bound to role and takes exactly one parameter, `Privilege` (a privilege entity reference).
  const params = asRecord(request.parameters);
  if (!params || !hasKeys(params, ['Privilege'])) return 'RemovePrivilegeRole takes exactly one Privilege parameter.';
  const privilege = asRecord(params.Privilege);
  if (!privilege || !hasKeys(privilege, ['@odata.type', 'privilegeid']) || privilege['@odata.type'] !== 'Microsoft.Dynamics.CRM.privilege') {
    return 'Privilege must be a privilege reference.';
  }
  return idIs(privilege.privilegeid, write.privilegeId) ? null : 'The request names a different privilege than the plan.';
}

/**
 * A Business Unit move is an Update of `systemuser.businessunitid` ALONE (architecture decision D13: Microsoft marks SetBusinessSystemUser
 * deprecated and names Update as its replacement, so the deprecated action is not allowed). The record must be exactly the lookup bind to
 * the planned target Business Unit; nothing else may be written to the user. What the update does to roles, teams, record ownership and
 * the manager's direct reports is UNVERIFIED until write-test S3 runs.
 */
const BU_BIND = /^\/?businessunits\(\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?\)$/i;

function validateMoveUserUpdate(entity: string, id: string, record: Record<string, unknown>, write: Extract<PlannedWrite, { kind: 'moveUser' }>): string | null {
  if (entity !== 'systemuser' || !idIs(id, write.userId)) return 'The update does not target the planned user.';
  if (!hasKeys(record, ['businessunitid@odata.bind'])) return 'Only businessunitid may be updated on the user.';
  const bind = record['businessunitid@odata.bind'];
  const match = typeof bind === 'string' ? BU_BIND.exec(bind) : null;
  if (!match) return 'businessunitid must be a lookup bind to a business unit.';
  return idIs(match[1] as string, write.targetBusinessUnitId) ? null : 'The update names a different Business Unit than the plan.';
}

function sameId(a: string | undefined, b: string): boolean {
  return a !== undefined && normalizeId(a) === normalizeId(b);
}

/** Tracks whether a host call was sent, so a later failure is never reported as "nothing was sent". */
interface DispatchState {
  /** A host call was sent (or is being sent). */
  dispatched: boolean;
  /** The single host call of this write was claimed; a second call is refused even while the first is still being prepared. */
  reserved: boolean;
}

function scopedCalls(raw: RawWriteApi, write: PlannedWrite, state: DispatchState, beforeDispatch?: () => Promise<void> | void): AllowedWriteCalls {
  const claim = () => {
    if (state.reserved) throw new WriteBoundaryViolation('A planned write allows exactly one host call.');
    state.reserved = true;
  };
  // Last check before the call leaves: if it fails, nothing was sent (dispatched stays false).
  const ready = async () => {
    try {
      await beforeDispatch?.();
    } catch {
      throw new WriteBoundaryViolation('The connection changed after the identity check, so the change was not sent.');
    }
  };
  const need = <F>(fn: F | undefined, name: string): F => {
    if (typeof fn !== 'function') throw new WriteBoundaryViolation(`The host does not provide ${name}.`);
    return fn;
  };
  return {
    async associate(primaryEntity, primaryId, relationship, relatedEntity, relatedId) {
      if (write.kind !== 'assignRole') throw new WriteBoundaryViolation(`associate is not allowed for ${write.kind}.`);
      if (primaryEntity !== 'systemuser' || relatedEntity !== 'role' || relationship !== USER_ROLE_RELATIONSHIP) {
        throw new WriteBoundaryViolation('associate is limited to systemuser -> role through the user-role relationship.');
      }
      if (!sameId(primaryId, write.userId) || !sameId(relatedId, write.roleId)) {
        throw new WriteBoundaryViolation('associate targets records that are not in the planned write.');
      }
      claim();
      const fn = need(raw.associate, 'associate');
      await ready();
      state.dispatched = true;
      await fn.call(raw, primaryEntity, normalizeId(primaryId), relationship, relatedEntity, normalizeId(relatedId), 'primary');
    },
    async disassociate(primaryEntity, primaryId, relationship, relatedId) {
      if (write.kind !== 'unassignRole') throw new WriteBoundaryViolation(`disassociate is not allowed for ${write.kind}.`);
      if (primaryEntity !== 'systemuser' || relationship !== USER_ROLE_RELATIONSHIP) {
        throw new WriteBoundaryViolation('disassociate is limited to systemuser -> role through the user-role relationship.');
      }
      if (!sameId(primaryId, write.userId) || !sameId(relatedId, write.roleId)) {
        throw new WriteBoundaryViolation('disassociate targets records that are not in the planned write.');
      }
      claim();
      const fn = need(raw.disassociate, 'disassociate');
      await ready();
      state.dispatched = true;
      await fn.call(raw, primaryEntity, normalizeId(primaryId), relationship, normalizeId(relatedId), 'primary');
    },
    async update(entity, id, record) {
      if (write.kind !== 'moveUser') throw new WriteBoundaryViolation(`update is not allowed for ${write.kind}.`);
      const problem = validateMoveUserUpdate(entity, id, record, write);
      if (problem) throw new WriteBoundaryViolation(problem);
      claim();
      const fn = need(raw.update, 'update');
      await ready();
      state.dispatched = true;
      // Sent in the canonical form, built from the planned write, never the caller's text.
      await fn.call(raw, 'systemuser', normalizeId(id), { 'businessunitid@odata.bind': `/businessunits(${normalizeId(write.targetBusinessUnitId)})` }, 'primary');
    },
    async execute(request) {
      if (request.operationType !== 'action') throw new WriteBoundaryViolation('Only actions may be executed.');
      switch (write.kind) {
        case 'addPrivilege':
        case 'removePrivilege': {
          const expected = ALLOWED_EXECUTE_OPERATIONS[write.kind];
          if (request.operationName !== expected) throw new WriteBoundaryViolation(`${write.kind} may only execute ${expected}.`);
          if (request.entityName !== 'role' || !sameId(request.entityId, write.roleId)) {
            throw new WriteBoundaryViolation('The request does not target the planned role.');
          }
          const problem = write.kind === 'addPrivilege' ? validateAddPrivilege(request, write) : validateRemovePrivilege(request, write);
          if (problem) throw new WriteBoundaryViolation(problem);
          break;
        }
        default:
          throw new WriteBoundaryViolation(`execute is not allowed for ${write.kind}.`);
      }
      claim();
      const fn = need(raw.execute, 'execute');
      await ready();
      state.dispatched = true;
      await fn.call(raw, request, 'primary');
    },
  };
}

interface Mapped {
  readonly failure: FailureClass;
  readonly outcome: 'failed' | 'uncertain';
  readonly message: string;
}

const MAPPED: Record<HostErrorKind, Mapped> = {
  auth: { failure: 'permission', outcome: 'failed', message: 'The sign-in was refused. Sign in again in the host and retry. Nothing was changed.' },
  permission: { failure: 'permission', outcome: 'failed', message: 'The account lacks a privilege for this change. Nothing was changed.' },
  throttled: { failure: 'throttling', outcome: 'failed', message: 'Dataverse limited the request rate. Nothing was changed; retry later.' },
  notFound: { failure: 'execution', outcome: 'failed', message: 'A record in this change was not found. Nothing was changed.' },
  network: { failure: 'connection', outcome: 'uncertain', message: 'The connection failed; whether the change was applied is not known until it is read again.' },
  connectionChanged: { failure: 'identity', outcome: 'uncertain', message: 'The connection changed during the change; read the records again to see what was applied.' },
  unknown: { failure: 'execution', outcome: 'uncertain', message: 'Dataverse reported an error; whether the change was applied is not known until it is read again.' },
};

export function describeIdentityRefusal(result: IdentityResult): string {
  if (result.status === 'refused') return `${result.message} No change was sent.`;
  return 'The environment id could not be verified, and writes require it. No change was sent.';
}

export function createWriteBoundary(options: WriteBoundaryOptions): WriteBoundary {
  const now = options.now ?? Date.now;
  return {
    async run(approval, write, execute) {
      // The environment is identified FIRST (a fresh check before every write); the confirmation must have been given for exactly that environment.
      let identity: IdentityResult;
      try {
        identity = await options.verifyIdentity();
      } catch {
        return refused('identity', 'The environment could not be verified. No change was sent.');
      }
      if (identity.status !== 'verified' || !identity.writesAllowed) return refused('identity', describeIdentityRefusal(identity));
      // A confirmation is bound to the key the environment had when it was identified: its environment id, or its organization id when the environment id
      // could not be read at that moment (a transient failure of RetrieveCurrentOrganization). Both identify the SAME freshly verified environment, so the
      // confirmation is valid if it carries either of them; a different environment has neither, and its confirmation is refused.
      const own = [identity.environment.environmentId, identity.environment.organizationId].filter((k): k is string => typeof k === 'string' && k !== '');
      const bound = own.find((k) => normalizeId(k) === normalizeId(approval.environmentId)) ?? identity.environment.key;
      const refusal = approvalRefusal(approval, write, normalizeGuid(bound), now());
      if (refusal) return refused('validation', refusal);
      // Execute the CONFIRMED write, never the caller-supplied object (same key, other contents is refused above).
      const approved = approvedWriteFor(approval, write);
      if (!approved) return refused('validation', 'This change is not part of the confirmed plan.');

      const state: DispatchState = { dispatched: false, reserved: false };
      try {
        await execute(scopedCalls(options.raw, approved, state, options.beforeDispatch));
      } catch (error) {
        if (error instanceof WriteBoundaryViolation) {
          // A change may already have gone out before the blocked call: never report that as a clean refusal.
          if (state.dispatched) {
            return {
              outcome: 'uncertain',
              message: 'A change was sent and a further call was then blocked by the write boundary. Read the records again to see what was applied.',
              failure: 'validation',
              technical: error.message,
              dispatched: true,
            };
          }
          // The violation texts are our own fixed strings (never host text), so the reason is safe to show: without it an owner cannot tell WHY a write was refused.
          return refused('validation', `The change was blocked by the write boundary: ${error.message} Nothing was sent.`, error.message);
        }
        const classified = classifyHostError(error);
        const m = MAPPED[classified.kind];
        const technical = classified.status === undefined ? classified.kind : `${classified.kind} ${classified.status}`;
        return { outcome: m.outcome, message: m.message, failure: m.failure, technical, dispatched: state.dispatched };
      }
      if (!state.dispatched) return refused('validation', 'No host call was made. Nothing was sent.');
      return { outcome: 'notVerified', message: 'Dataverse accepted the change. It has not been re-read yet.', failure: 'none', dispatched: true };
    },
  };
}
