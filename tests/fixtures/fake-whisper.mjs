#!/usr/bin/env node
// Fake atelier-whisper for tests: same protocol (see native/atelier-whisper.cpp), predictable text.
// FAKE_WHISPER_TEXT: text to return (otherwise "lang=<l> n=<samples> prompt=<p>").
// FAKE_WHISPER_NOSPEECH: no-speech probability to return (default 0).
// FAKE_WHISPER_SEGMENTS: JSON of segments [{text, noSpeech}] to return instead of a single one.
// FAKE_WHISPER_CRASH_ONCE=<file>: on the first audio, if the file does not exist, creates it and exits (to test the restart).
// FAKE_WHISPER_CRASH_ALWAYS=1: exits on every audio.
// FAKE_WHISPER_DELAY_MS: response delay (to test Esc during transcription).
// FAKE_WHISPER_CRASH_UNTIL=<file>,<n>: exits on the first n audios (counter in the file), then answers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (!process.argv.includes('--model')) { out({ error: 'missing --model' }); process.exit(1); }
out({ ready: true, ms: 1 });
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 9) return;
    if (buf.toString('latin1', 0, 4) !== 'AWR1') process.exit(2);
    const id = buf.readUInt32LE(4); const ll = buf.readUInt8(8);
    if (buf.length < 9 + ll + 4) return;
    const lang = buf.toString('utf8', 9, 9 + ll); const pl = buf.readUInt32LE(9 + ll);
    if (buf.length < 13 + ll + pl + 4) return;
    const prompt = buf.toString('utf8', 13 + ll, 13 + ll + pl); const n = buf.readUInt32LE(13 + ll + pl);
    const end = 17 + ll + pl + n * 2;
    if (buf.length < end) return;
    buf = buf.subarray(end);
    const once = process.env.FAKE_WHISPER_CRASH_ONCE;
    if (process.env.FAKE_WHISPER_CRASH_ALWAYS === '1') process.exit(3);
    if (once && !existsSync(once)) { writeFileSync(once, 'x'); process.exit(3); }
    const until = process.env.FAKE_WHISPER_CRASH_UNTIL;
    if (until) {
      const [file, n] = until.split(',');
      const count = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
      if (count < Number(n)) { writeFileSync(file, String(count + 1)); process.exit(3); }
    }
    const text = process.env.FAKE_WHISPER_TEXT ?? `lang=${lang} n=${n} prompt=${prompt}`;
    const noSpeech = Number(process.env.FAKE_WHISPER_NOSPEECH ?? 0);
    const segments = process.env.FAKE_WHISPER_SEGMENTS ? JSON.parse(process.env.FAKE_WHISPER_SEGMENTS) : [{ text, noSpeech }];
    const delay = Number(process.env.FAKE_WHISPER_DELAY_MS ?? 0);
    const reply = () => out({ id, text: segments.map((s) => s.text).join(''), noSpeech, segments, language: lang || 'it', ms: 1 });
    if (delay) setTimeout(reply, delay); else reply();
  }
});
process.stdin.on('end', () => process.exit(0));
