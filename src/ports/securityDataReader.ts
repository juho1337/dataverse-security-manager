import type { RoleFamily } from '../domain/access';
import type { RoleMatrix, TableInfo } from '../domain/privileges';

export type ErrorClass = 'permission' | 'throttled' | 'network' | 'notFound' | 'unknown';

/** Outcome of a read: complete, partial (usable but incomplete) or failed. Errors are values, not exceptions. */
export type ReadResult<T> =
  | { readonly status: 'ok'; readonly data: T }
  | { readonly status: 'partial'; readonly data: T; readonly notes: readonly string[] }
  | { readonly status: 'error'; readonly errorClass: ErrorClass; readonly message: string };

/** Read-only port. There are deliberately no write methods; writes get their own port later. */
export interface SecurityDataReader {
  listTables(): Promise<ReadResult<readonly TableInfo[]>>;
  loadRoleMatrix(tableLogicalName: string): Promise<ReadResult<RoleMatrix>>;
  /**
   * Business Unit instances of one logical role for a table, with direct users, role-bearing teams and their members.
   * Loaded lazily when a role is expanded. A `partial` result means the numbers derived from it are lower bounds.
   */
  loadRoleDetails(tableLogicalName: string, rootRoleId: string): Promise<ReadResult<RoleFamily>>;
}
