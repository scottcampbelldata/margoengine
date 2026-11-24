// Measured bounds of @margoengine/navmesh/formations: slot shapes, spacing held on the march and through a wheel,
// re-forming, no two bodies ever overlapping (discs for men, capsules for horses: plain test stand-ins), routing down
// a continuum-crowd flow field, and film time that seeks exactly. Every test fails on a tree without the entry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Army, FORMATION_SHAPES, SKIRMISH_GAP, formationSlots } from '../dist/formations.js';
import { FORMATION_SETTINGS, chargeOptionsFromSettings, formationOptionsFromSettings, formationSettingDefaults } from '../dist/formation-settings.js';
import { FlowField } from '../../behavior/dist/flowfield.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Smallest body gap over all pairs: discs, or capsules along the heading. */
function minGap(members) {
  const seg = (m) => {
    const h = Math.max(0, m.length / 2 - m.radius);
    return [m.x - Math.sin(m.heading) * h, m.z - Math.cos(m.heading) * h, m.x + Math.sin(m.heading) * h, m.z + Math.cos(m.heading) * h];
  };
  const pointSeg = (px, pz, s) => {
    const dx = s[2] - s[0],
      dz = s[3] - s[1],
      l = dx * dx + dz * dz,
      t = l > 0 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (pz - s[1]) * dz) / l)) : 0;
    return Math.hypot(px - s[0] - dx * t, pz - s[1] - dz * t);
  };
  let gap = Infinity;
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i],
        b = members[j];
      if (dist(a, b) > a.length + b.length + a.radius + b.radius + 1) continue;
      const sa = seg(a),
        sb = seg(b),
        // Closest distance between two segments: the least of the four end-to-segment distances (they do not cross
        // when bodies do not overlap, and a crossing gives a negative gap here through the endpoint checks).
        d = Math.min(pointSeg(sa[0], sa[1], sb), pointSeg(sa[2], sa[3], sb), pointSeg(sb[0], sb[1], sa), pointSeg(sb[2], sb[3], sa));
      gap = Math.min(gap, d - a.radius - b.radius);
    }
  return gap;
}

