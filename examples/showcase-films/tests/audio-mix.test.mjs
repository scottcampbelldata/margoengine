// Regression (KB-FILM-MIXIMPORT1): mix.mjs imported createMix and peakDb from examples/demo-audio/mix.mjs, a module
// that never reached main, so no showcase soundtrack could be built. Every relative import of the films' scripts must
// resolve, and the mix bus must write a correct WAV.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMix, peakDb } from '../audio-mix.mjs';

const folder = new URL('../', import.meta.url);

test('every relative import of the showcase film scripts resolves', () => {
  const scripts = readdirSync(folder).filter((name) => /\.(mjs|js)$/.test(name));
  assert.ok(scripts.includes('mix.mjs'));
  for (const name of scripts) {
    const text = readFileSync(new URL(name, folder), 'utf8');
    for (const [, path] of text.matchAll(/(?:import|from)\s*\(?\s*'(\.{1,2}\/[^']+)'/g))
      assert.ok(existsSync(fileURLToPath(new URL(path, new URL(name, folder)))), `${name} imports missing ${path}`);
  }
});

test('the mix bus places, pans, fades and holds the peak at -2 dBFS', () => {
  const tone = new Float32Array(2 * 48_000).map((_, i) => 0.5 * Math.sin((i >> 1) * 0.05));
  const source = { samples: tone, channels: 2 };
  assert.ok(Math.abs(peakDb(source, 0, 1) - 20 * Math.log10(0.5)) < 0.01);
  const mix = createMix(2);
  mix.place(source, { at: 0.5, length: 1, gain: 6, pan: 1, fadeIn: 0.1 }); // over full scale, so the bus lowers it
  const bytes = mix.wav();
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(40), 2 * 48_000 * 4);
  let left = 0,
    right = 0;
  for (let i = 0; i < 2 * 48_000 * 2; i += 2) {
    left = Math.max(left, Math.abs(bytes.readInt16LE(44 + i * 2)));
    right = Math.max(right, Math.abs(bytes.readInt16LE(46 + i * 2)));
  }
  assert.equal(left, 0, 'Hard right: nothing on the left');
  assert.ok(Math.abs(right - Math.round(32767 * 10 ** (-2 / 20))) <= 1, `peak ${right}`);
  assert.equal(bytes.readInt16LE(44 + 4 * 1000), 0, 'Silence before the cue');
  assert.throws(() => mix.place(source, { at: 0, length: 1, gain: NaN }), RangeError);
});
