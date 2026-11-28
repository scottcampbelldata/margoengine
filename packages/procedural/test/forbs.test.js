// Plants round 1 (2026-11-28, "Above the Treeline"): the alpine meadow had no wildflowers (no forb mesh in procedural).
// GPU proof of the parts drawn as Scatters: forbs-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SpectralIntegrator } from '@margoengine/optics/spectrum';
import { FORB_COLORS, FORB_SPECIES, forb } from '../dist/forbs.js';

const SPECIES = ['arnica', 'gentian', 'aster', 'bistort', 'campion'];

test('forb: every species builds valid parts in three rings, lighter further out', () => {
  for (const species of SPECIES) {
    const plant = forb(species, { seed: 5 });
    assert.equal(plant.species, species);
    assert.ok(plant.parts.length >= 2, `${species} has foliage and flowers`);
    assert.equal(plant.parts[0].name, 'foliage');
    for (const part of plant.parts) {
      const triangles = part.rings.map((g) => g.indices.length / 3);
      assert.ok(triangles[0] >= triangles[1] && triangles[1] >= triangles[2] && triangles[2] > 0, `${species} ${part.name}: ${triangles}`);
      for (const g of part.rings) {
        const vertices = g.positions.length / 3;
        assert.ok(g.positions.every(Number.isFinite) && g.normals.every(Number.isFinite), `${species} ${part.name} finite`);
        assert.ok(g.indices.every((i) => i < vertices), `${species} ${part.name} indices in range`);
        for (let i = 0; i < g.positions.length; i += 3) {
          assert.ok(Math.hypot(g.positions[i], g.positions[i + 1], g.positions[i + 2]) <= plant.reach + 1e-6);
          assert.ok(g.positions[i + 1] <= plant.top + 1e-6 && g.positions[i + 1] >= -0.02);
        }
      }
    }
    // The flowering height is the flora's, within the stems' own spread.
    const height = FORB_SPECIES[species].height;
    assert.ok(plant.top > 0.6 * height && plant.top < 1.8 * height, `${species} top ${plant.top} for ${height}`);
  }
});

test('forb: the seed decides the plant, and the options are checked', () => {
  const a = forb('arnica', { seed: 2 }),
    b = forb('arnica', { seed: 2 }),
    c = forb('arnica', { seed: 3 });
  assert.deepEqual(a.parts[0].rings[0].positions, b.parts[0].rings[0].positions);
  assert.notDeepEqual(a.parts[0].rings[0].positions, c.parts[0].rings[0].positions);
  assert.ok(forb('arnica', { scale: 2 }).top > 1.8 * forb('arnica').top);
  assert.equal(forb('arnica', { heads: 0 }).parts.length, 1, 'a plant not in flower is foliage only');
  assert.throws(() => forb('rose'), /Unknown forb species "rose"; use one of arnica/);
  for (const options of [{ seed: 1.5 }, { scale: 0 }, { heads: -1 }, { heads: 13 }])
    assert.throws(() => forb('aster', options), /forb needs an integer seed/, JSON.stringify(options));
});

test('FORB_COLORS: the measured FReD spectra integrated under a 6504 K black body', async () => {
  const { parts } = JSON.parse(await readFile(new URL('./fixtures/forb-spectra.json', import.meta.url), 'utf8'));
  const integrator = new SpectralIntegrator();
  const colour = (spectrum) =>
    integrator.color((nm) => {
      const x = (Math.min(780, Math.max(380, nm)) - 380) / 10,
        i = Math.min(39, Math.floor(x));
      return spectrum[i] + (spectrum[i + 1] - spectrum[i]) * (x - i);
    });
  const names = {
    arnicaRay: 'arnica.ray',
    arnicaDisc: 'arnica.disc',
    gentian: 'gentian.corolla',
    asterRay: 'aster.ray',
    asterDisc: 'aster.disc',
    bistort: 'bistort.flower',
    campion: 'campion.flower',
    leaf: 'forb.leaf',
  };
  for (const [key, row] of Object.entries(names)) {
    const c = colour(parts[row].spectrum);
    assert.ok(
      c.every((v, i) => Math.abs(v - FORB_COLORS[key][i]) <= 1e-4),
      `${key}: ${c.map((v) => v.toFixed(4))} against ${FORB_COLORS[key]}`,
    );
  }
  // Each part takes its colour: arnica's rays yellow, gentian blue over red, campion pink.
  const arnica = forb('arnica');
  assert.deepEqual(arnica.parts.map((p) => p.name), ['foliage', 'petals', 'centres']);
  assert.deepEqual(arnica.parts[1].color, FORB_COLORS.arnicaRay);
  assert.ok(forb('gentian').parts[1].color[2] > 1.5 * forb('gentian').parts[1].color[0]);
});

