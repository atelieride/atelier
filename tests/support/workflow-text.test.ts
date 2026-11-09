import { expect, test } from 'vitest';
import { runScripts } from './workflow-text';

const wf = `jobs:
  a:
    steps:
      - uses: actions/checkout@0000000000000000000000000000000000000000
      - run: echo \${{ github.head_ref }}
      - name: Block
        env:
          X: \${{ github.event_name }}
        run: |
          echo "$X"
          echo two
      - name: Folded
        run: >-
          echo folded
      - name: Inline
        run: npm test
        timeout-minutes: 5
      - name: Dash first
        run: |-
          echo dash
`;

test('every run script, in shorthand, block and inline form, without the step keys around it', () => {
  const s = runScripts(wf);
  expect(s).toEqual([
    'echo ${{ github.head_ref }}',
    'echo "$X"\necho two',
    'echo folded',
    'npm test',
    'echo dash'
  ]);
  // The env block of a step is not part of its script (expressions are allowed there).
  expect(s.join('\n')).not.toContain('github.event_name');
});

test('a run key nested in a step that starts with "- run:" keeps its siblings out', () => {
  expect(runScripts('    steps:\n      - run: |\n          echo a\n        env:\n          Y: 1\n')).toEqual(['echo a']);
});
