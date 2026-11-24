// Period vehicles (sheet row 14): each one's sizes are measured on its geometry and checked against the published
// figures its source states (docs/clean-room.md, "Period vehicles").
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACK_TO_BACK,
  COUPLER_HEIGHT,
  GAUGE,
  LOCOMOTIVE_ARRANGEMENTS,
  VEHICLE_SETTINGS,
  WAGON_KINDS,
  generateKeiTruck,
  generateLocomotive,
  generateTouringCar,
  generateVendingMachine,
  generateWagon,
  vehicleBounds,
  vehicleOptionsFromSettings,
  vehicleSettingDefaults,
} from '@margoengine/procedural/vehicles';

const IN = 0.0254,
  FT = 12 * IN;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} for ${b}`);
const ok = (g) => {
  assert.ok(g.positions.length > 0 && g.positions.every(Number.isFinite) && g.normals.every(Number.isFinite));
  for (const i of g.indices) assert.ok(i < g.positions.length / 3);
};
// AAR Plate B: 10 ft 8 in wide, 15 ft 6 in above the rail.
const PLATE_B = { width: 10 * FT + 8 * IN, height: 15 * FT + 6 * IN };

test('locomotive: Whyte wheel counts, standard gauge wheels, MCB coupler and flange, inside Plate B', () => {
  assert.equal(GAUGE, 1.435);
  near(GAUGE, 4 * FT + 8.5 * IN, 1e-3, 'standard gauge 4 ft 8 1/2 in');
  near(BACK_TO_BACK, 4 * FT + 5.375 * IN, 1e-3, 'back-to-back 4 ft 5 3/8 in');
  assert.ok(COUPLER_HEIGHT >= 32.5 * IN && COUPLER_HEIGHT <= 34.5 * IN, 'MCB coupler height 32 1/2 to 34 1/2 in');
  for (const arrangement of LOCOMOTIVE_ARRANGEMENTS) {
    const l = generateLocomotive({ arrangement }),
      [lead, drive, trail] = arrangement.split('-').map(Number),
      count = (k) => l.wheels.filter((w) => w.kind === k).length;
    assert.equal(count('leading'), lead / 2, arrangement);
    assert.equal(count('driver'), drive / 2, arrangement);
    assert.equal(count('trailing'), trail / 2, arrangement);
    assert.equal(count('tender'), 4, 'two four-wheel tender trucks');
    for (const g of Object.values(l.parts)) ok(g);
    // Measured: the flanges reach 1 in below the rail top; nothing passes Plate B.
    const w = vehicleBounds(l.parts, ['wheels']);
    near(w.lo[1], -1 * IN, 1e-4, `${arrangement} flange below the rail`);
    const all = vehicleBounds(l.parts);
    assert.ok(all.hi[1] <= PLATE_B.height, `${arrangement} height ${all.hi[1]}`);
    assert.ok(all.hi[2] - all.lo[2] <= PLATE_B.width, `${arrangement} width ${all.hi[2] - all.lo[2]}`);
    // Drivers clear one another, and the measured wheel faces sit on the back-to-back.
    const d = l.wheels.filter((x) => x.kind === 'driver').map((x) => x.x);
    for (let i = 1; i < d.length; i++) assert.ok(d[i - 1] - d[i] > l.wheels[0].diameter);
    assert.ok(l.length > 15 && l.length < 22, `${arrangement} length over couplers ${l.length}`);
  }
  // The 2-8-0 Consolidation: 52 in drivers, about a 15 ft driving wheelbase, the stack top about 15 ft above the rail.
  const c = generateLocomotive();
  assert.equal(c.arrangement, '2-8-0');
  near(c.wheels.find((w) => w.kind === 'driver').diameter, 52 * IN, 0.01, '52 in drivers');
  near(c.drivingWheelbase, 15 * FT, 0.15, 'driving wheelbase');
  near(vehicleBounds(c.parts, ['smokebox']).hi[1], 15 * FT, 0.1, 'stack top');
  // Inner wheel faces on the back-to-back: the wheels' vertices nearest the centre plane outside the axle.
  const g = c.parts.wheels;
  let inner = Infinity;
  for (let i = 0; i < g.positions.length; i += 3) {
    const r = Math.hypot(g.positions[i + 1] - c.wheels[0].diameter / 2, g.positions[i] - c.wheels[0].x);
    if (Math.abs(g.positions[i] - c.wheels[0].x) < 1 && r > c.wheels[0].diameter * 0.45 && r < c.wheels[0].diameter * 0.5)
      inner = Math.min(inner, Math.abs(g.positions[i + 2]));
  }
  near(2 * inner, BACK_TO_BACK, 0.002, 'measured back-to-back');
  assert.ok(generateLocomotive({ tender: false }).length < c.length - 6);
  assert.ok(generateLocomotive({ fuel: 'coal' }).parts.load);
  assert.throws(() => generateLocomotive({ arrangement: '4-8-4' }), RangeError);
  assert.throws(() => generateLocomotive({ driver: 3 }), RangeError);
  assert.throws(() => generateLocomotive({ tender: 'yes' }), TypeError);
});

test('freight cars: 36 ft MCB box car, arch bar trucks of 5 ft wheelbase and 33 in wheels, inside Plate B', () => {
  for (const kind of WAGON_KINDS) {
    const w = generateWagon({ kind });
    for (const g of Object.values(w.parts)) ok(g);
    assert.equal(w.wheels.length, 4, 'two trucks of two wheel sets');
    for (const x of w.wheels) near(x.diameter, 33 * IN, 1e-3, '33 in wheels');
    near(w.wheels[1].x - w.wheels[0].x, 5 * FT, 1e-3, 'truck wheelbase');
    const b = vehicleBounds(w.parts);
    assert.ok(b.hi[1] <= PLATE_B.height && b.hi[2] - b.lo[2] <= PLATE_B.width, kind);
    near(vehicleBounds(w.parts, ['trucks']).lo[1], -1 * IN, 1e-4, `${kind} flanges`);
  }
  const box = generateWagon();
  near(vehicleBounds(box.parts, ['body']).hi[0] - vehicleBounds(box.parts, ['body']).lo[0], 36 * FT, 0.01, 'box car body');
  // About 8 ft inside height over the deck.
  near(vehicleBounds(box.parts, ['body']).hi[1] - box.deck, 8 * FT + 4 * IN, 0.1, 'box car side height');
  assert.ok(generateWagon({ kind: 'log-car' }).parts.load && generateWagon({ kind: 'gondola' }).parts.load);
  assert.deepEqual(generateWagon({ kind: 'log-car', seed: 3 }).parts.load.positions, generateWagon({ kind: 'log-car', seed: 3 }).parts.load.positions);
  assert.notDeepEqual(generateWagon({ kind: 'log-car', seed: 3 }).parts.load.positions, generateWagon({ kind: 'log-car', seed: 4 }).parts.load.positions);
  assert.throws(() => generateWagon({ length: 30 }), RangeError);
});

test('touring car: 100 in wheelbase, 56 in track and 30 in wheels measured on the tyres', () => {
  for (const top of ['up', 'down']) {
    const c = generateTouringCar({ top });
    for (const g of Object.values(c.parts)) ok(g);
    const t = vehicleBounds(c.parts, ['tyres']);
    near(t.hi[0] - t.lo[0], 100 * IN + 30 * IN, 1e-3, 'wheelbase plus a wheel');
    near(t.lo[1], 0, 1e-4, 'tyres on the ground');
    near(t.hi[1], 30 * IN, 1e-3, '30 in wheels');
    // Track, centre to centre of the tyres: the outer width less one rear tyre's width (3 1/2 in).
    near(t.hi[2] - t.lo[2] - 3.5 * IN, 56 * IN, 1e-3, '56 in track');
    assert.ok(c.size[0] > 3.2 && c.size[0] < 3.6 && c.size[2] < 2.2, `size ${c.size}`);
  }
  assert.ok(vehicleBounds(generateTouringCar().parts, ['top']).hi[1] > vehicleBounds(generateTouringCar({ top: 'down' }).parts, ['top']).hi[1] + 0.5);
  assert.throws(() => generateTouringCar({ top: 'off' }), RangeError);
});

test('kei truck: inside the kei class, the Carry DA63T catalogue sizes, 145R12 tyres, a 1.94 by 1.41 m bed', () => {
  for (const gates of ['closed', 'open']) {
    const k = generateKeiTruck({ gates });
    for (const g of Object.values(k.parts)) ok(g);
    const body = vehicleBounds(k.parts, Object.keys(k.parts).filter((p) => p !== 'mirrors')),
      L = body.hi[0] - body.lo[0],
      W = body.hi[2] - body.lo[2],
      H = body.hi[1] - body.lo[1];
    assert.ok(L <= 3.4 && W <= 1.48 && H <= 2.0, `kei class: ${L} by ${W} by ${H}`);
    near(L, 3.395, 0.01, 'length');
    near(W, 1.475, 0.01, 'width');
    near(H, 1.765, 0.01, 'height');
    near(body.lo[1], 0, 1e-4, 'on the ground');
    const t = vehicleBounds(k.parts, ['tyres']);
    // 145R12 at 80 %: 12 in rim plus two 116 mm sidewalls.
    near(t.hi[1], 12 * IN + 2 * 0.145 * 0.8, 1e-3, 'tyre diameter');
    near(t.hi[0] - t.lo[0] - k.wheel, 1.9, 1e-3, 'wheelbase');
  }
  const k = generateKeiTruck();
  near(k.bed.length, 1.94, 1e-9, 'bed length');
  near(k.bed.width, 1.41, 1e-9, 'bed width');
  // Closed gates stand 0.29 m over the floor; open ones hang below it.
  near(vehicleBounds(k.parts, ['bed']).hi[1], k.bed.floor + 1.0, 0.03, 'guard frame top');
  assert.ok(vehicleBounds(generateKeiTruck({ gates: 'open' }).parts, ['bed']).lo[1] < k.bed.floor - 0.25);
  assert.throws(() => generateKeiTruck({ color: [2, 0, 0] }), RangeError);
});

test('vending machine: coin, bill, change and keypad inside the ADA forward reach, 1.83 m by 0.72 m deep', () => {
  for (const rows of [2, 3, 4]) {
    const v = generateVendingMachine({ rows, width: 1.2 });
    for (const g of Object.values(v.parts)) ok(g);
    for (const h of [v.controls.coin, v.controls.bill, v.controls.change, ...v.keypad]) assert.ok(h >= 15 * IN && h <= 48 * IN, `reach ${h}`);
    near(v.size[2], 1.86, 0.001, 'height with its canopy');
    near(v.size[1], 1.24, 0.001, 'width');
    assert.ok(v.samples >= rows * 6);
    assert.ok(v.buttons[0] < v.buttons[1] || rows === 1);
  }
  const a = generateVendingMachine({ seed: 2 }),
    b = generateVendingMachine({ seed: 2 });
  assert.deepEqual(a.parts.samples.positions, b.parts.samples.positions);
  assert.throws(() => generateVendingMachine({ rows: 2.5 }), RangeError);
  assert.throws(() => generateVendingMachine({ width: 2 }), RangeError);
});

test('vehicle slider rows: defaults are the generators defaults, values map to options', () => {
  const d = vehicleSettingDefaults();
  assert.equal(Object.keys(d).length, VEHICLE_SETTINGS.length);
  const o = vehicleOptionsFromSettings(d);
  assert.deepEqual(generateLocomotive(o.locomotive).wheels, generateLocomotive().wheels);
  assert.deepEqual(generateWagon(o.wagon).size, generateWagon().size);
  assert.deepEqual(generateKeiTruck(o.kei).size, generateKeiTruck().size);
  assert.deepEqual(generateVendingMachine(o.vending).size, generateVendingMachine().size);
  assert.deepEqual(generateTouringCar(o.car).size, generateTouringCar().size);
  assert.equal(vehicleOptionsFromSettings({ 'locomotive.tender': 'off' }).locomotive.tender, false);
  assert.throws(() => vehicleOptionsFromSettings({ 'locomotive.wings': 2 }));
});
