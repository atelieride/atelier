// A Find in Files result's match, selected in its editor for the user rather than by them: the selection's user event
// and the field that remembers it while it is still the selection.
import { StateField, type SelectionRange } from '@codemirror/state';

/**
 * The user event of a selection made for the user rather than by them (a Find in Files result's match): it counts as
 * settled, with no "Comment" button until the user changes it.
 */
export const RESULT_SELECT = 'select.result';

/**
 * The match a result selected, while it is still the selection (moved along by edits); null once the selection is
 * the user's. ⌘⇧F then keeps the query that found it rather than starting from the match.
 */
export const resultSelection = StateField.define<SelectionRange | null>({
  create: () => null,
  update: (v, tr) => {
    if (tr.isUserEvent(RESULT_SELECT)) return tr.state.selection.main.empty ? null : tr.state.selection.main;
    if (!v) return v;
    // The same selection set again (the editor reading back the page's) is no change of the user's.
    if (tr.selection && !tr.state.selection.main.eq(tr.startState.selection.main)) return null;
    return tr.docChanged ? v.map(tr.changes) : v;
  }
});
