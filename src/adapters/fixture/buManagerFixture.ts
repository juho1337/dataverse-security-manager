import type { BusinessUnit, RolePrivilege, SecuritySnapshot } from '../../domain/buMove/types';
import type { ApprovedPlan, OperationResult } from '../../domain/operations';
import { normalizeId, notVerified, refused } from '../../domain/operations';
import type { BuManagerReader, PlanningData } from '../../application/buManager/ports';
import type { ReadResult, UserHit } from '../../ports/accessReader';
import type { SecurityDataWriter } from '../../ports/securityDataWriter';
import { FixtureAccessReader, SYNTHETIC_ACCESS_SNAPSHOT } from './accessFixture';

// Synthetic BU Manager data for demo mode and tests: fictional people (example.test addresses), no host, no network. In demo mode only the
// reader is used (there is no writer, so nothing can be "moved"). The in-memory environment below pairs a reader with a writer over the same
// mutable state so move/verify/partial-failure behaviour can be tested end to end WITHOUT a host. It proves nothing about the real service.

const priv = (roleId: string, entity: string, operation: RolePrivilege['operation'], depth: RolePrivilege['depth']): RolePrivilege => ({ roleId, entity, operation, depth });

/** Two privileges per role; the two Project Contributor copies are identical on purpose (a same-name, same-privileges match). */
export const SYNTHETIC_PRIVILEGES: readonly RolePrivilege[] = [
  priv('r-basic', 'account', 'Read', 'Basic'),
  priv('r-admin', 'account', 'Read', 'Global'),
  priv('r-admin', 'account', 'Write', 'Global'),
  priv('r-contrib', 'account', 'Read', 'Local'),
  priv('r-contrib', 'account', 'Write', 'Basic'),
  priv('r-contrib-north', 'account', 'Read', 'Local'),
  priv('r-contrib-north', 'account', 'Write', 'Basic'),
  priv('r-sales', 'account', 'Read', 'Deep'),
];

/** Business units of the snapshot as the planner expects them (parent and enabled state are part of the snapshot already). */
function businessUnitsOf(snapshot: SecuritySnapshot): readonly BusinessUnit[] {
  return snapshot.businessUnits;
}

export interface FixtureBuManagerOptions {
  readonly snapshot?: SecuritySnapshot;
  readonly privileges?: readonly RolePrivilege[];
  readonly latencyMs?: number;
}

/** Read side over an in-memory snapshot. `current()` lets a paired writer change the data between reads. */
export class FixtureBuManagerReader implements BuManagerReader {
  constructor(private readonly current: () => SecuritySnapshot, private readonly privileges: readonly RolePrivilege[], private readonly latencyMs = 0) {}

  private access(): FixtureAccessReader {
    return new FixtureAccessReader({ snapshot: this.current(), latencyMs: this.latencyMs });
  }

  searchUsers(query: string) {
    return this.access().searchUsers(query);
  }
  loadUserAccess(userId: string) {
    return this.access().loadUserAccess(userId);
  }

  async listBusinessUnits(): Promise<ReadResult<readonly BusinessUnit[]>> {
    return { status: 'ok', data: businessUnitsOf(this.current()) };
  }

  async findUsersByEmail(emails: readonly string[]): Promise<ReadResult<readonly UserHit[]>> {
    const s = this.current();
    const wanted = new Set(emails.map((e) => e.toLowerCase()));
    const data = s.users.filter((u) => u.email !== '' && wanted.has(u.email.toLowerCase())).map((user) => ({ user, businessUnitName: s.businessUnits.find((b) => b.id === user.businessUnitId)?.name ?? null }));
    return { status: 'ok', data };
  }

  async loadPlanningData(userIds: readonly string[], targetBusinessUnitId: string): Promise<ReadResult<PlanningData>> {
    const s = this.current();
    if (!s.businessUnits.some((b) => b.id === targetBusinessUnitId)) return { status: 'error', errorClass: 'notFound', message: 'The target business unit was not found.' };
    const ids = new Set(userIds);
    const snapshot: SecuritySnapshot = {
      ...s,
      users: s.users.filter((u) => ids.has(u.id)),
      directAssignments: s.directAssignments.filter((a) => ids.has(a.userId)),
      memberships: s.memberships.filter((m) => ids.has(m.userId)),
    };
    return { status: 'ok', data: { snapshot, privileges: this.privileges, privilegesComplete: true } };
  }
}

export function createSyntheticBuManagerReader(options: FixtureBuManagerOptions = {}): BuManagerReader {
  const snapshot = options.snapshot ?? SYNTHETIC_ACCESS_SNAPSHOT;
  return new FixtureBuManagerReader(() => snapshot, options.privileges ?? SYNTHETIC_PRIVILEGES, options.latencyMs ?? 0);
}

