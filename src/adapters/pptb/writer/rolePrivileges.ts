import { normalizeId, refused, type ApprovedPlan, type GrantDepth, type OperationResult, type PlannedWrite } from '../../../domain/operations';
import type { SecurityDataWriter } from '../../../ports/securityDataWriter';
import { classifyHostError } from '../errors';
import { WriteBoundaryViolation, type WriteBoundary } from './boundary';

// Writes of role privileges (issue #268): adds a privilege to a role or changes its depth, and removes a privilege from a role. Every
// request goes through the write boundary, which checks the confirmation, a fresh identity verification and the exact request shape;
// this module only builds the requests. It never claims success: a host call that returns yields `notVerified`, and the application's
// apply service re-reads the role to verify (application/roleEditing/apply.ts).
//
// Request shapes follow the Web API reference (read 2026-11-02): AddPrivilegesRole and RemovePrivilegeRole are actions bound to `role`;
// AddPrivilegesRole takes `Privileges`, a collection of RolePrivilege (PrivilegeId, Depth, BusinessUnitId), RemovePrivilegeRole takes
// `Privilege`, a privilege reference. Actions send their parameters as the JSON body, so the OData entity-reference form is used.
// UNVERIFIED against the real service until the approved write-test S1 runs, in particular: whether AddPrivilegesRole changes the depth
// of a privilege the role already holds (the XrmToolBox implementation relies on add-or-change), and how Depth is accepted (name or code).

/** The writes this module implements; the other methods of the port are provided by the assignment and Business Unit move writers. */
export type RolePrivilegeWriter = Pick<SecurityDataWriter, 'addPrivilege' | 'removePrivilege'>;

export interface RolePrivilegeWriterOptions {
  readonly boundary: WriteBoundary;
  /**
   * Reads the id of the Business Unit the role belongs to (a read, not a write). AddPrivilegesRole needs it. Null when it could not be
   * read, in which case nothing is sent.
   */
  readonly resolveRoleBusinessUnit: (roleId: string) => Promise<string | null>;
}

function planned(approval: ApprovedPlan, key: string): PlannedWrite | null {
  return approval.plan.writes.find((w) => w.key === key) ?? null;
}

export function createRolePrivilegeWriter(options: RolePrivilegeWriterOptions): RolePrivilegeWriter {
  const { boundary, resolveRoleBusinessUnit } = options;
  return {
    async addPrivilege(approval: ApprovedPlan, roleId: string, privilegeId: string, depth: GrantDepth): Promise<OperationResult> {
      const r = normalizeId(roleId);
      const p = normalizeId(privilegeId);
      const write = planned(approval, `addPrivilege:${r}:${p}:${depth}`);
      if (!write) return refused('validation', 'This change is not part of the confirmed plan.');
      return boundary.run(approval, write, async (calls) => {
        // A read, before the single host call: if the role's Business Unit cannot be read nothing is sent.
        let why = '';
        const businessUnitId = await resolveRoleBusinessUnit(r).catch((e: unknown) => {
          const c = classifyHostError(e);
          why = ` (${c.kind}${c.status === undefined ? '' : ` ${c.status}`}: ${c.message.slice(0, 120)})`;
          return null;
        });
        if (!businessUnitId) throw new WriteBoundaryViolation(`The Business Unit of the role could not be read${why || ' (the read returned no Business Unit)'}.`);
        await calls.execute({
          operationName: 'AddPrivilegesRole',
          operationType: 'action',
          entityName: 'role',
          entityId: r,
          parameters: { Privileges: [{ PrivilegeId: p, Depth: depth, BusinessUnitId: normalizeId(businessUnitId) }] },
        });
      });
    },

    async removePrivilege(approval: ApprovedPlan, roleId: string, privilegeId: string): Promise<OperationResult> {
      const r = normalizeId(roleId);
      const p = normalizeId(privilegeId);
      const write = planned(approval, `removePrivilege:${r}:${p}`);
      if (!write) return refused('validation', 'This change is not part of the confirmed plan.');
      return boundary.run(approval, write, async (calls) => {
        await calls.execute({
          operationName: 'RemovePrivilegeRole',
          operationType: 'action',
          entityName: 'role',
          entityId: r,
          parameters: { Privilege: { '@odata.type': 'Microsoft.Dynamics.CRM.privilege', privilegeid: p } },
        });
      });
    },
  };
}
