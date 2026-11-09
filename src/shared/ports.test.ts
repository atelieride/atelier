import { expect, test } from 'vitest';
import { EPHEMERAL_MIN, chipPorts, isEphemeralPort, portUrl, visiblePorts } from './ports';

test('chips: the first two ports, the rest folded into +N', () => {
  const l = [{ port: 3000, name: 'node' }, { port: 5173 }, { port: 8080 }, { port: 9229, name: 'node' }];
  expect(chipPorts(l)).toEqual({ shown: [{ port: 3000, name: 'node' }, { port: 5173 }], rest: [{ port: 8080 }, { port: 9229, name: 'node' }] });
  expect(chipPorts([{ port: 1 }])).toEqual({ shown: [{ port: 1 }], rest: [] });
  expect(chipPorts([])).toEqual({ shown: [], rest: [] });
});

test('a port opens on localhost', () => {
  expect(portUrl(3000)).toBe('http://localhost:3000/');
});

test('ephemeral ports (49152-65535) are hidden unless asked', () => {
  const l = [{ port: 3000 }, { port: 49151 }, { port: 49152 }, { port: 64570, name: 'node' }];
  expect(isEphemeralPort(49151)).toBe(false);
  expect(isEphemeralPort(49152)).toBe(true);
  expect(EPHEMERAL_MIN).toBe(49152);
  expect(visiblePorts(l, false)).toEqual([{ port: 3000 }, { port: 49151 }]);
  expect(visiblePorts(l, true)).toEqual(l);
});
