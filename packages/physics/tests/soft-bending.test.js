// Quadratic bending of cloth (SoftBodyMaterial.bending; Bergou et al. 2006) checked against the exact heavy elastica of a
// cantilevered strip and against measured fabrics: the bending length a strip of KES-FB2 measured rigidity reaches in the
// cantilever test, against the bending length the same fabrics were measured at on the FAST cantilever (Luible 2008).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { FABRICS, SoftBodies, SoftBodyDesc, SoftBodyMaterial, fabricBendingRigidity } from '../dist/soft.js';

await Physics.load();

const G = 9.81;
/** The cantilever test's plane: the strip's tip touches a slope of 41.5 degrees from the platform's edge (ASTM D1388). */
const SLOPE = 41.5;

/**
 * The exact heavy elastica of an inextensible strip clamped level and hanging `length` metres past the clamp under its own
 * weight `q` (N/m^2) with bending rigidity `b` (N m): B theta'' = -q (L - s) cos theta, theta(0) = 0, theta'(L) = 0, shot
 * on theta'(0) by bisection with fourth-order Runge-Kutta. Returns the angle below level of the chord from the clamp's edge
 * to the tip, degrees (the cantilever test's angle).
 */
function elastica(length, b, q, steps = 4000) {
  const h = length / steps,
    curl = (s, theta) => (-q * (length - s) * Math.cos(theta)) / b,
    shoot = (k0) => {
      let theta = 0,
        k = k0,
        x = 0,
        y = 0;
      for (let i = 0; i < steps; i++) {
        const s = i * h,
          a1 = k,
          b1 = curl(s, theta),
          a2 = k + (h / 2) * b1,
          b2 = curl(s + h / 2, theta + (h / 2) * a1),
          a3 = k + (h / 2) * b2,
          b3 = curl(s + h / 2, theta + (h / 2) * a2),
          a4 = k + h * b3,
          b4 = curl(s + h, theta + h * a3),
          next = theta + (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
        k += (h / 6) * (b1 + 2 * b2 + 2 * b3 + b4);
        x += (h * (Math.cos(theta) + Math.cos(next))) / 2;
        y += (h * (Math.sin(theta) + Math.sin(next))) / 2;
        theta = next;
      }
      return { k, x, y };
    };
  let lo = 0,
    hi = (q * length * length) / b;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (shoot(mid).k > 0) hi = mid;
    else lo = mid;
  }
  const tip = shoot((lo + hi) / 2);
  return (Math.atan2(tip.y, tip.x) * 180) / Math.PI;
}

/**
 * A strip `length` metres past a level clamp, `segments` cells along it and two across, of areal density `density` (kg/m^2)
 * and bending rigidity `rigidity` (N m) both ways, let settle under gravity. The clamp is two pinned columns of particles half
 * a cell either side of its edge, which hold the slope level at the edge itself (a column at the edge and one behind it would
 * hold it level half a cell back, lengthening the strip by half a cell). Returns the angle below level of the chord from the
 * clamp's edge to the middle of the tip, degrees.
 */
async function cantilever(length, rigidity, density, { segments = 10, solver = 'constraints' } = {}) {
  const physics = new Physics(null);
  physics.gravity = [0, -G, 0];
  const soft = await SoftBodies.attach(physics),
    d = length / (segments + 0.5),
    across = 3,
    material = SoftBodyMaterial.fabric(FABRICS.cottonShirting),
    b = rigidity / fabricBendingRigidity(1);
  material.bending = { warp: b, weft: b };
  material.arealDensity = density;
  const desc = SoftBodyDesc.cloth([-d / 2, 0, 0], [d, 0, 0], [0, 0, d], segments + 2, across)
    .setMaterial(material)
    .setSolver(solver)
    .setPinnedParticles(Array.from({ length: 2 * across }, (_, i) => i));
  const body = soft.create(desc).setLinearDamping(5);
  for (let i = 0; i < 240; i++) physics.step();
  const p = body.particlePositions(),
    tip = (segments + 1) * across + 1;
  return (Math.atan2(-p[3 * tip + 1], p[3 * tip]) * 180) / Math.PI;
}

test('the exact heavy elastica puts the tip on the cantilever slope where Peirce says, at an overhang of twice the bending length', () => {
  // Peirce's cantilever (1930), on which ASTM D1388 and FAST rest: a strip of rigidity B and weight q per area whose tip
  // reaches the 41.5 degree slope hangs out twice its bending length c = (B / q)^(1/3). The exact elastica agrees to 0.05
  // degrees, so a measured bending length is a measured B / q, and the solver below is checked against the elastica itself.
  const q = 0.2 * G,
    c = 0.025;
  assert.ok(Math.abs(elastica(2 * c, q * c ** 3, q) - SLOPE) < 0.05);
});

test('a cantilevered strip of measured bending settles on the exact heavy elastica, at a small and a large droop', async () => {
  // Flannel's warp (Luible 2008: KES-FB2 B 0.288 gf cm^2/cm, 282 g/m^2) 46.2 mm past the clamp, and a strip of a fifteenth of
  // its weight. The solve is second order in the cell size (the error of 10 cells halves twice by 20), so 10 cells along
  // 46 mm hold the angle to (d / L)^2 of itself.
  const rigidity = fabricBendingRigidity(0.288),
    length = 0.0462,
    segments = 10,
    bound = (1 / (segments + 0.5)) ** 2;
  for (const density of [0.02, 0.282]) {
    const exact = elastica(length, rigidity, density * G),
      angle = await cantilever(length, rigidity, density, { segments });
    assert.ok(Math.abs(angle - exact) <= bound * exact, `${density} kg/m^2: ${angle} degrees against ${exact}`);
  }
});