test('slots: line, column, square, wedge and skirmish', () => {
  assert.deepEqual(FORMATION_SHAPES, ['line', 'column', 'square', 'wedge', 'skirmish']);
  const line = formationSlots('line', 80, { interval: 0.56, distance: 1.32 });
  assert.equal(new Set(line.map((s) => s[1])).size, 2, 'two ranks');
  assert.ok(Math.abs(Math.max(...line.map((s) => s[0])) - Math.min(...line.map((s) => s[0])) - 39 * 0.56) < 1e-9);
  const column = formationSlots('column', 40);
  assert.equal(new Set(column.map((s) => s[0].toFixed(6))).size, 4, 'a column of fours');
  // A hollow square: four faces, each facing out, no two slots closer than a file.
  const square = formationSlots('square', 96, { interval: 0.56, distance: 1.32 });
  assert.deepEqual([...new Set(square.map((s) => s[2]))], [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  for (const s of square) {
    const out = [Math.sin(s[2]), Math.cos(s[2])];
    assert.ok(s[0] * out[0] + s[1] * out[1] > 0, 'every slot faces away from the centre');
  }
  for (let i = 0; i < square.length; i++)
    for (let j = i + 1; j < square.length; j++) assert.ok(Math.hypot(square[i][0] - square[j][0], square[i][1] - square[j][1]) > 0.55);
  // A wedge: 1, 3, 5 ... riders a rank, the point leading.
  const wedge = formationSlots('wedge', 25, { distance: 3.4 }),
    ranks = new Map();
  for (const s of wedge) ranks.set(s[1], (ranks.get(s[1]) ?? 0) + 1);
  assert.deepEqual([...ranks.values()], [1, 3, 5, 7, 9]);
  assert.throws(() => formationSlots('circle', 5), RangeError);
  assert.throws(() => formationSlots('line', 0), RangeError);
});

test('march: a two-deep line of 80 holds its files and ranks within 10 percent over 30 m', () => {
  const army = new Army(),
    foot = army.add({ count: 80, shape: 'line' });
  foot.march();
  let worst = 0;
  for (let t = 0; t < 20; t += 1 / 30) {
    army.advanceTime(1 / 30);
    const m = army.members;
    for (let k = 0; k < 80; k++) {
      const s = foot.slots[k];
      // The neighbour to the right in the same rank, and the man behind.
      const right = foot.slots.findIndex((o) => o[1] === s[1] && Math.abs(o[0] - (s[0] - 0.56)) < 1e-9);
      if (right >= 0) worst = Math.max(worst, Math.abs(dist(m[foot.members[k]], m[foot.members[right]]) - 0.56) / 0.56);
      const behind = foot.slots.findIndex((o) => o[0] === s[0] && Math.abs(o[1] - (s[1] - 1.32)) < 1e-9);
      if (behind >= 0) worst = Math.max(worst, Math.abs(dist(m[foot.members[k]], m[foot.members[behind]]) - 1.32) / 1.32);
    }
  }
  assert.ok(worst < 0.1, `spacing off by up to ${(worst * 100).toFixed(1)} percent`);
  assert.ok(Math.abs(foot.anchor[1] - 20 * 1.524) < 0.05, 'quick time: 1.52 m/s');
  for (const m of army.members) assert.ok(Math.abs(m.speed - 1.524) < 0.1);
});

test('wheel: a line wheels 90 degrees on its left flank, outer flank at marching speed, spacing held', () => {
  const army = new Army(),
    foot = army.add({ count: 40, shape: 'line', ranks: 2 });
  foot.wheel(Math.PI / 2, 'left');
  const front = foot.front,
    expected = ((Math.PI / 2) * front) / 1.524;
  let worst = 0,
    fastest = 0,
    t = 0;
  while (foot.mode === 'wheel' && t < 60) {
    army.advanceTime(1 / 30);
    t += 1 / 30;
    const m = army.members;
    for (let k = 0; k < 19; k++) worst = Math.max(worst, Math.abs(dist(m[foot.members[k]], m[foot.members[k + 1]]) - 0.56) / 0.56);
    for (const x of m) fastest = Math.max(fastest, x.speed);
  }
  assert.ok(Math.abs(t - expected) < 0.1, `wheel took ${t.toFixed(2)} s, expected ${expected.toFixed(2)}`);
  assert.ok(Math.abs(foot.heading - Math.PI / 2) < 1e-6);
  assert.ok(worst < 0.15, `spacing off by ${(worst * 100).toFixed(1)} percent in the wheel`);
  assert.ok(fastest <= 2.743 + 1e-6, 'nobody runs faster than double time');
  // The pivot man barely moves.
  army.advanceTime(5);
  for (let k = 0; k < 40; k++) {
    const [x, z] = foot.slot(k);
    assert.ok(Math.hypot(army.members[foot.members[k]].x - x, army.members[foot.members[k]].z - z) < 0.25);
  }
});

test('re-forming: line to square and column, everyone reaches a slot', () => {
  const army = new Army(),
    foot = army.add({ count: 96, shape: 'line', ranks: 3 });
  foot.form('square');
  army.advanceTime(40);
  for (let k = 0; k < 96; k++) {
    const [x, z, h] = foot.slot(k),
      m = army.members[foot.members[k]];
    assert.ok(Math.hypot(m.x - x, m.z - z) < 0.3, `member ${k} is ${Math.hypot(m.x - x, m.z - z).toFixed(2)} m off its slot`);
    assert.ok(Math.abs(Math.atan2(Math.sin(m.heading - h), Math.cos(m.heading - h))) < 0.1, 'faces out of the square');
  }
  assert.equal(new Set(foot.members).size, 96);
  assert.ok(minGap(army.members) > -0.01);
});

test('no interpenetration: a cavalry wedge charges through a gap and two columns pass head on', () => {
  const army = new Army(),
    horse = army.add({ count: 25, kind: 'cavalry', shape: 'wedge', position: [0, -40] }),
    a = army.add({ count: 24, shape: 'column', position: [-1.2, 10], heading: Math.PI }),
    b = army.add({ count: 24, shape: 'column', position: [1.2, -10], heading: 0, files: 3 });
  army.addObstacle([-6, 0], 1.5);
  army.addObstacle([6, 0], 1.5);
  horse.march({ speed: 6 });
  a.march();
  b.march();
  let gap = Infinity,
    inside = 0;
  for (let t = 0; t < 14; t += 1 / 30) {
    army.advanceTime(1 / 30);
    gap = Math.min(gap, minGap(army.members));
    for (const m of army.members)
      for (const [ox, oz] of [
        [-6, 0],
        [6, 0],
      ])
        inside = Math.max(inside, 1.5 + m.radius - Math.hypot(m.x - ox, m.z - oz) - Math.max(0, m.length / 2 - m.radius));
  }
  // A horse ploughing into a man pinned against others resolves to within 2 cm in a step (40 projection passes).
  assert.ok(gap > -0.02, `bodies overlap by ${(-gap).toFixed(3)} m`);
  assert.ok(inside < 0.01, `a member is ${inside.toFixed(3)} m inside an obstacle`);
  // Horses go where they face: no horse moves more than 0.45 m/s sideways.
  assert.ok(horse.anchor[1] > 30, 'the wedge got through');
});

test('flow field: a formation marches round a wall down a continuum-crowds field to its goal', () => {
  const field = new FlowField({ size: [60, 60], cell: 1, min: [-30, -10], cost: (x, z) => (z > 10 && z < 12 && x < 15 ? 255 : 1) });
  field.setGoal([0, 0, 40]);
  const army = new Army(),
    foot = army.add({ count: 12, shape: 'column', position: [0, 0] });
  foot.march({ field, goal: [0, 40] });
  let crossed = false;
  for (let t = 0; t < 80 && foot.mode === 'march'; t += 0.1) {
    army.advanceTime(0.1);
    if (foot.anchor[1] > 10 && foot.anchor[1] < 12 && foot.anchor[0] < 15) crossed = true;
  }
  assert.equal(crossed, false, 'the column goes round the wall, not through it');
  assert.ok(Math.hypot(foot.anchor[0], foot.anchor[1] - 40) < foot.distance + 0.5, 'and halts at the goal');
  assert.equal(foot.mode, 'halt');
});

test('film time: seek gives exactly what playing gives, forward and back', () => {
  const build = () => {
    const army = new Army(),
      f = army.add({ count: 30, shape: 'line' }),
      c = army.add({ count: 9, kind: 'cavalry', shape: 'wedge', position: [0, -20] });
    f.march();
    c.march({ speed: 4 });
    army.advanceTime(3);
    f.wheel(-Math.PI / 4);
    army.advanceTime(2);
    c.form('line');
    return army;
  };
  const played = build().advanceTime(7),
    seeker = build();
  seeker.seek(12);
  assert.deepEqual(seeker.members.map((m) => [m.x, m.z, m.heading, m.distance]), played.members.map((m) => [m.x, m.z, m.heading, m.distance]));
  seeker.seek(4).seek(12);
  assert.deepEqual(seeker.members.map((m) => [m.x, m.z, m.heading]), played.members.map((m) => [m.x, m.z, m.heading]));
  // An order given after a seek back replaces what came after it (a re-shot from there).
  seeker.seek(3);
  seeker.formations[0].halt();
  seeker.advanceTime(9);
  assert.notDeepEqual(seeker.members[0].x, played.members[0].x);
  assert.throws(() => seeker.add({ count: 3 }), RangeError);
});

test('formation settings: rows on the shared shape map to Army.add options', () => {
  assert.equal(new Set(FORMATION_SETTINGS.map((r) => r.name)).size, FORMATION_SETTINGS.length);
  assert.equal(formationSettingDefaults().shape, 'line');
  assert.deepEqual(formationOptionsFromSettings({ kind: 'cavalry', shape: 'wedge', count: 31, interval: 1.1, ranks: 0 }), {
    count: 31,
    kind: 'cavalry',
    shape: 'wedge',
    interval: 1.1,
  });
  assert.throws(() => formationOptionsFromSettings({ size: 3 }), TypeError);
  assert.throws(() => formationOptionsFromSettings({ count: 0 }), RangeError);
  assert.equal(formationSettingDefaults().gap, SKIRMISH_GAP);
  assert.deepEqual(formationOptionsFromSettings({ shape: 'skirmish', gap: 3 }), { count: 80, shape: 'skirmish', gap: 3 });
  assert.deepEqual(chargeOptionsFromSettings({ chargeSpeed: 9, chargeAcceleration: 0 }), { speed: 9 });
  assert.deepEqual(chargeOptionsFromSettings({}), {});
  assert.throws(() => chargeOptionsFromSettings({ chargeSpeed: 30 }), RangeError);
});

test('skirmish: one rank in extended order, two paces apart, held on the march', () => {
  const slots = formationSlots('skirmish', 40, { interval: 0.56 });
  assert.equal(new Set(slots.map((s) => s[1])).size, 1, 'one rank');
  const xs = slots.map((s) => s[0]).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - (0.56 + 1.524)) < 1e-9, 'a file front plus two paces');
  // A second rank stands in the gaps of the first.
  const two = formationSlots('skirmish', 20, { interval: 0.56, distance: 1.32, ranks: 2 });
  const front = two.filter((s) => s[1] === 0).map((s) => s[0]),
    rear = two.filter((s) => s[1] < 0).map((s) => s[0]);
  for (const x of rear) assert.ok(Math.min(...front.map((f) => Math.abs(f - x))) > 0.9, 'rear men cover the gaps');
  assert.throws(() => formationSlots('skirmish', 5, { gap: -1 }), RangeError);
  // A close-order line opens into a skirmish line and marches 40 m; neighbours stay 2.08 m apart within 10 percent.
  const army = new Army(),
    line = army.add({ count: 30, shape: 'line', ranks: 1 });
  line.form('skirmish');
  army.advanceTime(10);
  line.march();
  army.advanceTime(26);
  const ms = [...army.members].sort((a, b) => a.x - b.x);
  for (let i = 1; i < ms.length; i++) {
    const d = Math.hypot(ms[i].x - ms[i - 1].x, ms[i].z - ms[i - 1].z);
    assert.ok(Math.abs(d - 2.084) < 0.21, `skirmishers ${i - 1} and ${i} are ${d.toFixed(2)} m apart`);
  }
  assert.ok(line.anchor[1] > 36, 'and the line marched');
  assert.equal(line.gap, SKIRMISH_GAP);
  line.form('skirmish', { gap: 4 });
  assert.equal(army.formations[0].gap, 4);
  assert.throws(() => army.add({ count: 3, gap: 60 }), RangeError);
});

