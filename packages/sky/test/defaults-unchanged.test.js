// Scott, 2026-11-16: every existing default and preset renders exactly as it did before the slider options (look,
// atmosphere, settings) existed. defaults-fingerprint.js hashes every shader a sky compiles and every buffer write it
// makes over a dusk; the figures in fixtures/defaults-fingerprint.json were recorded from 3050f3bcc6, before the change,
// and recorded again with the KB-SKY-NU-EDGE1 fix (single scattering kept without its phases): every configuration
// of the full Sky compiles the Bruneton table passes, so each figure moved, but only bruneton, brunetonAlbedo and
// sunDirection draw differently; the others send the same render programs and buffer writes as before.
// Recorded again with KB-SKY-SUNUNITS1 (2026-11-17): the six configurations that light the scene (lighting,
// environment, day-*) scale the sky light map into the sun's units (Sky.lightScale in the light buffer's last float and
// skyLighting's WGSL), an intended change of their light; every other configuration is unchanged.
// Recorded again with KB-SKY-OVERCAST1 (2026-11-17): every full Sky compiles the cloud sheet's WGSL, which gained the
// overcast deck (cloudSky split into cloudSheet and cloudDeck), so every figure moved. Checked that day by hashing the
// buffer writes alone against the parent build: the same for every configuration, except the deck's transmission in
// float 35 (moonColor.w) where clouds are set (clouds, environment, sunDirection, day-goldenHour, day-overcast,
// day-dawn). Only cover above 0.8 draws differently (day-overcast, whose exposure and sun were retuned with it).
// Recorded again with KB-SCENES-SKYOCC1 (2026-11-17): the six configurations that light the scene declare skyRadiance
// beside skyLighting (for LightProbes' `sky`); skyLighting's text and every buffer write are unchanged, so none draws
// differently; every other configuration is unchanged.
// Recorded again with KB-GLTFA B1 (2026-11-19): core's vertex stage keeps a finite normal at a zero determinant
// (select on the determinant's sign and a +Y fallback), so every shader that composes core's vertex stage changed text;
// no buffer write changed and no configuration with a nonzero scale draws differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configurations, fingerprint } from './defaults-fingerprint.js';

test('every sky configuration without the new options sends the GPU what it did before them', async () => {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/defaults-fingerprint.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(recorded), Object.keys(configurations));
  for (const [name, make] of Object.entries(configurations)) assert.equal(fingerprint(make), recorded[name], name);
});
