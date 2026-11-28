// KB4000: the inverse of the PBR Neutral display curve (shared/display.js), which gltf's screen-space transmission uses
// to read a display-encoded scene as light. It must undo pbrNeutral for every output below display white, map display
// white to the least light the 8-bit display shows as 255, and its WGSL twin must use the same white.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pbrNeutral } from '../packages/shared/display.js';
import { neutralInverseShader, neutralWhite, pbrNeutralInverse } from '../packages/shared/display-inverse.js';
import { bundleBytes } from '../scripts/measure-size.js';

const encode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
const top = 1 - (0.24 * 0.24) / (neutralWhite - 0.56);

test('pbrNeutralInverse undoes pbrNeutral below display white', () => {
  let seed = 7;
  const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 2147483648) ** 3 * 8;
  let worst = 0;
  for (let k = 0; k < 20000; k++) {
    const c = [next(), next(), next()],
      o = pbrNeutral(c);
    if (Math.max(...o) >= top) continue;
    const r = pbrNeutralInverse(o);
    for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(r[i] - c[i]) / Math.max(c[i], 1e-3));
  }
  assert.ok(worst < 1e-3, `worst relative error ${worst}`);
  // Through every branch: blacks (offset below 0.08), mid tones and the roll-off.
  for (const c of [
    [0, 0, 0],
    [0.01, 0.02, 0.05],
    [0.3, 0.5, 0.2],
    [0.9, 0.4, 0.1],
    [3, 2, 1],
  ]) {
    const r = pbrNeutralInverse(pbrNeutral(c));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(r[i] - c[i]) < 1e-6, `${c} -> ${r}`);
  }
});

test('display white reads as the least light the display shows as 255', () => {
  // neutralWhite sits on the 254.5 rounding boundary by construction.
  const at = 255 * encode(Math.max(...pbrNeutral([neutralWhite, neutralWhite, neutralWhite])));
  assert.ok(Math.abs(at - 254.5) < 1e-9, `${at}`);
  const below = neutralWhite - 0.05;
  assert.ok(Math.round(255 * encode(Math.max(...pbrNeutral([below, below, below])))) < 255);
  const white = pbrNeutralInverse([1, 1, 1]);
  for (const v of white) assert.ok(Math.abs(v - neutralWhite) < 1e-9, `${v}`);
  // Hues keep their ratios above white too (the same scale on every channel).
  const r = pbrNeutralInverse([1.2, 0.6, 0.3]);
  assert.ok(r[0] > r[1] && r[1] > r[2]);
});

test('the WGSL twin uses the same display white', () => {
  const constant = Number(/let top=([\d.e-]+);/.exec(neutralInverseShader)[1]);
  assert.ok(Math.abs(constant - top) < 1e-12, `${constant} vs ${top}`);
});

// KB-SIZE-DISPLAYINV1: the inverse lived in display.js, and its constants, computed at load, stayed in every bundle that
// imported anything from that module (+51 B gzip in each sky cloud entry, which never reads a display target).
test('a bundle that uses the forward display curve carries nothing of the inverse', async (t) => {
  const dir = mkdtempSync(resolve(import.meta.dirname, '.display-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.js'),
    target = relative(dir, resolve(import.meta.dirname, '../packages/shared/display.js'))
      .split(sep)
      .join('/');
  writeFileSync(entry, `export { displayShader } from '${target}';`);
  const code = String(await bundleBytes(entry, () => false));
  assert.match(code, /fn toDisplay/);
  assert.doesNotMatch(code, /254\.5|pbrNeutralInverse|\.0576/);
});
