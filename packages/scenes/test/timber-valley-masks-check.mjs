// Real-GPU check of the timber valley's look masks on the rail-line shot (KB-LOOK-MASKOCCLUDE1, KB-LOOK-MASKTIE1): the
// page's SceneTargets masks (@margoengine/post/mrt) draw the terrain and the biome view's plants, trees and snags as
// not ground, so `plants` (1 - t.ground) and the ground masks `lit` (litGround) and `shadow` (shadedGround) never mark
// the same sample. After the shot tool's area filter (supersample 2) they must still never both read inside (128 and
// above) on one pixel, and each must cover the share of the frame the rail line shows. Renders the first 1.1 s once
// (probes early and mid) with the asset library the shot names. Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs 1500 -- node packages/scenes/test/timber-valley-masks-check.mjs
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { firstSeconds, parseShot } from '../../../tools/shot/shot-file.mjs';
import { shoot } from '../../../tools/shot/render.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const MASKS = ['lit', 'shadow', 'plants', 'penumbra'];
// Percent of the frame each mask covers on each probe, about the figures measured after KB-LOOK-MASKTIE1 (2026-11-26,
// blowup: lit 41.96 and 43.12, shadow 0.38 and 0.44, plants 33.33 and 32.04 early and mid) with room for another GPU's
// rasterisation of the plants' edges. A mask that loses its objects (plants left out of the capture: plants near 0, lit
// near 75) or its shadows (shadow 0) falls outside.
const BOUNDS = {
  lit: [39, 46],
  shadow: [0.2, 0.7],
  plants: [29, 36],
};
const file = parseShot(
  firstSeconds(JSON.parse(readFileSync('tools/shot/shots/timber-valley-rail-line.json', 'utf8')), 1.1),
);
const out = join(root, 'test-results', 'shots', 'timber-valley-masks-check');
rmSync(out, { recursive: true, force: true });
const manifest = await shoot(file, { out, runs: 1, log: () => {} });
const lines = [];
for (const [probe, record] of Object.entries(manifest.probes)) {
  for (const name of MASKS) assert.ok(record.aovs?.[name], `probe ${probe} has the ${name} mask`);
  const masks = Object.fromEntries(
    await Promise.all(MASKS.map(async (name) => [name, await decodePNG(readFileSync(join(out, record.aovs[name])))])),
  );
  const { width, height } = masks.lit,
    count = width * height,
    on = (name, i) => masks[name].data[i * 4] >= 128,
    seen = { lit: 0, shadow: 0, plants: 0 },
    both = { 'lit and plants': 0, 'shadow and plants': 0, 'lit and shadow': 0 };
  for (let i = 0; i < count; i++) {
    const lit = on('lit', i),
      shadow = on('shadow', i),
      plants = on('plants', i);
    if (lit) seen.lit++;
    if (shadow) seen.shadow++;
    if (plants) seen.plants++;
    if (lit && plants) both['lit and plants']++;
    if (shadow && plants) both['shadow and plants']++;
    if (lit && shadow) both['lit and shadow']++;
  }
  for (const [pair, n] of Object.entries(both)) assert.equal(n, 0, `probe ${probe}: ${n} pixels are both ${pair}`);
  const percent = Object.fromEntries(Object.entries(seen).map(([name, n]) => [name, (100 * n) / count]));
  for (const [name, [low, high]] of Object.entries(BOUNDS))
    assert.ok(
      percent[name] >= low && percent[name] <= high,
      `probe ${probe}: ${name} covers ${percent[name].toFixed(2)} percent of the frame (bound ${low} to ${high})`,
    );
  lines.push(
    `${probe} ${Object.entries(percent)
      .map(([n, p]) => `${n} ${p.toFixed(2)}%`)
      .join(', ')}`,
  );
}
assert.ok(lines.length >= 2, 'the early and mid probes rendered');
console.log(`ok timber-valley masks disjoint: ${lines.join('; ')}`);