// Above the Treeline look round 5: arnica read as flat yellow discs, aster barely showed, moss campion cushions read as
// lily pads and every flower vanished past the middle ring. Heads nod and their rays rise and droop; a cushion is a
// lumpy mound; the far ring keeps (or grows) the coloured area seen from above.
const area = (g) => {
  let sum = 0;
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => g.indices[i + k] * 3),
      ux = g.positions[b] - g.positions[a],
      uz = g.positions[b + 2] - g.positions[a + 2],
      vx = g.positions[c] - g.positions[a],
      vz = g.positions[c + 2] - g.positions[a + 2];
    sum += Math.abs(ux * vz - uz * vx) / 2;
  }
  return sum;
};
test('forb heads nod and stand up from the stem; cushions are lumpy mounds; the far ring keeps its colour', () => {
  for (const species of ['arnica', 'aster']) {
    const petals = forb(species, { seed: 4 }).parts.find((p) => p.name === 'petals').rings[0];
    let low = Infinity,
      high = -Infinity,
      nx = 0,
      ny = 0,
      nz = 0;
    for (let i = 0; i < petals.positions.length; i += 3) {
      low = Math.min(low, petals.positions[i + 1]);
      high = Math.max(high, petals.positions[i + 1]);
      nx += petals.normals[i];
      ny += petals.normals[i + 1];
      nz += petals.normals[i + 2];
    }
    const diameter = 2 * FORB_SPECIES[species].ray;
    assert.ok(high - low > 0.3 * diameter, `${species}: the head stands ${(high - low).toFixed(4)} m tall, not flat`);
    const tilt = (Math.acos(Math.abs(ny) / Math.hypot(nx, ny, nz)) * 180) / Math.PI;
    assert.ok(tilt > 8, `${species}: the head nods ${tilt.toFixed(1)} degrees off the zenith`);
  }
  const cushion = forb('campion', { seed: 4 }).parts[0].rings[0];
  let top = 0,
    radius = 0;
  const radii = [];
  for (let i = 0; i < cushion.positions.length; i += 3) {
    top = Math.max(top, cushion.positions[i + 1]);
    radius = Math.max(radius, Math.hypot(cushion.positions[i], cushion.positions[i + 2]));
    radii.push(Math.hypot(cushion.positions[i], cushion.positions[i + 1], cushion.positions[i + 2]));
  }
  assert.ok(top > 0.38 * radius, `campion: a mound ${top.toFixed(3)} m tall on ${radius.toFixed(3)} m, not a pad`);
  let lumpy = 0;
  for (let i = 1; i < radii.length; i++) lumpy = Math.max(lumpy, Math.abs(radii[i] - radii[i - 1]) / radius);
  assert.ok(lumpy > 0.03, `campion: the cushion is lumpy (${lumpy.toFixed(3)})`);
  for (const species of ['arnica', 'aster', 'bistort', 'gentian', 'campion']) {
    const petals = forb(species, { seed: 4 }).parts.find((p) => p.name === 'petals').rings;
    assert.ok(area(petals[2]) > 0.9 * area(petals[0]), `${species}: far ring keeps the area seen from above (${area(petals[2])} of ${area(petals[0])})`);
  }
});
