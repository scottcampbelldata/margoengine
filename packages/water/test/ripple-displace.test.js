// Bodies make ripples by the water they push aside (SEA-12 to SEA-04, parity bar P12 point 4). `RippleField.displace`
// (and `Ripples.trackBody` with `volume`) lays a ring around the body's footprint that holds exactly the displaced
// volume and raises nothing under the body, so the field's
// water grows by the change in a body's displacement; the wave stencil then carries it away and keeps it (its Laplacian
// sums to zero inside the grid, and the velocity starts at zero, so the height sum holds until a wave reaches the
// absorbing border). The ripple field is a height field: it carries no horizontal momentum, so the conserved quantity
// across this coupling is the water's volume (its mass). A floating body that bobs on the field it disturbs is checked
// two ways: the field holds the body's displaced volume change at every step, and the body still floats at its draft.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../physics/dist/index.js';
import { floating, LoadSolver } from '../../physics/dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../../physics/dist/world.js';
import { RippleField } from '../dist/ripples.js';

/** The ring's peak height: (1 - s^2)^2 from r to 2 r holds (32 / 15) pi w c of it, w = r / 2 and c = 3 r / 2. */
const peak = (volume, r) => (15 * volume) / (32 * Math.PI * (r / 2) * ((3 * r) / 2));

/** The ring's own sum over the cells of `field` around (x, z), times the cell area: its quadrature of the volume. */
function quadrature(field, x, z, radius, height) {
  const c = field.cellSize,
    [ox, oz] = field.origin,
    n = field.resolution;
  let sum = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const dx = ox + (i + 0.5) * c - x,
        dz = oz + (j + 0.5) * c - z,
        u = (Math.hypot(dx, dz) - 1.5 * radius) / (0.5 * radius);
      if (u * u < 1) sum += height * (1 - u * u) * (1 - u * u);
    }
  return sum * c * c;
}

test('SEA-04 a displaced volume becomes exactly that much water in the ripple field, and the field keeps it', () => {
  const field = new RippleField({ size: 32, resolution: 128, speed: 2, damping: 0 }),
    volume = 0.012,
    radius = 1.1;
  field.displace(0.3, -0.2, radius, volume).advance(1 / 120);
  // The cells' sum of the continuous ring: the midpoint rule across its 4.4 cells, measured within 1 % of the volume.
  const laid = quadrature(field, 0.3, -0.2, radius, peak(volume, radius));
  assert.ok(Math.abs(laid - volume) <= 0.01 * volume, `the mound's quadrature ${laid} against ${volume} m^3`);
  // Float32 heights: each of the ~60 wet cells rounds to 2^-24 of its height.
  assert.ok(Math.abs(field.volume() - laid) <= 1e-6 * volume, `laid ${field.volume()} against ${laid} m^3`);
  // A second spreads it as waves (c t = 2 m, well inside the 8-cell sponge at 14 m): the volume stays.
  field.advance(1);
  assert.ok(Math.abs(field.volume() - laid) <= 1e-4 * volume, `kept ${field.volume()} against ${laid} m^3`);
  // Taking it back where it was leaves the field's volume at zero.
  const empty = new RippleField({ size: 32, resolution: 128, speed: 2, damping: 0 });
  empty
    .displace(0, 0, radius, volume)
    .displace(0, 0, radius, -volume)
    .advance(1 / 120);
  assert.ok(Math.abs(empty.volume()) <= 1e-9, `put back: ${empty.volume()}`);
});

test('SEA-04 a body let go on the ripples it makes: the field holds its displaced volume change, two-way', async () => {
  await Physics.load();
  // The body is a wall to its own ripples (as `trackBody` with `volume` makes it): the ring reflects off its footprint.
  const field = new RippleField({
      size: 12,
      resolution: 128,
      speed: 1.2,
      damping: 0,
      obstacles: [{ kind: 'cylinder', center: [0, 0], radius: 0.45 }],
    }),
    rho = 1000,
    g = 9.81,
    // The surface the body floats on is the field's own: its height and the water's vertical velocity.
    sea = {
      cell: [0, 0, 0],
      density: rho,
      elevation: (x, z) => field.sampleHeight(x, z),
      pressure: (x, y, z) => rho * g * Math.max(0, field.sampleHeight(x, z) - y),
      water: {
        medium: 'water',
        cell: [0, 0, 0],
        sample: (x, y, z, _t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) => {
          const wet = y <= field.sampleHeight(x, z);
          out.velocity[0] = out.velocity[1] = out.velocity[2] = 0;
          out.density = wet ? rho : 0;
          out.temperature = 288;
          return out;
        },
      },
    },
    physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -g, 0] }),
    body = physics.addBody(null, {
      position: [0, 0.25, 0],
      colliders: { shape: 'box', halfExtents: [0.4, 0.2, 0.4], density: 500 },
    }),
    loads = new LoadSolver(),
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -g, 0] })
      .add(new RigidSolver(), { physics })
      .add(loads, { sea, bodies: await floating(physics, body, { sea, radiation: 'none' }) })
      .couple(['loads', 'rigid'], 'staggered');
  let before = 0,
    pushed = 0,
    largest = 0;
  for (let f = 1; f <= 120; f++) {
    world.advance(f);
    const now = loads.bodyLoad(0).submerged;
    if (now !== before) field.displace(body.position[0], body.position[2], 0.45, now - before);
    pushed += now - before;
    before = now;
    field.advance(1 / 60);
    // The ring's quadrature across 4.8 cells is within 1 % of the volume laid at each step, and the float32 heights round to
    // 1e-6 of the largest volume held: the field holds what the body pushed in (out of the water, nothing).
    largest = Math.max(largest, Math.abs(pushed));
    assert.ok(
      Math.abs(field.volume() - pushed) <= 0.01 * Math.abs(pushed) + 1e-6 * largest,
      `step ${f}: ${field.volume()} against ${pushed}`,
    );
  }
  // Let go 0.25 m above its draft of 0.2 m it swings out of the water and under it, and the field followed it both ways.
  assert.ok(largest > 0.25 && pushed >= 0 && pushed <= 0.8 * 0.4 * 0.8 * (1 + 1e-6), `displaced ${pushed} m^3`);
  assert.ok(body.position.every(Number.isFinite));
  physics[Symbol.dispose]();
});

test('SEA-04 displace refuses what it cannot lay, naming the fix', () => {
  const field = new RippleField({ size: 16, resolution: 64 });
  assert.throws(() => field.displace(0, 0, 0.01, 1), { code: 'unsupported', message: /radius/ });
  assert.throws(() => field.displace(0, 0, 0.5, 1e6), { code: 'unsupported', message: /wider radius/ });
  assert.throws(() => field.displace(0, 0, 0.5, Number.NaN), { code: 'unsupported' });
});
