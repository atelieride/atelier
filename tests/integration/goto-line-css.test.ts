import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Go to Line is CodeMirror's own dialog: the editor theme (editor/cmTheme.ts) gives it the Aurora look, a frosted
// panel from the tokens, 6px fields and flat buttons, instead of CodeMirror's grey bar and gradient buttons.
const theme = readFileSync(join(__dirname, '../../src/renderer/editor/cmTheme.ts'), 'utf8');

/** The style object of one selector in the EditorView.theme spec, as written. */
function rule(selector: string): string {
  const line = theme.split('\n').find((l) => l.trimStart().startsWith(`'${selector}':`));
  expect(line, selector).toBeDefined();
  return line!.slice(line!.indexOf('{'));
}

test('the Go to Line panel takes its background and colors from the tokens', () => {
  const panel = rule('.cm-panels.cm-panels-bottom');
  expect(panel).toMatch(/backgroundColor: 'var\(--[\w-]+\)'/);
  expect(panel).toMatch(/color: 'var\(--[\w-]+\)'/);
  expect(panel.match(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?)\(/g) ?? []).toEqual([]);
});

test('its field has the 6px radius and its buttons no gradient', () => {
  const field = rule('.cm-textfield');
  expect(field).toContain("borderRadius: '6px'");
  expect(field).toMatch(/backgroundColor: 'var\(--[\w-]+\)'/);
  const button = rule('.cm-button');
  expect(button).toContain("backgroundImage: 'none'");
  expect(button).toContain("borderRadius: '6px'");
  expect(button).toMatch(/backgroundColor: 'var\(--[\w-]+\)'/);
});
