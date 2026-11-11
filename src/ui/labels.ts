import type { Origin } from '../domain/access';
import type { CellValue, DepthId, PrivilegeId } from '../domain/privileges';

// Display labels are mapped here only; the domain and the shared contract use the canonical ids.

export const DEPTH_LABEL: Readonly<Record<DepthId, string>> = {
  None: 'None',
  Basic: 'User',
  Local: 'Business Unit',
  Deep: 'Parent: Child BU',
  Global: 'Organization',
};

/** Ring-fill glyph per depth (supplements the text, never replaces it). */
export const DEPTH_GLYPH: Readonly<Record<DepthId, string>> = {
  None: '○',
  Basic: '◔',
  Local: '◑',
  Deep: '◕',
  Global: '●',
};

export const PRIVILEGE_LABEL: Readonly<Record<PrivilegeId, string>> = {
  Create: 'Create',
  Read: 'Read',
  Write: 'Write',
  Delete: 'Delete',
  Append: 'Append',
  AppendTo: 'Append To',
  Assign: 'Assign',
  Share: 'Share',
};

/** Single-letter abbreviations for the Depth Matrix (each letter also has its full name in the accessible label). */
export const PRIVILEGE_LETTER: Readonly<Record<PrivilegeId, string>> = {
  Create: 'C',
  Read: 'R',
  Write: 'W',
  Delete: 'D',
  Append: 'A',
  AppendTo: 'T',
  Assign: 'S',
  Share: 'H',
};

/** The four depth columns of the Depth Matrix, lowest to highest (`None` is the absence of a grant, not a column). */
export const DEPTH_COLUMNS = ['Basic', 'Local', 'Deep', 'Global'] as const satisfies readonly DepthId[];
export type DepthColumn = (typeof DEPTH_COLUMNS)[number];

export const NOT_COUNTED_LABEL = {
  Disabled: 'Disabled user, not counted',
  ApplicationUser: 'Application user, not counted',
  Unresolved: 'Unknown user, not counted',
} as const;

/** Origin badge text: how a person reaches a role instance. */
export function describeOrigin(o: Origin): string {
  switch (o.kind) {
    case 'direct':
      return 'Direct';
    case 'viaTeams':
      return o.teams.length > 1 ? `Via ${o.teams.length} teams` : `Via team ${o.teams[0] ?? ''}`.trim();
    case 'both':
      return 'Direct + via team';
    case 'notCounted':
      return NOT_COUNTED_LABEL[o.reason];
  }
}

export interface CellDisplay {
  readonly glyph: string;
  readonly text: string;
  /** CSS modifier, for styling only (information is always also in the text). */
  readonly tone: 'depth' | 'none' | 'nogrant' | 'na' | 'unknown';
}

export function describeCell(cell: CellValue): CellDisplay {
  switch (cell.kind) {
    case 'depth':
      return { glyph: DEPTH_GLYPH[cell.depth], text: DEPTH_LABEL[cell.depth], tone: cell.depth === 'None' ? 'none' : 'depth' };
    case 'noGrant':
      return { glyph: '–', text: 'No grant', tone: 'nogrant' };
    case 'notApplicable':
      return { glyph: '⊘', text: 'n/a', tone: 'na' };
    case 'unknown':
      return { glyph: '?', text: 'Unknown', tone: 'unknown' };
  }
}
