import { EditorView } from '@codemirror/view';
import { stableWidth } from './widest';

/** A code line's padding, left and right: the content's min-width counts it. */
const LINE_PAD = { left: 6, right: 20 };

// The editor in the theme's colors (its --editor-* tokens): workspace background, accent selection, a cited line that
// lights up and then settles. The code is as wide as its widest line from the start (widest.ts).
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-2)', color: 'var(--editor-fg)', fontSize: 'var(--editor-font-size, 13px)' },
  '.cm-scroller': { fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontVariantLigatures: 'none', lineHeight: 'var(--editor-line-height, 21px)', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2)', border: 'none', color: 'var(--editor-gutter)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '44px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-content': { caretColor: 'var(--editor-caret)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--editor-caret)', borderLeftWidth: '2px' },
  '.cm-line': { padding: `0 ${LINE_PAD.right}px 0 ${LINE_PAD.left}px` },
  // The editor's monospace columns: without wrapping, the horizontal scrollbar never comes and goes while scrolling.
  '.cm-content:not(.cm-lineWrapping)': { minWidth: `calc(var(--cm-widest, 0) * 1ch + ${LINE_PAD.left + LINE_PAD.right}px)` },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-sel) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--editor-sel-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--editor-bracket)', outline: '1px solid var(--editor-bracket-edge)' },
  '.cm-target-line': { animation: 'atl-fade-target 1.2s cubic-bezier(.2,.8,.2,1) both' },
  // Find: the terminal triggers' amber; the selected match ringed.
  '.cm-searchMatch': { backgroundColor: 'var(--hit-bg)', borderRadius: '3px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--hit-strong)', boxShadow: '0 0 0 1px var(--hit-edge)' },
  // The find card floats over the code, top right (find/FindCard.tsx); the layer itself lets clicks through.
  '.cm-panels.cm-panels-top': { position: 'absolute', top: '8px', left: '8px', right: '22px', backgroundColor: 'transparent', border: 'none', pointerEvents: 'none', containerType: 'inline-size' },
  // Go to Line (CodeMirror's dialog, at the bottom): a frosted bar with Aurora fields and buttons.
  '.cm-panels.cm-panels-bottom': { backgroundColor: 'var(--bg-float-strong)', color: 'var(--text)', borderTop: '1px solid var(--line-strong)', backdropFilter: 'blur(18px)' },
  '.cm-dialog': { padding: '7px 32px 7px 12px', fontFamily: 'var(--font)', fontSize: '12px' },
  '.cm-dialog label': { fontSize: '12px', color: 'var(--text-3)' },
  '.cm-textfield': { backgroundColor: 'var(--bg-field)', border: '1px solid var(--line-strong)', borderRadius: '6px', color: 'var(--text)', padding: '3px 7px', font: '12px var(--mono)', margin: '0 8px 0 6px' },
  '.cm-textfield:focus': { borderColor: 'var(--violet)', outline: 'none', boxShadow: '0 0 0 3px var(--tint-violet)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--bg-3)', border: '1px solid var(--line-strong)', borderRadius: '6px', color: 'var(--text-2)', padding: '3px 10px', font: '500 12px var(--font)' },
  '.cm-button:hover': { backgroundColor: 'var(--tint-violet)', color: 'var(--text)' },
  '.cm-dialog-close': { color: 'var(--text-3)', top: '6px', right: '10px', fontSize: '16px', cursor: 'pointer' },
  '.cm-dialog-close:hover': { color: 'var(--text)' },
  '.cm-git-gutter': { width: '4px' },
  '.cm-git-gutter .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'stretch' },
  '.cm-git-add': { display: 'block', width: '3px', borderRadius: '2px', background: 'var(--done)', boxShadow: '0 0 6px color-mix(in srgb, var(--done) 50%, transparent)' },
  '.cm-git-mod': { display: 'block', width: '3px', borderRadius: '2px', background: 'var(--working)', boxShadow: '0 0 6px color-mix(in srgb, var(--working) 50%, transparent)' },
  '.cm-git-del': { display: 'block', width: '0', height: '0', borderLeft: '5px solid var(--error)', borderTop: '4px solid transparent', borderBottom: '4px solid transparent', marginTop: '-4px' },
  // The Diff view: rows tinted, their numbers and signs a step fuller, changed words fuller still.
  '.cm-diff-add': { backgroundColor: 'var(--editor-diff-add)' },
  '.cm-diff-del': { backgroundColor: 'var(--editor-diff-del)' },
  '.cm-gutterElement.cm-diff-gadd': { backgroundColor: 'var(--editor-diff-add-gutter)' },
  '.cm-gutterElement.cm-diff-gdel': { backgroundColor: 'var(--editor-diff-del-gutter)' },
  '.cm-diff-word-add': { backgroundColor: 'var(--editor-diff-add-word)', borderRadius: '2px' },
  '.cm-diff-word-del': { backgroundColor: 'var(--editor-diff-del-word)', borderRadius: '2px' },
  '.cm-diff-numbers .cm-gutterElement': { padding: '0 10px 0 16px', minWidth: '44px', textAlign: 'right' },
  '.cm-diff-signs .cm-gutterElement': { width: '16px' },
  // Line comments: the "Comment" button at the selection carries its own look; the marker column stays narrow.
  // CodeMirror puts .cm-tooltip on the button itself, so the reset of its tooltip chrome (and its dark base theme's
  // white text) would outrank .lc-tip: the button's fill and text are set here, one step more specific.
  '.cm-tooltip': { border: 'none', backgroundColor: 'transparent' },
  '.cm-tooltip.lc-tip': { backgroundColor: 'var(--brand)', color: 'var(--on-brand)' },
  '.cm-comment-gutter': { width: '12px' },
  '.cm-comment-gutter .cm-gutterElement': { padding: '0' },
  '.cm-diff-plus': { color: 'var(--done)' },
  '.cm-diff-minus': { color: 'var(--error)' }
}, { dark: true });

export const cmTheme = [theme, stableWidth];
