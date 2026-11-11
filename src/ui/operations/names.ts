import type { RestorePlan } from '../../domain/history/restore';

// Names for the ids a restore preview shows. The history stores ids only (never names of people); the names are read when the preview is built,
// shown, and thrown away with it. An id whose name could not be read stays an id (shortened in tables, in full inside a sentence).

/** Display names by lower-case id (users and roles share one map: GUIDs do not collide). */
export type NameMap = ReadonlyMap<string, string>;
export const NO_NAMES: NameMap = new Map();

const GUID_ANYWHERE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Every distinct GUID that appears in the texts, lower-cased. */
export function idsIn(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(GUID_ANYWHERE)) found.add(m[0].toLowerCase());
  return [...found];
}

/** The ids a restore plan mentions: in the descriptions of its writes and in the targets and their states. */
export function planIds(plan: RestorePlan): string[] {
  return idsIn([...plan.writes.map((w) => w.description), ...plan.items.flatMap((i) => [JSON.stringify(i.desired), JSON.stringify(i.current)])]);
}

/**
 * The lower-case ids whose name is shared with another id of the same map. A role exists once per Business Unit copy (and two users can share a
 * name), so “Salesperson” can be two different targets: those keep a short id next to the name, otherwise two different changes would read alike.
 */
function ambiguousIds(names: NameMap): ReadonlySet<string> {
  const byName = new Map<string, string[]>();
  for (const [id, n] of names) byName.set(n, [...(byName.get(n) ?? []), id]);
  return new Set([...byName.values()].filter((ids) => ids.length > 1).flat());
}

function labelOf(id: string, names: NameMap, ambiguous: ReadonlySet<string>): string | null {
  const key = id.toLowerCase();
  const n = names.get(key);
  if (!n) return null;
  return ambiguous.has(key) ? `“${n}” (${key.slice(0, 8)})` : `“${n}”`;
}

/** “Name” when known (with a short id when the name is not unique), otherwise the shortened id. */
export function nameOrShort(id: string, names: NameMap): string {
  return labelOf(id, names, ambiguousIds(names)) ?? id.slice(0, 8);
}

/** A sentence with every known id replaced by its “Name” (with a short id when the name is not unique); an id without a name stays as it is. */
export function humanize(text: string, names: NameMap): string {
  const ambiguous = ambiguousIds(names);
  return text.replace(GUID_ANYWHERE, (id) => labelOf(id, names, ambiguous) ?? id);
}
