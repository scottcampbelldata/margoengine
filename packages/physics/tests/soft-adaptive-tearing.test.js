// Adaptive tearing of sheets (`SoftBodyMaterial.adaptiveTearing`, Pfaff et al. 2014): a face stretched past the tear strain
// is cut across its greatest stretch, wherever the mesh's edges run, with a vertex inserted where the cut meets the face's far
// side; the crack opens behind its tip; mass is kept exactly and momentum by every cut; and below the threshold nothing tears.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

/** A woven sheet of n by n particles `h` apart, its grid turned `degrees` about z, centred on the origin. */
function turnedSheet(n, h, degrees) {
  const a = (degrees * Math.PI) / 180,
    du = [h * Math.cos(a), h * Math.sin(a), 0],
    dv = [-h * Math.sin(a), h * Math.cos(a), 0],
    origin = [(-(n - 1) / 2) * (du[0] + dv[0]), (-(n - 1) / 2) * (du[1] + dv[1]), 0];
  return SoftBodyDesc.cloth(origin, du, dv, n, n).setAirDrag(false);
}
const tearing = (desc, strain, { adaptive = true, perStep = 0 } = {}) => {
  const m = desc.material.clone();
  m.tearStrain = strain;
  m.adaptiveTearing = adaptive;
  m.maxTearsPerStep = perStep;
  return desc.setMaterial(m);
};
/** How many face sides only one face holds: the boundary, which grows as cracks open. */
function boundarySides(body) {
  const t = body.triangles(),
    count = new Map();
  for (let k = 0; k < t.length; k += 3)
    for (let j = 0; j < 3; j++) {
      const a = t[k + j],
        b = t[k + ((j + 1) % 3)],
        key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  return [...count.values()].filter((c) => c === 1).length;
}

test('a cut runs across the greatest stretch, whichever way the mesh is turned', async () => {
  for (const degrees of [0, 30, 60]) {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      soft = await SoftBodies.attach(physics),
      n = 8,
      desc = tearing(turnedSheet(n, 0.1, degrees), 0.1, { perStep: 40 });
    desc.setPinnedParticles([...Array(n * n).keys()]);
    let body = soft.create(desc);
    soft.onTear((event) => {
      body = event.pieces.at(-1) ?? body;
    });
    // Held stretched 20 percent along x: every face's greatest stretch is along x.
    const rest = body.particlePositions();
    for (let p = 0; p < n * n; p++) body.setParticlePosition(p, [1.2 * rest[3 * p], rest[3 * p + 1], 0]);
    physics.step();
    const original = [...Array(n * n).keys()].map((p) => [1.2 * rest[3 * p], rest[3 * p + 1]]);
    let inserted = 0;
    for (let p = n * n; p < body.numParticles(); p++) {
      const [x, y] = body.particlePosition(p),
        nearest = Math.min(...original.map(([ox, oy]) => Math.hypot(ox - x, oy - y)));
      if (nearest < 1e-6) continue; // a copy of a vertex along an open crack
      inserted++;
      // The corner it was cut from lies straight across the stretch from it: the same x, within a face's reach.
      const corner = original.some(([ox, oy]) => Math.abs(ox - x) < 1e-5 && Math.hypot(ox - x, oy - y) < 0.2);
      assert.ok(corner, `at ${degrees} degrees, the vertex inserted at (${x}, ${y}) has no corner across the stretch`);
    }
    if (degrees !== 0) assert.ok(inserted > 0, `at ${degrees} degrees the cuts inserted vertices`);
  }
});

test('a sheet tearing as it shears keeps its mass exactly and its momentum, and its cracks open', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    soft = await SoftBodies.attach(physics),
    sheet = soft.create(tearing(turnedSheet(21, 0.05, 0), 0.02)),
    mass0 = sheet.masses.reduce((s, m) => s + m, 0),
    boundary0 = boundarySides(sheet);
  // Thrown into pure shear: its greatest stretch is along a diagonal, where a woven sheet is soft.
  for (let p = 0; p < sheet.numParticles(); p++) {
    const q = sheet.particlePosition(p);
    sheet.setParticleVelocity(p, [3 * q[1], 3 * q[0], 0]);
  }
  let events = 0;
  soft.onTear(() => events++);
  for (let s = 0; s < 60; s++) {
    physics.step();
    let mass = 0,
      px = 0,
      py = 0;
    for (const body of soft.list())
      for (let i = 0; i < body.numParticles(); i++) {
        const v = body.particleVelocity(i);
        mass += body.masses[i];
        px += body.masses[i] * v[0];
        py += body.masses[i] * v[1];
      }
    assert.ok(Math.abs(mass - mass0) <= 1e-6 * mass0, `step ${s}: mass ${mass} of ${mass0}`);
    // Against its motion, a tenth of a kilogram moving at about a metre a second.
    assert.ok(Math.hypot(px, py) < 1e-4, `step ${s}: momentum (${px}, ${py})`);
  }
  assert.ok(events > 10, `${events} tears`);
  const [torn] = soft.list();
  assert.ok(torn.numParticles() > 441, 'vertices were inserted and copied');
  assert.ok(boundarySides(torn) > boundary0, 'the cracks opened: the sheet has more boundary');
});

test('below its tear strain nothing is cut, and without adaptive tearing the edges tear instead', async () => {
  const run = async (velocity, adaptive) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] }),
      soft = await SoftBodies.attach(physics),
      sheet = soft.create(tearing(turnedSheet(11, 0.05, 0), 0.02, { adaptive }));
    for (let p = 0; p < sheet.numParticles(); p++) {
      const q = sheet.particlePosition(p);
      sheet.setParticleVelocity(p, [velocity * q[1], velocity * q[0], 0]);
    }
    const heard = [];
    soft.onTear((event) => heard.push(event));
    for (let s = 0; s < 30; s++) physics.step();
    return { heard, sheet, soft };
  };
  const calm = await run(0.05, true);
  assert.equal(calm.heard.length, 0);
  assert.equal(calm.sheet.valid, true);
  const edges = await run(3, false);
  assert.ok(edges.heard.length > 0 && edges.heard.every((e) => e.edges.length > 0 && e.pieces.length === 0));
  assert.equal(edges.soft.list()[0].numParticles(), 121, 'edge tearing inserts nothing');
});
