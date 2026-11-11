/**
 * Dataverse stores `parentrootroleid` on EVERY role: a root role points at itself and a Business Unit copy points at its root (verified on the
 * real Developer environment, 2026-11-03: 124 roots referencing themselves, 242 copies, none null). The domain convention is `null` = root,
 * so a role that names itself as its root is normalized to null here, at the adapter boundary.
 */
export function normalizeParentRoot(roleId: string, parentRoot: string | null): string | null {
  return parentRoot !== null && parentRoot.toLowerCase() === roleId.toLowerCase() ? null : parentRoot;
}
