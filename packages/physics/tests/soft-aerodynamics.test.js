// The air on a cloth's faces (`SoftBodyDesc.setAerodynamics`): each face a thin plate. A face square to the air is pushed with
// the square plate's 1.17 q A (Hoerner 1965); at a small angle attached flow lifts it across the air, Polhamus's potential and
// vortex lift (K_p sin a cos a + K_v sin^2 a, K_p by Helmbold); past its stall the separated plate's C_N90 sin a / (0.56 +
// 0.44 sin a) (Lindenburg 2003); edge-on only skin friction. The lift slope and the angle of the most lift are checked against
// low-aspect-ratio flat plates measured in a wind tunnel (Torres and Mueller, AIAA Journal 42(5), 2004, read from their
// figures 6 and 10 as tabulated in Energies 8(4), 2438, 2015, table 1), and a light cloth in a gale stays sane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { standardDensity } from '../../math/dist/atmosphere.js';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

await Physics.load();

// 10 kg a particle: heavy enough that a step barely changes the plate's speed through the air, light enough that the step's
// motion is well above the resolution of the f32 positions the velocities are read back from. The implicit step's factor,
// 1 / (1 + k w dt), is in the expected loads.
const HEIGHT = 1,
  MASS = 10,
  DT = 1 / 60;
/**
 * The force on a still, heavy square plate of side 1 m (two faces) set in a wind of `speed` m/s that meets it at `angle`
 * radians, from the momentum one step gives it: [along the wind, across the wind (lift, up), along the plate].
 */
async function plateForce(angle, speed = 10, aero = null, mass = MASS) {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    soft = await SoftBodies.attach(physics),
    // The plate's normal is (sin a, cos a, 0) with the wind along -x... its plane holds z and the direction (cos a, -sin a).
    c = Math.cos(angle),
    s = Math.sin(angle),
    desc = SoftBodyDesc.cloth([0, HEIGHT, 0], [c, -s, 0], [0, 0, 1], 2, 2).setParticleMass(mass).setTethers(null);
  if (aero) desc.setAerodynamics(aero);
  const plate = soft.create(desc);
  soft.wind = [speed, 0, 0];
  physics.step();
  const dt = DT;
  let px = 0,
    py = 0,
    pz = 0;
  for (let i = 0; i < 4; i++) {
    const v = plate.particleVelocity(i);
    px += mass * v[0];
    py += mass * v[1];
    pz += mass * v[2];
  }
  return { drag: px / dt, lift: py / dt, side: pz / dt, plate };
}

const q = (speed) => 0.5 * standardDensity(HEIGHT) * speed * speed;
/** The implicit step's share of a load whose coefficient per sine (or along the face) is `perSine`, on a face of 0.5 m^2. */
const implicit = (perSine, speed = 10, mass = MASS) =>
  1 / (1 + 0.5 * standardDensity(HEIGHT) * 0.5 * speed * (3 / mass / 9) * DT * perSine);
const helmbold = (ar) => (2 * Math.PI * ar) / (2 + Math.sqrt(ar * ar + 4));
const near = (a, b, relative, message) =>
  assert.ok(Math.abs(a - b) <= relative * Math.abs(b), `${message}: ${a} is not within ${relative * 100}% of ${b}`);

test('a face square to the air takes the square plate drag, 1.17 q A', async () => {
  const { drag, lift, side } = await plateForce(Math.PI / 2);
  near(drag, 1.17 * q(10) * implicit(1.17), 1e-2, 'drag');
  assert.ok(Math.abs(lift) < 1e-3 * drag && Math.abs(side) < 1e-3 * drag);
});

test('a face at a small angle is lifted by attached flow: Polhamus with Helmbold slope', async () => {
  const a = (8 * Math.PI) / 180,
    { drag, lift, plate } = await plateForce(a),
    cn = helmbold(1) * Math.sin(a) * Math.cos(a) + Math.PI * Math.sin(a) ** 2,
    // The normal force lies along the plate's normal, (sin a, cos a): drag its x share, lift its y share.
    normal = cn * q(10) * implicit(cn / Math.sin(a)),
    along = 0.004 * q(10) * implicit(0.004),
    expectedLift = normal * Math.cos(a) - along * Math.sin(a),
    expectedDrag = normal * Math.sin(a) + along * Math.cos(a);
  near(lift, expectedLift, 1e-2, 'lift');
  near(drag, expectedDrag, 1e-2, 'drag');
  assert.ok(lift > 3 * drag, `lift ${lift} over drag ${drag}`);
  assert.ok(plate.stallAngle > a);
});

