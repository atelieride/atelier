import { expect, test } from 'vitest';
import { BEACON_SRC, beaconTag } from '../../src/lib/analytics';
import { disallowedLoads } from '../support/external-loads';

// The dist guard allows exactly the beacon tag, and nothing else from outside.
const site = 'https://useatelier.dev';
const token = '0123456789abcdef0123456789abcdef';
const beacon = beaconTag(token, true);

test('the beacon tag with the site token passes', () => {
  expect(disallowedLoads(`<head>${beacon}</head>`, site, beacon)).toEqual([]);
});

test('another external script still fails, with or without the beacon on the page', () => {
  const other = '<script src="https://cdn.example.com/x.js"></script>';
  expect(disallowedLoads(`${beacon}${other}`, site, beacon)).toEqual(['https://cdn.example.com/x.js']);
  expect(disallowedLoads(other, site, '')).toEqual(['https://cdn.example.com/x.js']);
});

test('the beacon URL in any other form fails: another token, no defer, as an image, or with no beacon expected', () => {
  const other = beaconTag('f'.repeat(32), true);
  expect(disallowedLoads(other, site, beacon)).toEqual([BEACON_SRC]);
  expect(disallowedLoads(`<script src="${BEACON_SRC}"></script>`, site, beacon)).toEqual([BEACON_SRC]);
  expect(disallowedLoads(`<img src="${BEACON_SRC}">`, site, beacon)).toEqual([BEACON_SRC]);
  expect(disallowedLoads(beacon, site, '')).toEqual([BEACON_SRC]);
});
