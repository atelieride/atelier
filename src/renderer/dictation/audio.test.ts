import { expect, test } from 'vitest';
import { downsample, level, trimSilence } from './audio';

test('48 kHz to 16 kHz: a third of the samples, averaged per window, 16-bit with clamping', () => {
  const input = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1, 2, 2, 2]);
  const out = downsample(input, 48000);
  expect(Array.from(out)).toEqual([9830, 32767, -32768, 32767]);
});

test('16 kHz stays 16 kHz', () => {
  expect(downsample(new Float32Array([0.5, -0.5]), 16000).length).toBe(2);
});

const tone = (n: number, amp: number) => Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin(i / 3)));

test('pure silence: no speech', () => {
  expect(trimSilence(new Int16Array(16000)).speech).toBe(false);
  expect(trimSilence(tone(16000, 200)).speech).toBe(false);
});

test('silence + voice + silence: keeps the voice with a 200 ms margin', () => {
  const pcm = new Int16Array(48000);
  pcm.set(tone(8000, 8000), 16000);  // a voice between 1 s and 1.5 s
  const r = trimSilence(pcm);
  expect(r.speech).toBe(true);
  expect(r.pcm.length).toBeGreaterThanOrEqual(8000 + 2 * 3200 - 320);
  expect(r.pcm.length).toBeLessThanOrEqual(8000 + 2 * 3200 + 640);
});

test('level: 0 in silence, high with a strong signal, never above 1', () => {
  expect(level(new Float32Array(128))).toBe(0);
  expect(level(new Float32Array(128).fill(0.5))).toBeGreaterThan(0.6);
  expect(level(new Float32Array(128).fill(5))).toBe(1);
});
