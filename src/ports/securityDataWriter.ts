import type { ApprovedPlan, GrantDepth, OperationResult } from '../domain/operations';

/**
 * The only writes the Security Manager can make. A separate port from `SecurityDataReader` so analysis code never receives
 * a write path. Every call needs an `ApprovedPlan` that contains exactly that change. A call returns `notVerified` when
 * Dataverse accepted it: confirming the end state is the caller's re-read, never this port's claim.
 */
export interface SecurityDataWriter {
  addPrivilege(approval: ApprovedPlan, roleId: string, privilegeId: string, depth: GrantDepth): Promise<OperationResult>;
  removePrivilege(approval: ApprovedPlan, roleId: string, privilegeId: string): Promise<OperationResult>;
  assignRole(approval: ApprovedPlan, userId: string, roleId: string): Promise<OperationResult>;
  unassignRole(approval: ApprovedPlan, userId: string, roleId: string): Promise<OperationResult>;
  moveUser(approval: ApprovedPlan, userId: string, targetBusinessUnitId: string): Promise<OperationResult>;
}