test('on the vertex-block solver the strip settles on the same elastica at the default passes, and never gains energy', async () => {
  // KB-SOFT-VBDBEND1: started from the inertial guess, a few passes ended above where the particles were, so the flannel strip
  // (its measured threads stiff, its bending coupling every particle along it) flailed through 13 to 143 degrees at the default
  // 2 passes and hung at 64.7 degrees at 20. The block steps now each lower the step's potential and the passes start no higher
  // than the previous place, and the blocks take at least 8 sweeps a piece.
  const rigidity = fabricBendingRigidity(0.288),
    length = 0.0462,
    segments = 10,
    bound = (1 / (segments + 0.5)) ** 2;
  for (const density of [0.02, 0.282]) {
    const exact = elastica(length, rigidity, density * G),
      angle = await cantilever(length, rigidity, density, { segments, solver: 'vertex-block' });
    assert.ok(Math.abs(angle - exact) <= bound * exact, `${density} kg/m^2: ${angle} degrees against ${exact}`);
  }
  // Undamped, released level: the strip's kinetic and potential energy never climbs above what it started with.
  const physics = new Physics(null);
  physics.gravity = [0, -G, 0];
  const soft = await SoftBodies.attach(physics),
    d = length / (segments + 0.5),
    material = SoftBodyMaterial.fabric(FABRICS.cottonShirting),
    b = rigidity / fabricBendingRigidity(1);
  material.bending = { warp: b, weft: b };
  material.arealDensity = 0.282;
  const body = soft.create(
      SoftBodyDesc.cloth([-d / 2, 0, 0], [d, 0, 0], [0, 0, d], segments + 2, 3)
        .setMaterial(material)
        .setSolver('vertex-block')
        .setPinnedParticles([0, 1, 2, 3, 4, 5]),
    ),
    energy = () => {
      const p = body.particlePositions(),
        v = body.particleVelocities();
      let e = 0;
      for (let i = 0; i < p.length / 3; i++) e += 0.5 * (v[3 * i] ** 2 + v[3 * i + 1] ** 2 + v[3 * i + 2] ** 2) + G * p[3 * i + 1];
      return e;
    },
    start = energy();
  for (let i = 0; i < 200; i++) {
    physics.step();
    assert.ok(energy() <= start, `step ${i}: ${energy()} above the start's ${start}`);
  }
});

/**
 * Luible's six fabrics measured on both instruments (Luible 2008, Annex C for KES-F, section 4.2.2 for FAST): areal density
 * (g/m^2, FAST table 9), KES-FB2 B along the warp and the weft (gf cm^2/cm) and FAST's bending rigidity along each
 * (uN m, table 8), which FAST works out from the bending length C it measures as B = 9.8 W C^3 1e-6 (W in g/m^2, C in mm).
 */
const MEASURED = {
  '11 flannel': { weight: 282, kes: [0.288, 0.19], fast: [34.0, 25.9] },
  '05 gabardine': { weight: 169, kes: [0.073, 0.063], fast: [9.7, 8.7] },
  '04 linen': { weight: 239, kes: [0.279, 0.181], fast: [45.2, 21.7] },
  '24 satin': { weight: 132, kes: [0.134, 0.215], fast: [14.6, 20.1] },
};

test('a strip of KES-FB2 measured bending droops in the cantilever test where FAST measured the same fabrics (Luible 2008)', async () => {
  // Each woven fabric that both instruments measured, along its warp and its weft: the strip hangs out the overhang FAST
  // measured it at, twice its bending length, and the simulated angle is compared with the test's 41.5 degrees. The two
  // instruments measure differently: KES-FB2 takes B as the mean slope of the face and the back bending curves to 2.5 cm^-1,
  // and Luible found the face and back of her fabrics differing by up to 89 percent (section 4.3), so B is known to within
  // +-44.5 percent of itself, and the bending length, B^(1/3), to within 0.82 to 1.13 of itself. The simulated angle must
  // lie where the elastica puts that band. Linen's warp, the one outside it (FAST measures it 1.64 times KES-FB2's B), is
  // recorded in docs/limits.md and checked here at what it is.
  for (const [name, { weight, kes, fast }] of Object.entries(MEASURED))
    for (const [k, direction] of ['warp', 'weft'].entries()) {
      const density = weight / 1000,
        q = density * G,
        bending = Math.cbrt((fast[k] * 1e-6) / (9.8 * density)),
        rigidity = fabricBendingRigidity(kes[k]),
        angle = await cantilever(2 * bending, rigidity, density),
        stiff = elastica(2 * bending, rigidity * 1.445, q),
        soft = elastica(2 * bending, rigidity * 0.555, q);
      if (name === '04 linen' && direction === 'warp') {
        assert.ok(angle > stiff && SLOPE < stiff, `${name} ${direction}: ${angle} degrees, the band from ${stiff}`);
        continue;
      }
      assert.ok(angle >= stiff && angle <= soft, `${name} ${direction}: ${angle} degrees, band ${stiff} to ${soft}`);
      assert.ok(
        SLOPE >= stiff && SLOPE <= soft,
        `${name} ${direction}: the measured 41.5 degrees in the band ${stiff} to ${soft}`,
      );
    }
});
