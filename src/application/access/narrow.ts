// Narrowing of search results by Business Unit name, on what the search already returned (up to SEARCH_LIMIT rows per kind).
// A hit whose Business Unit could not be read is KEPT and counted: an unreadable Business Unit is not evidence that it differs.

export interface Narrowed<T> {
  readonly shown: readonly T[];
  /** Hits kept although their Business Unit name is unknown. */
  readonly unknownKept: number;
  readonly hidden: number;
}

export function narrowByBusinessUnit<T>(hits: readonly T[], businessUnitName: (hit: T) => string | null, text: string): Narrowed<T> {
  const needle = text.trim().toLowerCase();
  if (!needle) return { shown: hits, unknownKept: 0, hidden: 0 };
  const shown: T[] = [];
  let unknownKept = 0;
  for (const h of hits) {
    const name = businessUnitName(h);
    if (name === null) {
      unknownKept++;
      shown.push(h);
    } else if (name.toLowerCase().includes(needle)) shown.push(h);
  }
  return { shown, unknownKept, hidden: hits.length - shown.length };
}
