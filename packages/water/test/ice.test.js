// Ice on the sea (water/ice), each measured bound as a test that fails without its law: the absorption of ice is Warren
// and Brandt's table, white bubbly ice is brighter than clear ice and clear ice is blue; a berg floats with the share of
// its volume under water that the density ratio gives, at the waterline, draft and freeboard a box has in closed form;
// its metacentric height and periods are a box's, and it rolls over below Weeks and Mellor's width to height ratio;
// sea ice never overlaps, sits at its freeboard, drifts at 2% of the wind turned 25 degrees right, seeks to the same
// field it steps to, and rides less of the swell deeper into the field (Doble et al. 2015); the foam is whiter on the
// weather side; the spray bursts at a surge; the slider rows reach every target.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BergFoam,
  BergSpray,
  ICE_IMAGINARY_INDEX,
  IceMaterial,
  Iceberg,
  SeaIce,
  bubbleFraction,
  capsizeRatio,
  iceAbsorption,
  iceAlbedo,
  iceBuoyancy,
  iceTransmittance,
  waveErosion,
} from '../dist/ice.js';
import { ICE_LOOKS, ICE_SETTINGS, applyIceSettings, iceSettingDefaults } from '../dist/settings.js';

const G = 9.81;
// A closed triangle list, each triangle wound outward (counter-clockwise from outside) by turning it to face away from
// `inside`.
function wound(tris, inside) {
  const out = [];
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = [(a[0] + b[0] + c[0]) / 3 - inside[0], (a[1] + b[1] + c[1]) / 3 - inside[1], (a[2] + b[2] + c[2]) / 3 - inside[2]];
    out.push(...(n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0 ? [a, b, c] : [a, c, b]));
  }
  return { positions: new Float64Array(out.flat()) };
}
function box(w, h, l, y0 = 0) {
  const x = [-w / 2, w / 2],
    y = [y0, y0 + h],
    z = [-l / 2, l / 2];
  const p = (i, j, k) => [x[i], y[j], z[k]];
  const quads = [
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
  ];
  return wound(quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]), [0, y0 + h / 2, 0]);
}
// A lumpy sphere: radius r times a fixed wobble, star-shaped about its centre.
function lump(r, skew = 0, rings = 24, sectors = 48) {
  const at = (i, j) => {
    const t = (Math.PI * i) / rings,
      f = (2 * Math.PI * j) / sectors,
      k = r * (1 + 0.15 * Math.sin(3 * f) * Math.sin(2 * t) + 0.08 * Math.cos(5 * t) + skew * Math.max(0, Math.cos(f - 0.6)) * Math.max(0, Math.cos(t)));
    return [k * Math.sin(t) * Math.cos(f) * 1.3, k * Math.cos(t), k * Math.sin(t) * Math.sin(f)];
  };
  const tris = [];
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < sectors; j++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      if (i > 0) tris.push([a, b, d]);
      if (i < rings - 1) tris.push([b, c, d]);
    }
  return wound(tris, [0, 0, 0]);
}
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} against ${b} (tolerance ${tol})`);

test('the absorption of ice is the Warren and Brandt 2008 table, and clear ice is blue', () => {
  assert.equal(ICE_IMAGINARY_INDEX.length, 31);
  close(iceAbsorption(600), (4 * Math.PI * 5.73e-9) / 600e-9, 1e-12, 'absorption at 600 nm');
  close(iceAbsorption(450), (4 * Math.PI * 9.239e-11) / 450e-9, 1e-14, 'absorption at 450 nm');
  // Red light dies a hundred times faster than blue.
  assert.ok(iceAbsorption(650) / iceAbsorption(450) > 100);
  assert.deepEqual(iceTransmittance(0), [1, 1, 1]);
  const t = iceTransmittance(10);
  assert.ok(t[0] < t[1] && t[1] < t[2], `10 m of ice is blue: ${t}`);
  close(t[2], 0.98, 0.02, 'blue through 10 m');
  assert.ok(t[0] < 0.25, `red through 10 m: ${t[0]}`);
});

test('bubbly ice is white and clear ice blue (Mullen and Warren 1988, Bohren and Barkstrom 1974)', () => {
  const white = iceAlbedo(0.05, 0.5),
    clear = iceAlbedo(0.002, 1);
  assert.ok(white.every((c) => c > 0.75), `white ice ${white}`);
  assert.ok(white[2] > white[0], 'white ice is a little blue');
  assert.ok(clear[2] > clear[0] * 2, `clear ice ${clear} is blue`);
  for (let k = 0; k < 3; k++) assert.ok(white[k] > clear[k]);
  // More, smaller bubbles scatter more: brighter.
  assert.ok(iceAlbedo(0.1, 0.5)[0] > iceAlbedo(0.02, 0.5)[0]);
  assert.ok(iceAlbedo(0.05, 0.2)[0] > iceAlbedo(0.05, 2)[0]);
  close(bubbleFraction(917), 0, 0, 'pure ice holds no air');
  close(bubbleFraction(870), 1 - 870 / 917, 1e-15, 'bubbles of 870 kg/m^3 ice');
});

test('a berg floats with the density ratio of its volume under water (Archimedes)', () => {
  for (const ice of [850, 900, 917])
    for (const water of [1020, 1027]) {
      const b = iceBuoyancy(lump(30), { iceDensity: ice, waterDensity: water });
      close(b.submergedFraction, ice / water, 1e-9, `submerged share at ${ice} / ${water}`);
      assert.ok(b.buoyancyCentre[1] < b.waterline && b.buoyancyCentre[1] < b.centroid[1], 'buoyancy below the waterline and the centre of mass');
    }
  // A box: the waterline, draft, freeboard and waterplane are closed form.
  const [w, h, l] = [40, 50, 60],
    a = 900 / 1027,
    b = iceBuoyancy(box(w, h, l, -10));
  close(b.volume, w * h * l, 1e-6, 'volume');
  close(b.waterline, -10 + a * h, 1e-9, 'waterline');
  close(b.draft, a * h, 1e-9, 'draft');
  close(b.freeboard, (1 - a) * h, 1e-9, 'freeboard');
  close(b.waterplaneArea, w * l, 1e-6 * w * l, 'waterplane area');
  close(b.length, l, 1e-9, 'length');
  close(b.beam, w, 1e-9, 'beam');
  close(b.mass, 900 * w * h * l, 1e-3, 'mass');
  // About nine tenths under: the brief's 90%.
  assert.ok(b.submergedFraction > 0.85 && b.submergedFraction < 0.9);
});

test("a box berg's metacentric heights and periods are the closed forms, and it rolls over below Weeks and Mellor's ratio", () => {
  const [w, h, l] = [60, 50, 80],
    a = 900 / 1027,
    d = a * h,
    b = iceBuoyancy(box(w, h, l));
  const gm = (width) => (width * width) / (12 * d) + d / 2 - h / 2;
  close(b.rollMetacentricHeight, gm(w), 2e-3 * Math.abs(gm(w)), 'roll GM');
  close(b.pitchMetacentricHeight, gm(l), 2e-3 * Math.abs(gm(l)), 'pitch GM');
  close(b.heavePeriod, 2 * Math.PI * Math.sqrt((a * h) / G), 1e-4, 'heave period');
  close(b.rollPeriod, 2 * Math.PI * Math.sqrt((w * w + h * h) / 12 / (G * gm(w))), 2e-3 * b.rollPeriod, 'roll period');
  const eps = capsizeRatio(900, 1027);
  close(eps, Math.sqrt(6 * a * (1 - a)), 1e-15, 'critical ratio');
  const narrow = iceBuoyancy(box(0.97 * eps * h, h, 3 * h)),
    wide = iceBuoyancy(box(1.03 * eps * h, h, 3 * h));
  assert.ok(narrow.rollMetacentricHeight < 0 && !narrow.stable, `W/H 0.97 eps rolls over (${narrow.rollMetacentricHeight})`);
  assert.ok(wide.rollMetacentricHeight > 0 && wide.stable, `W/H 1.03 eps floats upright (${wide.rollMetacentricHeight})`);
  assert.equal(narrow.rollPeriod, Infinity);
});

test('a lopsided berg settles with its centre of buoyancy under its centre of mass, heeled and trimmed', () => {
  const b = iceBuoyancy(lump(30, 0.4));
  close(b.buoyancyCentre[0], b.centroid[0], 1e-6, 'B under G across X');
  close(b.buoyancyCentre[2], b.centroid[2], 1e-6, 'B under G across Z');
  assert.ok(Math.abs(b.heel) + Math.abs(b.trim) > 1e-3, `a lumpy berg rests tilted (${b.heel}, ${b.trim})`);
  close(Math.hypot(...b.up), 1, 1e-12, 'up is a unit vector');
  // A box rests level.
  const level = iceBuoyancy(box(60, 50, 80));
  assert.ok(Math.abs(level.heel) < 1e-9 && Math.abs(level.trim) < 1e-9);
  // The Iceberg draws it at rest: its quaternion is its matrix's rotation, and the material's notch plane is world level.
  const material = new IceMaterial(),
    berg = new Iceberg({ mesh: lump(30, 0.4), material, heave: { period: 0 }, roll: { period: 0 }, pitch: { period: 0 } });
  berg.update({ sample: () => ({ height: 0 }) }, 0);
  const m = berg.matrix(new Array(16)),
    [x, y, z, w] = berg.quaternion();
  close(m[0], 1 - 2 * (y * y + z * z), 1e-9, 'quaternion x column');
  close(m[5], 1 - 2 * (x * x + z * z), 1e-9, 'quaternion y column');
  close(m[1], 2 * (x * y + z * w), 1e-9, 'quaternion xy');
  // Mesh up at rest goes to world up.
  const u = b.up,
    wu = [0, 1, 2].map((r) => m[r] * u[0] + m[4 + r] * u[1] + m[8 + r] * u[2]);
  close(wu[1], 1, 1e-9, 'rest up is world up');
  const notchUp = material.uniforms.iceNotchUp;
  for (let k = 0; k < 3; k++) close(notchUp[k], u[k], 1e-6, 'notch plane normal');
  // A point of the mesh on the notch plane is on the water (height 0) in the world.
  const g = b.centroid,
    d = material.uniforms.iceNotch[0],
    onPlane = [g[0] + u[0] * (d - (u[0] * g[0] + u[1] * g[1] + u[2] * g[2])), 0, 0];
  onPlane[1] = g[1] + u[1] * (d - (u[0] * g[0] + u[1] * g[1] + u[2] * g[2]));
  onPlane[2] = g[2] + u[2] * (d - (u[0] * g[0] + u[1] * g[1] + u[2] * g[2]));
  const wy = m[1] * onPlane[0] + m[5] * onPlane[1] + m[9] * onPlane[2] + m[13];
  close(wy, 0, 1e-4, 'the notch plane sits on the water');
});

test('a bad mesh is refused with the fix', () => {
  const m = box(10, 10, 10);
  const flipped = new Float64Array(m.positions);
  for (let k = 0; k < flipped.length; k += 9) for (let j = 0; j < 3; j++) [flipped[k + 3 + j], flipped[k + 6 + j]] = [flipped[k + 6 + j], flipped[k + 3 + j]];
  assert.throws(() => iceBuoyancy({ positions: flipped }), /wound outward/);
  assert.throws(() => iceBuoyancy({ positions: [0, 0, 0] }), TypeError);
  assert.throws(() => iceBuoyancy(m, { iceDensity: 1000 }), RangeError);
  assert.throws(() => iceBuoyancy({ positions: m.positions, indices: [0, 1, 99, 0, 1, 2, 0, 1, 2, 0, 1, 2] }), /out of range/);
});

test('an Iceberg rides the water at its waterline and keeps its material wet to the water', () => {
  const material = new IceMaterial();
  const instant = { period: 0 };
  const berg = new Iceberg({ mesh: box(40, 50, 60, -20), material, position: [5, 0, 7], heave: instant, roll: instant, pitch: instant });
  const flat = { sample: () => ({ height: 2 }) };
  berg.update(flat, 0.1);
  const b = berg.buoyancy,
    m = berg.matrix();
  close(m[13], 2 - b.waterline, 1e-5, 'mesh origin height');
  close(m[12], 5, 1e-5, 'x');
  close(m[14], 7, 1e-5, 'z');
  close(b.waterplaneCentre[0], 0, 1e-9, 'waterplane centre x');
  close(b.waterplaneCentre[1], 0, 1e-9, 'waterplane centre z');
  close(material.uniforms.iceWater[2], 2, 1e-6, 'material water height');
  close(material.uniforms.iceNotch[0], b.waterline, 1e-5, 'notch in mesh space');
  close(material.uniforms.iceNotch[3], 2, 1e-6, 'notch in the world');
  // A water sloping up along +X: the berg (heading 90, forward +X) pitches bow up and the plane's slope reaches the material.
  const berg2 = new Iceberg({ mesh: box(40, 50, 60), heading: 90, heave: instant, roll: instant, pitch: instant, material: new IceMaterial({ notch: false }) });
  berg2.update({ sample: (x) => ({ height: 0.02 * x }) }, 0.1);
  close(berg2.floater.pitch, Math.atan(0.02), 1e-9, 'pitch on the slope');
  close(berg2.water.slopeX, 0.02, 1e-9, 'slope x');
  close(berg2.water.slopeZ, 0, 1e-9, 'slope z');
  assert.equal(berg2.material.cutsNotch, false);
  // The berg's own periods drive the Floater by default.
  const own = new Iceberg({ mesh: box(40, 50, 60) });
  assert.ok(Math.abs(own.buoyancy.heavePeriod - 2 * Math.PI * Math.sqrt(((900 / 1027) * 50) / G)) < 1e-4);
});

test('IceMaterial looks map to its uniforms and refuse unknown names', () => {
  const m = new IceMaterial({ look: { blueIce: 0.5, scatterDepth: 10 } });
  close(m.uniforms.iceBands[0], 0.5, 1e-7, 'blue share');
  const t = iceTransmittance(10);
  for (let k = 0; k < 3; k++) close(m.subsurfaceColor[k], t[k], 1e-6, 'subsurface tint');
  m.setLook({ bubbles: 0.2 });
  close(m.uniforms.iceWhite[0], iceAlbedo(0.2, 0.5)[0], 1e-6, 'white albedo');
  assert.throws(() => m.setLook({ sparkle: 1 }), TypeError);
  assert.throws(() => m.setLook({ blueIce: 2 }), RangeError);
});

test('wave erosion is the Bigg et al. 1997 rate', () => {
  const s = (2 / 3) * Math.sqrt(10) + 1;
  close(waveErosion(10, 0), (s * 2 * 2) / 12, 1e-12, 'open water at 0 C');
  close(waveErosion(10, -2), 0, 1e-15, 'at the freezing point');
  close(waveErosion(10, 0, 1), (s * (1 + Math.cos(Math.PI)) * 2) / 12, 1e-12, 'in full ice cover');
});

test('sea ice never overlaps, covers its share and keeps to the WMO sizes', () => {
  for (const kind of ['pancake', 'brash', 'floe']) {
    const size = kind === 'floe' ? [800, 800] : [40, 40];
    const field = new SeaIce({ kind, size, seed: 7 });
    const p = field.pieces;
    assert.ok(p.length > 20, `${kind}: ${p.length} pieces`);
    let covered = 0;
    for (let i = 0; i < p.length; i++) {
      covered += Math.PI * (p[i].diameter / 2) ** 2 * p[i].aspect;
      for (let j = i + 1; j < p.length; j++) assert.ok(Math.hypot(p[i].x - p[j].x, p[i].z - p[j].z) >= (p[i].diameter + p[j].diameter) / 2 - 1e-9, `${kind} pieces ${i} and ${j} overlap`);
    }
    const share = covered / (size[0] * size[1]),
      want = { pancake: 0.6, brash: 0.4, floe: 0.5 }[kind];
    assert.ok(share > want * 0.5 && share < want + 0.05, `${kind} covers ${share}`);
    const [d0, d1] = { pancake: [0.3, 3], brash: [0.2, 2], floe: [20, 100] }[kind];
    assert.ok(p.every((q) => q.diameter >= d0 && q.diameter <= d1));
  }
});

test('sea ice sits at its freeboard and drifts at 2% of the wind turned 25 degrees right', () => {
  const field = new SeaIce({ size: [30, 30], wind: { speed: 10, direction: [1, 0] }, seaLevel: 1, seed: 3 });
  field.update({ sample: () => ({ height: 1 }) }, 0);
  const m = field.matrices,
    q = field.pieces[0];
  const top = m[13] + m[5] / 2;
  close(top - 1, q.thickness * (1 - 910 / 1027), 1e-5, 'freeboard');
  close(m[5], q.thickness, 1e-6, 'thickness scale');
  const v = field.drift(),
    a = (25 * Math.PI) / 180;
  close(Math.hypot(v[0], v[1]), 0.2, 1e-12, 'drift speed');
  close(v[0], 0.2 * Math.cos(a), 1e-12, 'drift x');
  // Right of a wind toward +X, seen from above with Y up, is toward +Z.
  close(v[1], 0.2 * Math.sin(a), 1e-12, 'drift z');
  const south = new SeaIce({ size: [30, 30], wind: { speed: 10, direction: [1, 0] }, turning: -25 });
  assert.ok(south.drift()[1] < 0);
});

test('a seek draws the field that stepping draws', () => {
  const make = () => new SeaIce({ size: [50, 50], wind: { speed: 12, direction: [0.6, 0.8] }, current: [0.05, 0], seed: 9 });
  const sea = { sample: (x, z) => ({ height: 0.5 * Math.sin(0.3 * x + 0.1 * z) }) };
  const stepped = make(),
    seeked = make();
  for (let i = 0; i < 200; i++) stepped.update(sea, 0.5);
  seeked.setTime(100).update(sea, 0);
  for (let k = 0; k < stepped.matrices.length; k++) assert.ok(Math.abs(stepped.matrices[k] - seeked.matrices[k]) < 1e-4, `matrix value ${k}`);
  // Drifted out of the field and wrapped back in.
  for (let i = 0; i < stepped.pieces.length; i++) {
    const [x, z] = stepped.at(i);
    assert.ok(Math.abs(x) <= 25 && Math.abs(z) <= 25);
  }
});

test("a film seek's advanceTime moves the sea ice clock and the berg as frames do", () => {
  const make = () => new SeaIce({ size: [50, 50], wind: { speed: 12, direction: [0.6, 0.8] }, seed: 9 });
  const sea = { sample: (x, z) => ({ height: 0.5 * Math.sin(0.3 * x + 0.1 * z), velocity: [0.4, 0, 0.2] }) };
  // Before any water: the clock and the drift move, as setTime does.
  const dry = make(),
    seeked = make();
  for (let i = 0; i < 30; i++) dry.advanceTime(1 / 30);
  close(dry.time, 1, 1e-9, 'dry clock');
  dry.update(sea, 0);
  seeked.setTime(1).update(sea, 0);
  for (let k = 0; k < dry.matrices.length; k++) close(dry.matrices[k], seeked.matrices[k], 1e-6, `dry matrix ${k}`);
  // After water: advanceTime sets the pieces on that water again, as stepping update does.
  const stepped = make(),
    replayed = make();
  stepped.update(sea, 0);
  replayed.update(sea, 0);
  for (let i = 0; i < 60; i++) stepped.update(sea, 1 / 30);
  for (let i = 0; i < 60; i++) replayed.advanceTime(1 / 30);
  assert.deepEqual(replayed.matrices, stepped.matrices);
  // The berg drifts and rides on the water its last update gave it.
  const options = () => ({ mesh: box(40, 50, 60, -20), drift: 1 });
  const a = new Iceberg(options()),
    b = new Iceberg(options()),
    idle = new Iceberg(options());
  idle.advanceTime(1);
  assert.deepEqual(idle.floater.position, [0, 0, 0], 'no water given yet: advanceTime does nothing');
  a.update(sea, 0);
  b.update(sea, 0);
  for (let i = 0; i < 60; i++) a.update(sea, 1 / 30);
  for (let i = 0; i < 60; i++) b.advanceTime(1 / 30);
  close(b.floater.position[0], 0.8, 1e-9, 'berg drift x');
  assert.deepEqual(b.matrix(), a.matrix());
});

test('the swell dies into the pancake ice as Doble et al. 2015 measured', () => {
  const field = new SeaIce({ size: [4000, 20], concentration: 0.3, diameter: [1, 1.2], thickness: [0.3, 0.3], wavePeriod: 9, waveDirection: [1, 0], seed: 2 });
  const alpha = 0.2 * 9 ** -2.13 * 0.7 * 0.3;
  close(field.swellShare(1000, 0.3), Math.exp((-alpha / 2) * 1000), 1e-12, 'amplitude share 1 km in');
  // A uniform 1 m lift: pieces at the upwave edge rise 1 m, pieces deep in rise less, by that share.
  field.update({ sample: () => ({ height: 1 }) }, 0);
  const m = field.matrices;
  let checked = 0;
  field.pieces.forEach((p, i) => {
    const into = m[i * 16 + 12] + 2000,
      base = (p.thickness * (1 - 910 / 1027)) - p.thickness / 2;
    close(m[i * 16 + 13] - base, field.swellShare(into, p.thickness), 1e-5, `piece ${i} heave`);
    checked++;
  });
  assert.ok(checked > 100);
  field.setDrift({ attenuation: 0 });
  assert.equal(field.swellShare(3000, 0.3), 1);
});

test('the foam at a berg is whiter on the weather side, streaks past it, and follows the wind', () => {
  const surface = { name: 'fake', onDispose: () => () => {}, wind: { speed: 10, direction: [1, 0] } };
  const berg = new Iceberg({ mesh: box(40, 30, 40) });
  const foam = new BergFoam({ surface, bergs: [berg] });
  close(foam.sea().waveHeight, (0.21 * 100) / G, 1e-12, 'waveHeight null follows the wind');
  const weather = foam.sample(-21, 0),
    lee = foam.sample(21, 0),
    side = foam.sample(0, 21);
  assert.ok(weather > lee && weather > side, `weather ${weather}, lee ${lee}, side ${side}`);
  assert.ok(weather > 0.8);
  assert.equal(foam.sample(-300, 0), 0);
  assert.ok(foam.sample(50, 0) > 0.1, 'streaks past the lee');
  assert.equal(foam.sample(50, 60), 0);
  foam.setLook({ waveHeight: 0, breakFoam: 0, foamTrail: 0 });
  assert.ok(foam.sample(-21, 0) < 0.5 && foam.sample(50, 0) === 0);
  assert.throws(() => foam.setLook({ glow: 1 }), TypeError);
});

test('spray bursts when the water surges up the weather face', () => {
  const particles = { options: {}, bursts: [], burst(n) { this.bursts.push(n); } };
  const berg = new Iceberg({ mesh: box(20, 20, 20) });
  const spray = new BergSpray({ berg, particles, waveDirection: [1, 0] });
  const [fx, fz] = spray.face();
  close(fx, -10, 1e-6, 'face x');
  close(fz, 0, 1e-6, 'face z');
  let h = 0;
  const sea = { sample: () => ({ height: h }) };
  spray.update(sea, 0.1);
  h = 0.05;
  assert.equal(spray.update(sea, 0.1).burst, 0);
  h = 0.35; // 3 m/s, past 0.8
  const s = spray.update(sea, 0.1);
  assert.equal(s.burst, Math.round(300 * (3 * 3) / (0.8 * 0.8)));
  assert.equal(particles.bursts.length, 1);
  assert.ok(s.rate > 0 && particles.options.position[1] === 0.35);
  h = 0.7; // still surging: no second burst until it falls back
  assert.equal(spray.update(sea, 0.1).burst, 0);
});

test('the ice slider rows reach every target, and null follows the wind', () => {
  assert.ok(ICE_SETTINGS.length >= 20 && ICE_SETTINGS.every((r) => r.live));
  const material = new IceMaterial(),
    seaIce = new SeaIce({ size: [10, 10] }),
    surface = { name: 'fake', onDispose: () => () => {}, wind: { speed: 15, direction: [0, 1] } },
    foam = new BergFoam({ surface }),
    spray = new BergSpray({ berg: new Iceberg({ mesh: box(10, 10, 10) }), particles: { options: {}, burst() {} } });
  applyIceSettings({ material, seaIce, foam, spray, water: surface }, ICE_LOOKS.gale);
  assert.equal(material.look.wetHeight, 6);
  assert.equal(foam.look.waveHeight, 7);
  assert.equal(spray.sprayRate, 8000);
  assert.equal(seaIce.wind.speed, 20);
  applyIceSettings({ seaIce, foam, water: surface }, { driftWind: null, waveHeight: null });
  assert.equal(seaIce.wind.speed, 15);
  assert.deepEqual(seaIce.wind.direction, [0, 1]);
  assert.equal(foam.look.waveHeight, null);
  const d = iceSettingDefaults();
  applyIceSettings({ material }, d);
  assert.equal(material.look.wetHeight, 1.5);
  assert.throws(() => applyIceSettings({ material }, { glare: 1 }), TypeError);
  assert.throws(() => applyIceSettings({ material }, { blueIce: 3 }), RangeError);
});
