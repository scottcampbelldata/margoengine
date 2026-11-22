// @margoengine/procedural/flyer: the 1903 Wright Flyer has its published size and parts, and the four flights of
// 17 December 1903 cover their recorded distances in their recorded times, smoothly, with the first flight's
// groundspeed and airspeed in the 27 mph wind.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateWrightFlyer,
  wrightFlightPose,
  wrightGustRoll,
  restrainingWire,
  WRIGHT_FLIGHTS_1903,
  WRIGHT_RAIL,
} from '../dist/flyer.js';

const FT = 0.3048,
  MPH = 1609.344 / 3600;

function bounds(list) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const g of list)
    for (let i = 0; i < g.positions.length; i += 3)
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k], g.positions[i + k]);
        b[k + 3] = Math.max(b[k + 3], g.positions[i + k]);
      }
  return b;
}

function wellFormed(g, name) {
  const n = g.positions.length / 3;
  assert.ok(n > 0 && g.indices.length > 0 && g.indices.length % 3 === 0, `${name} has triangles`);
  assert.equal(g.normals.length, g.positions.length, `${name} normals`);
  assert.equal(g.uvs.length, n * 2, `${name} uvs`);
  for (const i of g.indices) assert.ok(i < n, `${name} index in range`);
  for (const v of g.positions) assert.ok(Number.isFinite(v), `${name} finite`);
}

test('generateWrightFlyer: 40 ft 4 in span, 21 ft 1 in long, under 9 ft 3 in tall, skids on y = 0', () => {
  const f = generateWrightFlyer();
  const all = [
    f.wings,
    f.frame,
    f.engine,
    f.cradle,
    f.elevator.geometry,
    f.rudder.geometry,
    ...f.propellers.map((p) => p.geometry),
  ];
  for (const [i, g] of all.entries()) wellFormed(g, `part ${i}`);
  const [x0, y0, z0, x1, y1, z1] = bounds(all);
  assert.ok(Math.abs(x1 - x0 - (40 * FT + 4 * 0.0254)) < 0.02, `span ${x1 - x0}`);
  assert.ok(Math.abs(z1 - z0 - (21 * FT + 0.0254)) < 0.1, `length ${z1 - z0}`);
  assert.ok(y1 - y0 > 2.4 && y1 - y0 <= 9 * FT + 3 * 0.0254, `height ${y1 - y0}`);
  assert.ok(Math.abs(y0) < 1e-6, 'skids on y = 0');
  assert.ok(Math.abs(x0 + x1) < 1e-6, 'symmetric about x = 0');
});

test('generateWrightFlyer: the wing tips droop by the option, and the propellers turn opposite ways on their own pivots', () => {
  const tipLow = (f) => {
    let y = Infinity;
    for (let i = 0; i < f.wings.positions.length; i += 3)
      if (Math.abs(f.wings.positions[i]) > 6.1) y = Math.min(y, f.wings.positions[i + 1]);
    return y;
  };
  const level = generateWrightFlyer({ droop: 0 }),
    drooped = generateWrightFlyer({ droop: 0.254 });
  assert.ok(Math.abs(tipLow(level) - tipLow(drooped) - 0.254) < 0.01);
  const [l, r] = drooped.propellers;
  assert.equal(l.spin, -1);
  assert.equal(r.spin, 1);
  assert.ok(l.pivot[0] > 0 && r.pivot[0] < 0 && l.pivot[0] === -r.pivot[0], 'left propeller at +X, right at -X');
  // Each propeller is 8 ft 6 in across about its pivot.
  const [px0, , , px1] = bounds([r.geometry]);
  assert.ok(Math.abs(px1 - px0 - 8.5 * FT) < 0.05, `propeller ${px1 - px0}`);
  assert.ok(drooped.elevator.pivot[2] > 2.5 && drooped.rudder.pivot[2] < -2, 'elevator ahead, rudders behind');
  // The engine (crankcase, four cylinders, flywheel, radiator, tank) sits between the wings, right of the pilot.
  const [ex0, ey0, , ex1, ey1] = bounds([drooped.engine]);
  assert.ok(ey0 > 0.55 && ey1 < 0.62 + 1.88 + 0.1, `engine height ${ey0}..${ey1}`);
  assert.ok(ex0 > -1.8 && ex1 < 1.8, 'engine and chain tubes inside the propeller shafts');
  assert.throws(() => generateWrightFlyer({ span: 0 }), RangeError);
  assert.throws(() => generateWrightFlyer({ segments: 4 }), RangeError);
});

