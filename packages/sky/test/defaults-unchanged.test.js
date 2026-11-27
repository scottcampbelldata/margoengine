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
// Recorded again with the fog's cloud haze (2026-11-24, Fauld recut): the fog WGSL mixes in the light under a cloud cover
// (cloudHaze), so fog and fogColour changed text; no buffer write changed, and without clouds they draw as before.
// Recorded again with KB-SKY-OVERCAST2 (2026-11-24, Fauld recut): the overcast deck's top takes the clear sky's own
// light (the cloud WGSL gained clearSkyLevel, a 15-direction quadrature of daySky, and the fog reads the same
// overcastLight), so every configuration of the full Sky, whose code carries the cloud WGSL, changed text; no command
// and no buffer write changed, and only a sky at 80 percent cover or more, or fog under clouds, draws differently.
// Recorded again with KB-SKY-HOLES-KH1 (2026-11-26): the broken cloud sheet's optical depth goes as its depth to the 5/3
// (Brenguier et al. 2000) and its own depth shades its sunlight, so every configuration of the full Sky changed text; no
// buffer write changed, and only skies with cloud cover between 0 and 1 draw differently (sheet-check.html).
// Recorded again with the fog's exponential height falloff (2026-11-27, scaleHeight and base): the fog WGSL gained the
// closed-form term (run only with a scaleHeight) and its uniform one vec4; the same commands in every trace.
// Recorded again with KB-SKY-PALLFALLOFF1 (2026-11-27): the fog WGSL gained the fire spots' haze (run only with
// fog.fireSpots) and its uniform sixteen zero vec4s, so fog and fogColour changed; nothing else draws differently.
// Recorded again with KB-SKY-SANDGREY1 (2026-11-27): a sky that lights the scene draws in the engine light's units
// (Sky.pictureScale in the exposure float and the light buffer's last float divided by it), an intended change of the
// five that light it (lighting, day-*); the same WGSL and commands, and every other configuration is unchanged.
// Recorded again with KB-SKY-HAZEBELOW1 (2026-11-27): the fog WGSL gained fogBelowLight (the haze's light below the
// eye, fog.lightDecay) and its uniform one vec4, so fog and fogColour changed; at the default [0, 0, 0] the factor is
// exactly 1 and nothing draws differently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configurations, fingerprint } from './defaults-fingerprint.js';

test('every sky configuration without the new options sends the GPU what it did before them', async () => {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/defaults-fingerprint.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(recorded), Object.keys(configurations));
  for (const [name, make] of Object.entries(configurations)) assert.equal(fingerprint(make), recorded[name], name);
});
