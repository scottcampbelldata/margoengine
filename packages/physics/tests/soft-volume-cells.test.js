// The 'cells' tier of SoftBodyDesc.volume (P8, SOFT-04): a closed mesh filled with tetrahedra fitted to its surface by
// isosurface stuffing (Labelle and Shewchuk 2007), elastic by a measured CellMaterial, the mesh riding in the cells as a skin;
// checked for a conforming, closed fill of the right volume and angles, and against Hertz contact.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

/** A UV sphere, welded at its poles: 2 + w (h - 1) vertices, wound outward. */
const sphere = (r, w, h) => {
  const positions = [0, r, 0],
    indices = [],
    at = (ix, iy) => (iy === 0 ? 0 : iy === h ? 1 + (h - 1) * w : 1 + (iy - 1) * w + (ix % w));
  for (let iy = 1; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const phi = (2 * Math.PI * ix) / w,
        th = (Math.PI * iy) / h;
      positions.push(-r * Math.cos(phi) * Math.sin(th), r * Math.cos(th), r * Math.sin(phi) * Math.sin(th));
    }
  positions.push(0, -r, 0);
  for (let iy = 0; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const [a, b, c, d] = [at(ix + 1, iy), at(ix, iy), at(ix, iy + 1), at(ix + 1, iy + 1)];
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== h - 1) indices.push(b, c, d);
    }
  return { positions, indices, uvs: Array.from({ length: (positions.length / 3) * 2 }, (_, i) => (i % 7) / 7) };
};
/** A hemisphere, dome down and its flat face up at y = 0: w segments round, h rings from the pole to the rim, a fan on top. */
const hemisphere = (r, w, h) => {
  const positions = [0, -r, 0],
    indices = [];
  for (let iy = 1; iy <= h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const th = (Math.PI / 2) * (iy / h),
        phi = (2 * Math.PI * ix) / w;
      positions.push(r * Math.sin(th) * Math.cos(phi), -r * Math.cos(th), r * Math.sin(th) * Math.sin(phi));
    }
  const top = positions.length / 3,
    at = (ix, iy) => (iy === 0 ? 0 : 1 + (iy - 1) * w + (ix % w));
  positions.push(0, 0, 0);
  for (let ix = 0; ix < w; ix++) indices.push(0, at(ix, 1), at(ix + 1, 1));
  for (let iy = 1; iy < h; iy++)
    for (let ix = 0; ix < w; ix++) {
      const [a, b, c, d] = [at(ix, iy), at(ix + 1, iy), at(ix + 1, iy + 1), at(ix, iy + 1)];
      indices.push(a, d, c, a, c, b);
    }
  for (let ix = 0; ix < w; ix++) indices.push(top, at(ix + 1, h), at(ix, h));
  return { positions, indices };
};
const meshVolume = (p, t) => {
  let v = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3];
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return v;
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test("the 'cells' tier fills a mesh with conforming tetrahedra on its surface, of the right volume and angles", () => {
  const R = 0.5,
    mesh = sphere(R, 32, 24),
    source = meshVolume(mesh.positions, mesh.indices);
  for (const h of [0.2, 0.1]) {
    const desc = SoftBodyDesc.volume(mesh, { tier: 'cells', cellSize: h }),
      p = desc.positions,
      cells = desc.cells,
      at = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    // Every face is held by one cell (the surface) or two: the cells conform, and the surface is closed.
    const faces = new Map();
    let volume = 0,
      least = 180,
      most = 0;
    for (let t = 0; t < cells.length; t += 4) {
      const v = [0, 1, 2, 3].map((k) => at(cells[t + k])),
        det = dot(sub(v[1], v[0]), cross(sub(v[2], v[0]), sub(v[3], v[0])));
      assert.ok(det > 0, `cell ${t / 4} is right-handed and not flat`);
      volume += det / 6;
      for (const f of [
        [1, 2, 3],
        [0, 2, 3],
        [0, 1, 3],
        [0, 1, 2],
      ]) {
        const key = f
          .map((k) => cells[t + k])
          .sort((a, b) => a - b)
          .join();
        faces.set(key, (faces.get(key) ?? 0) + 1);
      }
      // The six dihedral angles, from the four outward face normals.
      const normals = [
        [1, 2, 3, 0],
        [0, 3, 2, 1],
        [0, 1, 3, 2],
        [0, 2, 1, 3],
      ].map(([a, b, c, o]) => {
        const n = cross(sub(v[b], v[a]), sub(v[c], v[a])),
          s = dot(n, sub(v[o], v[a])) > 0 ? -1 : 1,
          l = Math.hypot(...n);
        return n.map((x) => (x * s) / l);
      });
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++) {
          const angle = 180 - (Math.acos(Math.max(-1, Math.min(1, dot(normals[i], normals[j])))) * 180) / Math.PI;
          least = Math.min(least, angle);
          most = Math.max(most, angle);
        }
    }
    assert.ok(
      [...faces.values()].every((n) => n <= 2),
      'no face is shared by three cells',
    );
    // The surface's corners are cut points and warped lattice points, all on the mesh, so it is inscribed in it: its volume is
    // short by at most the area times the sagitta of a chord as long as a lattice cell (h^2 / 8R), 3 h^2 / (8 R^2) of it.
    const deficit = 1 - volume / source;
    assert.ok(
      deficit > 0 && deficit < (3 * h * h) / (8 * R * R),
      `the cells hold ${volume} of the mesh's ${source} at h ${h}`,
    );
    // Within the dihedral bounds Labelle and Shewchuk prove for isosurface stuffing, 10.78 to 164.84 degrees.
    assert.ok(least > 10.78 && most < 164.84, `dihedral angles ${least} to ${most} at h ${h}`);
  }
});