test('wrightFlightPose: every flight leaves the rail after the 40 ft run and lands its recorded distance on in its recorded time', () => {
  assert.deepEqual(
    WRIGHT_FLIGHTS_1903.map((f) => [f.n, f.pilot, Math.round(f.distance / FT), f.seconds]),
    [
      [1, 'Orville', 120, 12],
      [2, 'Wilbur', 175, 12],
      [3, 'Orville', 200, 15],
      [4, 'Wilbur', 852, 59],
    ],
  );
  for (const f of WRIGHT_FLIGHTS_1903) {
    const d = wrightFlightPose(f.n, 0).duration;
    let liftoff = null,
      landing = null,
      prev = wrightFlightPose(f.n, 0);
    for (let t = 1 / 30; t <= d + 1; t += 1 / 30) {
      const p = wrightFlightPose(f.n, t);
      if (prev.phase === 'rail' && p.phase === 'air') liftoff = { t, z: prev.position[2] };
      if (prev.phase === 'air' && p.phase === 'landed') landing = { t, z: p.position[2] };
      // Smooth: no step over a frame beyond what the speed allows, heights never under the sand.
      assert.ok(Math.abs(p.position[2] - prev.position[2]) < 0.2, `flight ${f.n} z step at ${t}`);
      assert.ok(Math.abs(p.position[1] - prev.position[1]) < 0.2, `flight ${f.n} y step at ${t}`);
      assert.ok(p.position[1] >= 0 && p.position[1] <= f.height, `flight ${f.n} height at ${t}`);
      assert.ok(Math.abs(p.pitch) <= 0.35 && Math.abs(p.roll) < 0.1, `flight ${f.n} attitude at ${t}`);
      prev = p;
    }
    assert.ok(liftoff && Math.abs(liftoff.z - WRIGHT_RAIL.run) < 0.2, `flight ${f.n} lift-off ${liftoff?.z}`);
    assert.ok(
      landing && Math.abs(landing.z - WRIGHT_RAIL.run - f.distance) < 0.2,
      `flight ${f.n} landing ${landing?.z}`,
    );
    assert.ok(Math.abs(landing.t - liftoff.t - f.seconds) < 0.05, `flight ${f.n} air time ${landing.t - liftoff.t}`);
  }
});

test('wrightFlightPose: the first flight makes 6.8 mph over the ground and 34 mph through the air in the 27 mph wind', () => {
  // The air time ends 12 s after the 40 ft run; sample its middle.
  const tAir = (2 * WRIGHT_RAIL.run) / ((120 * FT) / 12) + 10;
  const a = wrightFlightPose(1, tAir - 4),
    b = wrightFlightPose(1, tAir - 2);
  const ground = (b.position[2] - a.position[2]) / 2;
  assert.ok(Math.abs(ground / MPH - 6.8) < 0.1, `groundspeed ${ground / MPH} mph`);
  assert.ok(Math.abs((ground + 27 * MPH) / MPH - 34) < 0.5, 'airspeed');
  // The propellers turn at 350 rpm.
  const p0 = wrightFlightPose(1, 1).propeller,
    p1 = wrightFlightPose(1, 2).propeller;
  assert.ok(Math.abs(p1 - p0 - (2 * Math.PI * 350) / 60) < 1e-9);
  assert.throws(() => wrightFlightPose(5, 0), RangeError);
  assert.throws(() => wrightFlightPose(1, Number.NaN), RangeError);
});