test('past its stall the face takes the separated plate, and edge-on only skin friction', async () => {
  const a = (60 * Math.PI) / 180,
    { drag, lift } = await plateForce(a),
    cn = (1.17 * Math.sin(a)) / (0.56 + 0.44 * Math.sin(a)),
    along = 0.004 * q(10) * implicit(0.004);
  near(
    Math.hypot(drag - along * Math.cos(a), lift + along * Math.sin(a)),
    cn * q(10) * implicit(cn / Math.sin(a)),
    1e-2,
    'normal force',
  );
  // Edge-on the load is small: 1 kg particles, so the step moves them well above the positions' resolution.
  const edge = await plateForce(0, 10, null, 1);
  near(edge.drag, 0.004 * q(10) * implicit(0.004, 10, 1), 1e-2, 'skin friction');
  assert.ok(Math.abs(edge.lift) < 1e-6 * edge.drag + 1e-9);
  // No air, no friction: a plate with neither drag nor friction feels nothing edge-on.
  const bare = await plateForce(0, 10, { friction: 0 });
  assert.equal(bare.drag, 0);
});

test('lift slope and stall match low-aspect-ratio plates measured by Torres and Mueller (2004)', async () => {
  // Aspect ratio, angle of the most lift (degrees) and lift slope K_p (per radian), read from their figures.
  const measured = [
    [0.5, 35, 0.83],
    [0.75, 33, 1.26],
    [1, 28, 1.59],
  ];
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics);
  for (const [ar, stall, slope] of measured) {
    const plate = soft.create(
      SoftBodyDesc.cloth([0, 0, 0], [1, 0, 0], [0, 0, 1], 2, 2).setAerodynamics({ aspectRatio: ar }),
    );
    const degrees = (plate.stallAngle * 180) / Math.PI;
    assert.ok(Math.abs(degrees - stall) <= 5, `AR ${ar}: stall ${degrees} against ${stall} degrees measured`);
    near(helmbold(ar), slope, 0.1, `AR ${ar} lift slope`);
    assert.equal(plate.aerodynamics.aspectRatio, ar);
  }
});

test('a light cloth in a gale is carried to the air, steadily', async () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 1 }),
    // Cotton shirting by default: 0.12 kg/m^2, square to a 60 m/s wind, one piece a step.
    sheet = soft.create(SoftBodyDesc.cloth([0, 1, 0], [0, 0.1, 0], [0, 0, 0.1], 10, 10));
  soft.wind = [60, 0, 0];
  const gaps = [];
  let fastest = 0;
  for (let i = 1; i <= 120; i++) {
    physics.step();
    let mean = 0;
    for (let p = 0; p < 100; p++) {
      const v = sheet.particleVelocity(p)[0];
      fastest = Math.max(fastest, Math.abs(v));
      mean += v / 100;
    }
    if (i % 40 === 0) gaps.push(Math.abs(mean - 60));
  }
  // A tumbling sheet's lift can carry it a little past the air for a while (the same sheet thrown into still air at the
  // wind's speed ends a little behind where it stops, by Galilean invariance), so the test is that it is carried to the
  // air, that the gap closes, and that no particle runs away.
  assert.ok(Number.isFinite(fastest) && fastest < 120, `a particle reached ${fastest} m/s`);
  assert.ok(gaps[2] < 0.02 * 60, `the sheet ends ${gaps[2]} m/s from the air`);
  assert.ok(gaps[2] < gaps[0], `the gap closes: ${gaps.join(', ')}`);
});

test('aerodynamics check their values', () => {
  const desc = SoftBodyDesc.cloth([0, 0, 0], [1, 0, 0], [0, 0, 1], 2, 2);
  assert.throws(() => desc.setAerodynamics({ aspectRatio: 0 }), RangeError);
  assert.throws(() => desc.setAerodynamics({ drag: -1 }), RangeError);
  assert.throws(() => desc.setAerodynamics({ friction: Number.NaN }), RangeError);
  assert.throws(() => desc.setAerodynamics({ vortexLift: Number.POSITIVE_INFINITY }), RangeError);
});
