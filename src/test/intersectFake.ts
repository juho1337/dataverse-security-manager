// Test fakes behave like the real PPTB host for many-to-many (intersect) tables (verified on the real host 2026-11-03): a fetch ROOTED at an
// intersect table is a 404; the same rows are read from a parent table through `<link-entity ... alias="x" intersect="true">`, and each row then
// carries the parent key as a plain column and the linked column as `alias.column`.
type Row = Record<string, unknown>;

const ROOT_INTERSECTS = new Set(['systemuserroles', 'teamroles', 'teammembership', 'roleprivileges']);

export interface IntersectLink {
  /** The intersect table whose rows are served. */
  readonly table: string;
  readonly alias: string;
  readonly column: string;
  /** The parent key column that is also a plain column of each result row. */
  readonly parentKey: string;
}

/** Throws the host's 404 when a fetch is rooted at an intersect table. */
export function rejectRootIntersect(rootEntity: string): void {
  if (ROOT_INTERSECTS.has(rootEntity)) {
    throw Object.assign(new Error(`Resource not found for the segment '${rootEntity}'.`), { status: 404 });
  }
}

/** The intersect link of a fetch rooted at systemuser or team, when it has one. */
export function intersectLink(fetchXml: string, rootEntity: string): IntersectLink | null {
  const m = /<link-entity name="(systemuserroles|teamroles|teammembership)"[^>]*alias="(\w+)"[^>]*intersect="true"[^>]*><attribute name="(\w+)"\/>/.exec(fetchXml);
  if (!m || (rootEntity !== 'systemuser' && rootEntity !== 'team')) return null;
  return { table: m[1] ?? '', alias: m[2] ?? '', column: m[3] ?? '', parentKey: rootEntity === 'systemuser' ? 'systemuserid' : 'teamid' };
}

export function shapeIntersectRow(row: Row, link: IntersectLink): Row {
  return { [link.parentKey]: row[link.parentKey], [`${link.alias}.${link.column}`]: row[link.column] };
}