// The prone pilot faces +Z with +Y up in glTF's right-handed space, so his right is forward x up.
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// Mean vertex x: the chain tubes reach both propellers, so the bounding box of the engine part is centred.
const centreX = (g) => {
  let sum = 0;
  for (let i = 0; i < g.positions.length; i += 3) sum += g.positions[i];
  return sum / (g.positions.length / 3);
};

test("generateWrightFlyer: the engine is on the pilot's right and his hip cradle on his left, as in 1903 (glTF space)", () => {
  const right = cross([0, 0, 1], [0, 1, 0]);
  assert.deepEqual(
    right.map((v) => v + 0),
    [-1, 0, 0],
  );
  const f = generateWrightFlyer(),
    side = (x) => Math.sign(x * right[0]); // +1 on the pilot's right, -1 on his left
  assert.equal(side(centreX(f.engine)), 1, `engine centre x ${centreX(f.engine)}`);
  assert.equal(side(centreX(f.cradle)), -1, `cradle centre x ${centreX(f.cradle)}`);
  assert.equal(side(f.pilot.hips[0]), -1, 'pilot hips left of centre');
  assert.equal(side(f.pilot.head[0]), -1, 'pilot head left of centre');
  assert.ok(Math.abs(f.pilot.hips[0] - centreX(f.cradle)) < 0.05, 'pilot lies in the cradle');
  assert.equal(side(f.propellers[0].pivot[0]), -1, 'propellers[0] is the left one');
  assert.equal(side(f.propellers[1].pivot[0]), 1, 'propellers[1] is the right one');
});

test('generateWrightFlyer: each propeller pushes the Flyer forward when it turns its own way', () => {
  // A blade element moving along v drives the air backward (thrust +Z) when its leading edge, the end facing v, sits
  // further toward +Z: the position along the motion and the z offset correlate positively over the blades.
  for (const p of generateWrightFlyer().propellers) {
    const g = p.geometry.positions;
    let sum = 0;
    for (let i = 0; i < g.length; i += 3) {
      const rx = g[i] - p.pivot[0],
        ry = g[i + 1] - p.pivot[1],
        rz = g[i + 2] - p.pivot[2],
        r = Math.abs(rx);
      if (r < 0.3) continue; // the hub
      // The blades lie along x through the pivot, so a point there moves along y by spin * sign(rx); its offset
      // along that motion is ry * spin * sign(rx), set against its z offset.
      sum += ry * p.spin * Math.sign(rx) * rz;
    }
    assert.ok(sum > 0, `propeller at x ${p.pivot[0]} spin ${p.spin}: thrust measure ${sum}`);
  }
});

test("generateWrightFlyer: the elevator lever stands at the pilot's left hand ahead of the cradle, and the restraint tie is at the skids' rear", () => {
  const f = generateWrightFlyer();
  wellFormed(f.lever.geometry, 'lever');
  const [x0, y0, z0, x1, y1, z1] = bounds([f.lever.geometry]);
  assert.ok(
    x0 > f.pilot.hips[0] && x1 < f.pilot.hips[0] + 0.5,
    `lever left of the hips (pilot's left is +X): ${x0} ${x1}`,
  );
  assert.ok(z0 > f.pilot.hips[2] && z1 < f.pilot.head[2] + 0.2, `lever ahead of the hips, by the head: ${z0} ${z1}`);
  assert.ok(y1 - y0 > 0.35 && y1 - y0 < 0.6, `lever height ${y1 - y0}`);
  assert.deepEqual(f.lever.axis, [1, 0, 0]);
  assert.ok(Math.abs(f.lever.pivot[1] - y0) < 0.05, 'the lever turns about its foot');
  // The skids run back to 0.3 m behind the rear spar (the wing's trailing edge less 0.12 m).
  assert.ok(
    f.restraint.tie[2] < -1.1 && f.restraint.tie[2] > -1.3 && f.restraint.tie[1] < 0.2,
    `tie at the skids' rear: ${f.restraint.tie}`,
  );
});

