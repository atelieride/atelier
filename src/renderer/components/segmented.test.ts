import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Segmented } from './Segmented';

// The segmented control Settings and the Databases sheet share: a radio group with one Tab stop.

const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Segmented, {
  label: 'Times in', value: 'utc', onChange: () => {},
  options: [{ value: 'local', label: 'Local' }, { value: 'utc', label: 'UTC' }], ...props
} as Parameters<typeof Segmented>[0]));

test('Settings\' look as it was: a radio group, the picked option the one Tab stop, plain labels', () => {
  expect(html({})).toBe(
    '<div class="set-seg" role="radiogroup" aria-label="Times in">'
    + '<button type="button" role="radio" aria-checked="false" tabindex="-1" data-value="local" class="set-seg-opt">Local</button>'
    + '<button type="button" role="radio" aria-checked="true" tabindex="0" data-value="utc" class="set-seg-opt is-on">UTC</button></div>'
  );
});

test('disabled: the group says so and no option can be pressed', () => {
  const out = html({ disabled: true });
  expect(out).toContain('aria-disabled="true"');
  expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
});

test('what the sheet adds: a class for the group, one per option, a dot, a tooltip, labels that ellipsize in a span', () => {
  const out = html({
    className: 'db-seg is-fill', labelClass: 'db-seg-label',
    options: [{ value: 'local', label: 'Local', dot: 'db-seg-dot is-local' }, { value: 'utc', label: 'UTC', cls: 'is-prod', tip: 'Coordinated' }]
  });
  expect(out).toContain('<div class="set-seg db-seg is-fill" role="radiogroup"');
  expect(out).toContain('<i class="db-seg-dot is-local" aria-hidden="true"></i><span class="db-seg-label">Local</span>');
  expect(out).toMatch(/class="set-seg-opt is-prod is-on" data-tip="Coordinated"><span class="db-seg-label">UTC<\/span>/);
});