test("a 'cells' body rides its mesh as a skin, keeps its texture coordinates, and refuses a gas or a bad tier", async () => {
  const physics = new Physics(null);
  const soft = await SoftBodies.attach(physics);
  const mesh = sphere(0.2, 16, 12),
    ball = soft.create(SoftBodyDesc.volume(mesh, { tier: 'cells', density: 500 }));
  assert.ok(ball.numCells() > 0);
  assert.equal(ball.solverKind, 'vertex-block');
  assert.deepEqual([...ball.meshIndices()], mesh.indices, 'the skin is the source mesh');
  assert.deepEqual([...ball.sourceMesh.uvs], mesh.uvs.map(Math.fround), 'its uvs are kept for drawing');
  const skin = ball.meshVertices();
  for (let i = 0; i < mesh.positions.length; i++)
    assert.ok(Math.abs(skin[i] - mesh.positions[i]) < 1e-5, 'the skin starts on the mesh');
  // Mass from the cells' density: the inscribed volume times 500.
  assert.ok(Math.abs(ball.mass() / (500 * ball.volume()) - 1) < 1e-4, `mass ${ball.mass()}`);
  const coded = (e) => e.name === 'MargoError' && e.code === 'unsupported' && /errors#soft-volumes/.test(e.message);
  assert.throws(() => SoftBodyDesc.volume(mesh, { tier: 'cells', pressure: 2e5 }), coded);
  assert.throws(() => SoftBodyDesc.volume(mesh, { tier: 'solid' }), coded);
  assert.throws(() => SoftBodyDesc.volume(mesh, { tier: 'cells', cellSize: 0 }), coded);
  assert.throws(() => SoftBodyDesc.volume(mesh, { tier: 'cells', material: { youngsModulus: 1 } }), coded);
});

/**
 * A rubber hemisphere of R = 5 cm (E = 1 MPa, nu = 0.3), dome down on a fixed floor, its flat face pressed by `F` newtons spread
 * by area and ramped in over a quarter second, at the soft world's default 8 pieces of 2 passes: the approach of the flat face.
 */
