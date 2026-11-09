import { describe, expect, test } from 'vitest';
import { aboutPanelOptions } from './about';

describe('About panel', () => {
  test('the copyright is Atelier\'s, with the author on the line below (as on the website footer)', () => {
    expect(aboutPanelOptions(2026)).toEqual({ copyright: '© 2026 Atelier\nMade by Francesco Musso' });
  });
});