// ---- in-memory environment (tests): a writer and a reader over the same mutable state

export interface FakeEnvironmentOptions {
  readonly snapshot?: SecuritySnapshot;
  readonly privileges?: readonly RolePrivilege[];
  /** Roles of the user that the service removes when the Business Unit changes (what Dataverse documents for some settings; UNVERIFIED here). */
  readonly removeRolesOnMove?: boolean;
  /** Fail the nth write (1-based) of a kind with this result. */
  readonly failWrite?: { readonly kind: 'moveUser' | 'assignRole'; readonly nth?: number; readonly result: OperationResult };
  /** The write is accepted but changes nothing (a service that acknowledges without applying). */
  readonly ignoreWrites?: boolean;
  /** With `failWrite`: the change is applied anyway (a request that timed out but reached the service). */
  readonly applyDespiteFailure?: boolean;
  /** Make a write throw. */
  readonly throwOn?: 'moveUser' | 'assignRole';
}

export interface FakeEnvironment {
  readonly reader: BuManagerReader;
  readonly writer: SecurityDataWriter;
  readonly snapshot: () => SecuritySnapshot;
  /** Writes received, in order, as `kind:userId:target`. */
  readonly writes: string[];
  /** Tests only: removes a direct role behind the tool's back (a plug-in or another administrator). */
  readonly dropRole: (userId: string, roleId: string) => void;
  /** Tests only: changes a user's business unit behind the tool's back. */
  readonly setBusinessUnit: (userId: string, businessUnitId: string) => void;
}

/** Only used in tests. Writes through the same port the real writer implements, but never talks to a host. */
export function createFakeEnvironment(options: FakeEnvironmentOptions = {}): FakeEnvironment {
  let state: SecuritySnapshot = options.snapshot ?? SYNTHETIC_ACCESS_SNAPSHOT;
  const writes: string[] = [];
  const counts: Record<string, number> = {};
  const reader = new FixtureBuManagerReader(() => state, options.privileges ?? SYNTHETIC_PRIVILEGES);

  const gate = (kind: 'moveUser' | 'assignRole'): OperationResult | null => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (options.throwOn === kind) throw new Error('boom');
    const f = options.failWrite;
    if (f && f.kind === kind && (f.nth ?? 1) === counts[kind]) return f.result;
    return null;
  };
  const writer: SecurityDataWriter = {
    async addPrivilege() { return refused('validation', 'Not supported in this fake.'); },
    async removePrivilege() { return refused('validation', 'Not supported in this fake.'); },
    async unassignRole() { return refused('validation', 'Not supported in this fake.'); },
    async moveUser(approval: ApprovedPlan, userId: string, targetBusinessUnitId: string) {
      const key = `moveUser:${normalizeId(userId)}:${normalizeId(targetBusinessUnitId)}`;
      if (!approval.plan.writes.some((w) => w.key === key)) return refused('validation', 'This change is not part of the confirmed plan.');
      writes.push(key);
      const injected = gate('moveUser');
      if (injected && !options.applyDespiteFailure) return injected;
      if (!options.ignoreWrites) {
        state = {
          ...state,
          users: state.users.map((u) => (u.id === userId ? { ...u, businessUnitId: targetBusinessUnitId } : u)),
          directAssignments: options.removeRolesOnMove ? state.directAssignments.filter((a) => a.userId !== userId) : state.directAssignments,
        };
      }
      return injected ?? notVerified('Dataverse accepted the request.');
    },
    async assignRole(approval: ApprovedPlan, userId: string, roleId: string) {
      const key = `assignRole:${normalizeId(userId)}:${normalizeId(roleId)}`;
      if (!approval.plan.writes.some((w) => w.key === key)) return refused('validation', 'This change is not part of the confirmed plan.');
      writes.push(key);
      const injected = gate('assignRole');
      if (injected && !options.applyDespiteFailure) return injected;
      if (!options.ignoreWrites && !state.directAssignments.some((a) => a.userId === userId && a.roleId === roleId)) {
        state = { ...state, directAssignments: [...state.directAssignments, { userId, roleId }] };
      }
      return injected ?? notVerified('Dataverse accepted the request.');
    },
  };
  const dropRole = (userId: string, roleId: string): void => {
    state = { ...state, directAssignments: state.directAssignments.filter((a) => !(a.userId === userId && a.roleId === roleId)) };
  };
  const setBusinessUnit = (userId: string, businessUnitId: string): void => {
    state = { ...state, users: state.users.map((u) => (u.id === userId ? { ...u, businessUnitId } : u)) };
  };
  return { reader, writer, snapshot: () => state, writes, dropRole, setBusinessUnit };
}