test('restrainingWire: taut runs straight, slack sags an eighth of its length and lies on the sand', () => {
  const taut = restrainingWire([0, 0.08, -2], [0, 0.08, -5], 0);
  const loose = restrainingWire([0, 0.5, -2], [0, 0.08, -6], 1, 0.05);
  wellFormed(taut, 'taut wire');
  wellFormed(loose, 'loose wire');
  const t = bounds([taut]);
  assert.ok(t[4] - t[1] < 0.02, 'taut wire is straight');
  const l = bounds([loose]);
  assert.ok(l[1] >= 0.05 && l[1] < 0.07, `loose wire lies on the sand at 0.05: ${l[1]}`);
  const mid = restrainingWire([0, 2, 0], [0, 2, -8], 1);
  assert.ok(Math.abs(bounds([mid])[1] - (2 - 1)) < 0.05, 'an 8 m wire sags 1 m at the middle');
  assert.throws(() => restrainingWire([0, 0], [0, 0, 1]), RangeError);
});

test('generateWrightFlyer wrecked: the right wings crushed toward the sand, ribs broken out, engine askew; the left side kept', () => {
  const whole = generateWrightFlyer(),
    wreck = generateWrightFlyer({ wrecked: true });
  for (const k of ['wings', 'frame', 'ribs', 'wires', 'engine']) wellFormed(wreck[k], `wrecked ${k}`);
  const tipHeight = (g, side) => {
    let y = -Infinity;
    for (let i = 0; i < g.positions.length; i += 3)
      if (side * g.positions[i] > 5.5) y = Math.max(y, g.positions[i + 1]);
    return y;
  };
  assert.ok(tipHeight(wreck.wings, -1) < tipHeight(whole.wings, -1) - 0.5, 'right tip crushed down');
  assert.equal(tipHeight(wreck.wings, 1), tipHeight(whole.wings, 1), 'left tip as flown');
  assert.ok(wreck.ribs.indices.length < whole.ribs.indices.length * 0.95, 'ribs broken out');
  assert.notDeepEqual(bounds([wreck.engine]), bounds([whole.engine]), 'engine knocked askew');
  assert.deepEqual(
    generateWrightFlyer({ wrecked: true }).wings.positions,
    wreck.wings.positions,
    'the same seed, the same wreck',
  );
  assert.notDeepEqual(
    generateWrightFlyer({ wrecked: true, seed: 7 }).wings.positions,
    wreck.wings.positions,
    'another seed, another wreck',
  );
});

test('wrightGustRoll: the left wing lifts, the Flyer turns over its tips once and rests, rolling on its tips', () => {
  const p0 = wrightGustRoll(0);
  assert.equal(p0.phase, 'standing');
  assert.deepEqual(p0.position, [0, 0, 0]);
  const lifting = wrightGustRoll(0.6);
  assert.ok(lifting.roll < 0 && lifting.roll > -0.4, `left wing lifting: ${lifting.roll}`);
  const end = wrightGustRoll(p0.duration + 1);
  assert.equal(end.phase, 'rest');
  assert.ok(Math.abs(end.roll + 2 * Math.PI) < 1e-9, 'one full turn');
  let last = 0;
  for (let t = 0; t <= p0.duration; t += 0.05) {
    const p = wrightGustRoll(t);
    assert.ok(p.roll <= last + 1e-12, 'turns one way only');
    last = p.roll;
    const half = 6.145;
    assert.ok(p.position[1] <= half && p.position[1] >= 0, 'centre above the sand, under half the span');
    if (Math.abs(Math.sin(p.roll)) > 0.99) assert.ok(p.position[1] > 5, 'on its tip, the centre is up');
  }
  assert.ok(end.position[0] < -10, `carried sideways by the roll: ${end.position[0]}`);
  assert.throws(() => wrightGustRoll(NaN), RangeError);
});
