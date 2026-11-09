import { createElement, isValidElement, type ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { rendererError } from '../error-report';

// No DOM in unit tests: the boundary is driven by hand (React calls the same methods), and FileView's layout is read
// from its source. tests/e2e/error-boundary.spec.ts throws in a real JSON tree.

type Props = ConstructorParameters<typeof ErrorBoundary>[0];
const boundary = (props: Omit<Props, 'children'>) => {
  const b = new ErrorBoundary({ ...props, children: createElement('div') });
  b.setState = ((s: object) => { b.state = { ...b.state, ...s }; }) as typeof b.setState;
  return b;
};
const crash = (b: ErrorBoundary) => {
  b.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
};

describe('a boundary inside a panel', () => {
  test('quiet: a crumb that throws leaves nothing in its place', () => {
    const b = boundary({ id: 'json-path', panel: 'the JSON path', quiet: true });
    crash(b);
    expect(b.render()).toBeNull();
  });

  test('a pane shows the crash card with its own body, and tells its owner (who drops the pane\'s handle)', () => {
    const onCatch = vi.fn();
    const report = vi.fn();
    vi.stubGlobal('window', { atelier: { logError: report } });
    try {
      const b = boundary({ id: 'json-tree', panel: 'the tree', body: 'Your text is safe in Source.', onCatch });
      crash(b);
      const el = b.render() as ReactElement<{ body?: string; panel: string }>;
      expect(isValidElement(el)).toBe(true);
      expect(el.props.panel).toBe('the tree');
      expect(el.props.body).toBe('Your text is safe in Source.');
      b.componentDidCatch(new Error('boom'), { componentStack: '' });
      expect(onCatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('without the new props a boundary renders the card as before', () => {
    const b = boundary({ id: 'editor', panel: 'the editor' });
    b.state = { error: rendererError('boundary', new Error('boom')) };
    const el = b.render() as ReactElement<{ body?: string }>;
    expect(el.props.body).toBeUndefined();
  });
});