async function pressedHemisphere(F, solver) {
  const R = 0.05,
    r = 1e-4;
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.5, 1] },
  });
  const soft = await SoftBodies.attach(physics);
  const material = Object.assign(new CellMaterial(), {
    youngsModulus: 1e6,
    poissonRatio: 0.3,
    elasticDampingRatio: 0.3,
  });
  const desc = SoftBodyDesc.volume(hemisphere(R, 64, 16), { tier: 'cells', cellSize: R / 6, material, radius: r })
    .setSolver(solver)
    .setGravityScale(0)
    .setCanSleep(false)
    .setLinearDamping(30)
    .setTranslation([0, R + r, 0]);
  const body = soft.create(desc),
    p0 = body.particlePositions(),
    tri = body.triangles(),
    share = new Map();
  for (let t = 0; t < tri.length; t += 3) {
    const k = [tri[t], tri[t + 1], tri[t + 2]];
    if (!k.every((i) => Math.abs(p0[i * 3 + 1] - (R + r)) < 1e-6)) continue;
    const [a, b, c] = k.map((i) => [p0[i * 3], p0[i * 3 + 2]]),
      area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    for (const i of k) share.set(i, (share.get(i) ?? 0) + area / 3);
  }
  const whole = [...share.values()].reduce((s, w) => s + w, 0),
    face = (p) => [...share].reduce((s, [i, w]) => s + p[i * 3 + 1] * w, 0) / whole,
    start = face(p0);
  for (let s = 0; s < 25; s++) {
    body.resetForces();
    for (const [i, w] of share) body.addParticleForce(i, [0, (-Math.min(1, (s + 1) / 15) * F * w) / whole, 0]);
    physics.step();
  }
  assert.ok(!body.particlePositions().some(Number.isNaN));
  return start - face(body.particlePositions());
}
/** Hertz (1882): one contact's approach under F for a sphere of R = 5 cm, E* = E / (1 - nu^2). */
const hertz = (F) => Math.pow((3 * F * (1 - 0.3 * 0.3)) / (4 * 1e6 * Math.sqrt(0.05)), 2 / 3);

test("a 'cells' ball meets Hertz contact at the default passes, on the vertex-block and fem solvers", async () => {
  // The flat face is the mid-plane of a ball squeezed between two plates, which by symmetry stays plane and moves by one
  // contact's approach, so Hertz gives F = 4/3 E* sqrt(R) delta^(3/2): at 100 N, delta 4.53 mm and a contact radius
  // sqrt(R delta) of 15 mm, 1.8 lattice cells. The bound, 10%, is Hertz's own reach here: its small-strain half-space terms
  // are good to the order of (a / R)^2 (Johnson, Contact Mechanics, 1985, ch. 4), 9% at a / R = 0.3. Measured: 0.949
  // (vertex-block) and 1.091 (fem), the same at 8 x 2 as at 80 x 20. The passes started from the full prediction of each
  // piece and the fem solve's unknowns from the full velocity; cut short at the default passes, both stopped short of the
  // load's answer and the hemisphere flattened (KB-SOFT-VBDGUESS1).
  for (const solver of ['vertex-block', 'fem']) {
    const delta = await pressedHemisphere(100, solver);
    assert.ok(Math.abs(delta / hertz(100) - 1) < 0.1, `${solver}: approach ${delta} m against Hertz ${hertz(100)} m`);
  }
});

test("a 'cells' ball follows Hertz's power 3/2 on a held-out load", async () => {
  // A quarter of the load, not used to set anything above: Hertz's approach falls by 4^(2/3), to 1.80 mm, a contact radius of
  // 9.5 mm, 1.1 cells; the bound is the 10% above, against the measured 100 N approach scaled by the power law.
  const full = await pressedHemisphere(100, 'vertex-block'),
    quarter = await pressedHemisphere(25, 'vertex-block');
  assert.ok(Math.abs(quarter / hertz(25) - 1) < 0.1, `approach ${quarter} m against Hertz ${hertz(25)} m`);
  const power = Math.log(4) / Math.log(full / quarter);
  assert.ok(Math.abs(power - 1.5) < 0.15, `force grows as the approach to the power ${power}, Hertz's 1.5`);
});