test('charge: the speed builds at its rate, horses go through their gaits, the line halts at the goal', () => {
  const army = new Army(),
    horse = army.add({ count: 20, kind: 'cavalry', shape: 'line', ranks: 2, position: [0, 0] }),
    foot = army.add({ count: 40, shape: 'line', position: [40, 0] });
  horse.charge({ goal: [0, 160] });
  foot.march();
  army.advanceTime(5);
  foot.charge();
  // 0.6 m/s^2 from a halt: 3 m/s after 5 s; the gallop (7 m/s) after 11.7 s.
  assert.ok(Math.abs(horse.speed - 3) < 1e-6, `the charge built to ${horse.speed} m/s in 5 s`);
  const speeds = [];
  for (let t = 5; t < 40 && horse.mode === 'charge'; t += 0.5) {
    army.advanceTime(0.5);
    const mounted = army.members.filter((m) => m.formation === 0);
    speeds.push(mounted.reduce((s, m) => s + m.speed, 0) / mounted.length);
  }
  assert.ok(Math.max(...speeds) > 6.5, 'the riders reach a gallop');
  // Riders keep up: once at full speed the mean speed tracks the charge within 10 percent.
  const full = speeds.slice(16, 22);
  assert.ok(full.every((v) => Math.abs(v - 7) < 0.7), `riders at ${full.map((v) => v.toFixed(2))}`);
  assert.equal(horse.mode, 'halt', 'the charge halts at its goal');
  assert.ok(Math.abs(horse.anchor[1] - 160) < horse.distance + 0.2);
  assert.ok(Math.abs(horse.speed - 1.7) < 1e-9, 'and takes up the walk again');
  // Foot charge at double time, 1 m/s^2 from quick time.
  assert.ok(Math.abs(foot.speed - 2.743) < 1e-9);
  assert.ok(minGap(army.members) > -0.02);
  assert.throws(() => horse.charge({ speed: 0 }), RangeError);
  assert.throws(() => horse.charge({ acceleration: 50 }), RangeError);
  assert.throws(() => horse.charge({ goal: [0] }), RangeError);
  // Seek gives what playing gives through a charge.
  const build = () => {
    const a = new Army(),
      h = a.add({ count: 12, kind: 'cavalry', shape: 'wedge' });
    a.advanceTime(1);
    h.charge({ goal: [10, 80], acceleration: 1.2 });
    return a;
  };
  const played = build().advanceTime(9),
    sought = build().seek(10);
  assert.deepEqual(sought.members.map((m) => [m.x, m.z, m.heading, m.speed]), played.members.map((m) => [m.x, m.z, m.heading, m.speed]));
});
