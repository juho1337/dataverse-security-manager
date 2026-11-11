import { PRIVILEGE_IDS, type PrivilegeId } from '../../domain/privileges';
import { cellEditProblem, currentDepth, isChanged, originalDepth, type EditSession, type HeldDepth } from '../../domain/roleEditing';
import { DEPTH_COLUMNS, DEPTH_LABEL, describeCell, PRIVILEGE_LABEL } from '../labels';
import { depthText } from './EditPanels';

const NOT_HELD = 'none';
const parse = (v: string): HeldDepth => (v === NOT_HELD ? null : (v as (typeof DEPTH_COLUMNS)[number]));

/**
 * The cells of the role being edited in the Privilege Matrix: one depth choice per privilege, with the original value shown next to a
 * changed one. A privilege that cannot be edited (unknown, or the table has no such privilege) stays a read-only cell that says why.
 */
export function EditableCells({ session, onStage, disabled = false }: { readonly session: EditSession; readonly onStage: (privilege: PrivilegeId, depth: HeldDepth) => void; readonly disabled?: boolean }) {
  return (
    <>
      {PRIVILEGE_IDS.map((p) => {
        const problem = cellEditProblem(session.original[p]);
        if (problem) {
          const c = describeCell(session.original[p]);
          return (
            <td key={p} role="gridcell" className={`cell cell-${c.tone}`} aria-label={`${PRIVILEGE_LABEL[p]}: ${c.text}. Not editable: ${problem}`}>
              <span aria-hidden="true" className="glyph">{c.glyph}</span> {c.text}
            </td>
          );
        }
        const changed = isChanged(session, p);
        const was = originalDepth(session, p);
        return (
          <td key={p} role="gridcell" className={`cell cell-edit${changed ? ' cell-changed' : ''}`}>
            <select
              aria-label={`${PRIVILEGE_LABEL[p]} depth for ${session.role.name}`}
              value={currentDepth(session, p) ?? NOT_HELD}
              disabled={disabled}
              onChange={(e) => onStage(p, parse(e.target.value))}
            >
              <option value={NOT_HELD}>Not held</option>
              {DEPTH_COLUMNS.map((d) => (
                <option key={d} value={d}>{DEPTH_LABEL[d]}</option>
              ))}
            </select>
            {changed && (
              <span className="change-note">
                was {depthText(was)} <span aria-hidden="true">{'✎'}</span>
              </span>
            )}
          </td>
        );
      })}
    </>
  );
}
