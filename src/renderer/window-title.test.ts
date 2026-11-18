import { describe, expect, it } from 'vitest';
import { windowTitle } from './window-title';

describe('windowTitle', () => {
  it('names the window after its selected session, then the project', () => {
    expect(windowTitle('Fix login', 'shop')).toBe('Fix login — shop');
  });
  it('is the project alone while no session is selected', () => {
    expect(windowTitle('', 'shop')).toBe('shop');
  });
  it('is the app name without a project', () => {
    expect(windowTitle('', '')).toBe('Atelier');
  });
});
