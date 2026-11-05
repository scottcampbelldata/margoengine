// The worlds whose digests tests/golden/multinoise.json pins (multinoise.test.js builds them; the file is written by
// running this module: node tests/multinoise-cases.mjs --write).
import { writeFileSync } from 'node:fs';
import { BiomeWorld } from '../dist/index.js';
import { presets } from '../dist/presets.js';
import { multiNoise, multiNoisePresets } from '../dist/multinoise.js';

const biomes = Object.values(presets);

/** The worlds: each preset spec at two seeds, hard (blend 0) and smooth, on a 1 km world. */
export const cases = {
  'climate:1': { seed: 1, spec: multiNoisePresets.climate },
  'climate:4294967295': { seed: 0xffffffff, spec: multiNoisePresets.climate },
  'climate-hard:2': { seed: 2, spec: { ...multiNoisePresets.climate, blend: 0 } },
  'relief:1': { seed: 1, spec: multiNoisePresets.relief },
  'relief-wide:3': { seed: 3, spec: { ...multiNoisePresets.relief, blend: 0.4 } },
};

/** A world of a case (extra world options such as workers pass through). */
export const makeWorld = ({ seed, spec }, extra = {}) =>
  BiomeWorld.create({
    seed,
    size: [1024, 1024],
    biomes,
    height: { relief: { coast: 'east', rivers: 1 } },
    classifier: multiNoise(spec),
    workers: false,
    ...extra,
  });

if (process.argv.includes('--write')) {
  const out = {
    $comment:
      'SHA-256 of BiomeWorld.digest(2, 1) for the multi-noise worlds of tests/multinoise-cases.mjs. A change changes every multi-noise map; advance it only with a reason in the commit.',
  };
  for (const [name, c] of Object.entries(cases)) out[name] = await (await makeWorld(c)).digest(2, 1);
  writeFileSync(new URL('./golden/multinoise.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log(out);
}
