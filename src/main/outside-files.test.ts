import { expect, test } from 'vitest';
import { OutsideFiles } from './outside-files';

function setup() {
  let now = 1000;
  const watched: [string, string[]][] = [];
  const o = new OutsideFiles((root, files) => watched.push([root, [...files].sort()]), () => now, 3000);
  return { o, watched, at: (t: number) => { now = t; } };
}

test('opened files are watched at once; the tabs report then says what is open', () => {
  const { o, watched, at } = setup();
  o.opened('/p', ['/h/a.json']);
  expect(watched.at(-1)).toEqual(['/p', ['/h/a.json']]);
  at(5000);
  o.reported('/p', ['/h/b.json']);
  expect([...o.get('/p')]).toEqual(['/h/b.json']);
  expect(watched.at(-1)).toEqual(['/p', ['/h/b.json']]);
});

test('a report sent before a file opened (still in flight) does not drop it', () => {
  const { o, watched, at } = setup();
  o.opened('/p', ['/h/a.json']);
  at(1500);
  o.reported('/p', []);
  expect([...o.get('/p')]).toEqual(['/h/a.json']);
  expect(watched.at(-1)).toEqual(['/p', ['/h/a.json']]);
});

test('closing the project forgets it', () => {
  const { o } = setup();
  o.opened('/p', ['/h/a.json']);
  o.close('/p');
  expect([...o.get('/p')]).toEqual([]);
});
