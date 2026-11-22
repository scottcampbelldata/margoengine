import test from 'node:test';
import assert from 'node:assert/strict';
import { openingLight } from '../dist/area.js';
import { hurricaneLantern } from '../dist/flicker.js';

// KB-CABIN-WINDOWGLOW1: a lit room's window lit nothing outside but along the lamp's own rays. openingLight is the
// room's inter-reflected light leaving through the opening: an integrating sphere with ports (Goebel, Applied Optics
// 6(1), 1967). Checked here against the sphere's energy balance summed bounce by bounce, not against its closed form:
// of the lamps' flux Phi, the share (1 - f) strikes the walls (f, the ports' share of the area, leaves at once along the
// lamps' own rays); each strike reflects rho of it, spread evenly over the area, so f of it escapes through the ports
// and (1 - f) strikes the walls again. The ports carry the escaping flux as a Lambertian emitter, pi x radiance x area.
const room = (rho, area) => [{ area, reflectance: rho }];
test('the window radiance carries out the light the room reflects, bounce by bounce (Goebel 1967)', () => {
  for (const [rho, area, intensity, w, h, other] of [
    [0.2, 100, 6.5, 1.2, 1.1, 0],
    [0.7, 40, 20, 0.8, 2, 1.5],
    [0.05, 200, 1, 2, 2, 0],
  ]) {
    const light = openingLight({
        position: [0, 1, 0],
        direction: [0, 0, 1],
        width: w,
        height: h,
        room: room(rho, area),
        lights: [{ intensity }],
        openings: other,
      }),
      total = area + w * h + other,
      f = (w * h + other) / total;
    let strike = 4 * Math.PI * intensity * (1 - f),
      escaped = 0;
    for (let n = 0; n < 2000; n++) {
      escaped += strike * rho * f;
      strike *= rho * (1 - f);
    }
    const throughThis = (escaped * (w * h)) / (w * h + other);
    for (const c of light.color)
      assert.ok(Math.abs(Math.PI * c * w * h - throughThis) < 1e-9 * throughThis, `${c} for rho ${rho}`);
    assert.deepEqual([light.width, light.height, light.intensity, light.castShadow], [w, h, 1, undefined]);
  }
});

test('the room is weighed by area and channel, and a flame counts at its flicker mean', () => {
  const lantern = hurricaneLantern(),
    base = { position: [0, 0, 0], direction: [1, 0, 0], width: 1, height: 1 },
    mixed = openingLight({
      ...base,
      room: [
        { area: 30, reflectance: [0.6, 0.3, 0.1] },
        { area: 10, reflectance: 0.2 },
      ],
      lights: [{ color: [1, 1, 1], intensity: 2 }],
    }),
    even = openingLight({
      ...base,
      room: [{ area: 40, reflectance: [0.5, 0.275, 0.125] }],
      lights: [{ color: [1, 1, 1], intensity: 2 }],
    });
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(mixed.color[k] - even.color[k]) < 1e-12);
  const flame = openingLight({ ...base, room: room(0.3, 50), lights: [lantern] }),
    steady = openingLight({
      ...base,
      room: room(0.3, 50),
      lights: [{ color: lantern.color, intensity: lantern.intensity * 0.9 }],
    });
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(flame.color[k] - steady.color[k]) < 1e-12, 'candle mean 0.9');
  assert.equal(flame.color[2], 0, 'a 1,900 K flame has no blue to reflect');
});

test('openingLight rejects what it cannot use', () => {
  const ok = { position: [0, 0, 0], direction: [0, 0, 1], width: 1, height: 1, room: room(0.3, 10), lights: [] };
  for (const bad of [
    { width: 0 },
    { height: -1 },
    { position: [0, 0] },
    { direction: [0, Number.NaN, 1] },
    { room: [] },
    { room: room(1, 10) },
    { room: room(-0.1, 10) },
    { lights: [{ intensity: -1 }] },
    { openings: -1 },
  ])
    assert.throws(() => openingLight({ ...ok, ...bad }), RangeError, JSON.stringify(bad));
  assert.deepEqual(openingLight(ok).color, [0, 0, 0], 'no light, no glow');
});

// KB-CABIN-EDGE-SOFT2: frosted glazing. A frosted pane stops each lamp's beam and re-emits what falls on its room side
// diffusely, L = tau_d E / pi (a Lambertian transmitter). E is checked here by summing each lamp's irradiance
// I cos(theta) / r^2 over a fine grid on the pane, not by the solid angle the package uses, plus pi times the room's
// own radiance (clear glazing's, unchanged). The frost lies on the glass's room face, 4 mm (the default thickness)
// behind the opening's outer face.
import { FROSTED_GLAZING, glazingSurface } from '../dist/area.js';
const paneIrradiance = (light, centre, w, h, steps = 400) => {
  let sum = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const x = centre[0] + ((i + 0.5) / steps - 0.5) * w,
        y = centre[1] + ((j + 0.5) / steps - 0.5) * h,
        d = [x - light.position[0], y - light.position[1], centre[2] - light.position[2]],
        r = Math.hypot(...d);
      sum += (light.intensity * (d[2] / r)) / r ** 2;
    }
  return sum / steps ** 2;
};
const frostAt = (p, thickness = 0.004) => [p[0], p[1], p[2] - thickness];
test("a frosted pane sends out tau_d E / pi: the lamps' direct light on it and the room's, diffused", () => {
  const lamps = [
      { position: [1.2, 1.875, 1.95], intensity: 6.5, color: [1, 0.5, 0.1] },
      { position: [0.95, 0.5, -2.15], intensity: 2, color: [1, 0.6, 0.2] },
    ],
    opening = {
      position: [1.2, 1.5, 2.5],
      direction: [0, 0, 1],
      width: 1.2,
      height: 1.1,
      room: [
        { area: 50, reflectance: [0.26, 0.2, 0.15] },
        { area: 30, reflectance: 0.4 },
      ],
      lights: lamps,
    },
    clear = openingLight(opening),
    frosted = openingLight({ ...opening, glazing: 'frosted' });
  assert.deepEqual(openingLight({ ...opening, glazing: 'clear' }).color, clear.color, 'clear glazing is the default');
  const E = lamps.map((l) => paneIrradiance(l, frostAt(opening.position), opening.width, opening.height));
  for (let k = 0; k < 3; k++) {
    const direct = E.reduce((a, e, i) => a + e * lamps[i].color[k], 0),
      expected = (FROSTED_GLAZING.transmittance * (direct + Math.PI * clear.color[k])) / Math.PI;
    assert.ok(
      Math.abs(frosted.color[k] - expected) < 2e-5 * expected,
      `channel ${k}: ${frosted.color[k]} against ${expected}`,
    );
  }
  // The direct light dominates: the lantern 0.55 m behind the pane puts about 10 lux on it, ten times the room's pi L.
  assert.ok(frosted.color[0] > 5 * clear.color[0], `${frosted.color[0]} against the room's ${clear.color[0]}`);
  // Transmittance is an option; a lamp outside the room (or on the pane's plane) lights the pane's room side not at all.
  const half = openingLight({ ...opening, glazing: 'frosted', transmittance: FROSTED_GLAZING.transmittance / 2 });
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(half.color[k] - frosted.color[k] / 2) < 1e-12 * frosted.color[k]);
  // (It still adds to the room's light, as every listed light does: compare the direct parts.)
  const more = { ...opening, lights: [...lamps, { position: [1.2, 1.5, 4], intensity: 100 }] },
    moreFrosted = openingLight({ ...more, glazing: 'frosted' }).color,
    moreClear = openingLight(more).color,
    tau = FROSTED_GLAZING.transmittance;
  for (let k = 0; k < 3; k++)
    assert.ok(
      Math.abs(moreFrosted[k] - tau * moreClear[k] - (frosted.color[k] - tau * clear.color[k])) <
        1e-12 * frosted.color[0],
    );
});

// KB-CABIN-FROST2: frost grown part way in carries the lamp's light where the frost is, not the pane's mean; until
// 2026-11-16 the opening took the area-weighted mean of the frosted-over and clear radiances.
test('frost grown part way in from the edges sends out the light that falls on the frosted border', () => {
  const lamp = { position: [0, 0, -0.5], intensity: 5 },
    base = { position: [0, 0, 0], direction: [0, 0, 1], width: 1.2, height: 0.8, room: room(0.3, 40), lights: [lamp] },
    L = openingLight(base).color[0],
    tau = FROSTED_GLAZING.transmittance,
    A = 1.2 * 0.8;
  for (const frost of [0, 0.25, 0.5, 1]) {
    const t = (frost * 0.8) / 2,
      mw = 1.2 - 2 * t,
      mh = 0.8 - 2 * t,
      middle = mw > 0 && mh > 0 ? mw * mh : 0,
      ring =
        A * paneIrradiance(lamp, frostAt(base.position), 1.2, 0.8, 600) -
        (middle ? middle * paneIrradiance(lamp, frostAt(base.position), mw, mh, 600) : 0),
      expected = (tau * (ring / Math.PI + L * (A - middle)) + L * middle) / A,
      got = openingLight({ ...base, glazing: 'frosted', frost }).color[0];
    assert.ok(Math.abs(got - expected) < 2e-5 * expected, `frost ${frost}: ${got} against ${expected}`);
  }
});

// KB-CABIN-FROST2: the frosted window read as a flat, even card with no bars. Checked by brute force here: a frost point
// (x, y) on the glass's room face gets I cos(theta) / r^2 from each lamp unless the segment to the lamp passes through a
// glazing bar (a box, barWidth x full span x barDepth, centred on the glass) or leaves the opening's reveal (the
// opening's rectangle extruded `reveal` deep into the room behind the frost); the bars' own area sends nothing out.
const scene = {
  position: [1.2, 1.5, 2.452],
  direction: [0, 0, 1],
  width: 1.2,
  height: 1.1,
  glazing: 'frosted',
  lites: [2, 2],
  barWidth: 0.045,
  barDepth: 0.05,
  reveal: 0.118,
  room: [
    { area: 70, reflectance: [0.26, 0.21, 0.15] },
    { area: 40, reflectance: 0.3 },
  ],
  lights: [
    { position: [1.2, 1.875, 1.95], ...hurricaneLantern() },
    { position: [0.4, 0.6, -1.9], intensity: 30, color: [1, 0.45, 0.12] },
  ],
};
function bruteRadiance(o, x, y) {
  const w = o.width / 2,
    h = o.height / 2,
    t = o.thickness ?? 0.004,
    zc = o.position[2] - t / 2,
    bw = o.barWidth ?? 0.03,
    bd = o.barDepth ?? 0.035,
    [nx, ny] = o.lites ?? [1, 1],
    liteW = (o.width - (nx - 1) * bw) / nx,
    liteH = (o.height - (ny - 1) * bw) / ny,
    boxes = [];
  for (let i = 1; i < nx; i++) {
    const a = o.position[0] - w + i * liteW + (i - 1) * bw;
    boxes.push([
      [a, o.position[1] - h, zc - bd / 2],
      [a + bw, o.position[1] + h, zc + bd / 2],
    ]);
  }
  for (let j = 1; j < ny; j++) {
    const a = o.position[1] - h + j * liteH + (j - 1) * bw;
    boxes.push([
      [o.position[0] - w, a, zc - bd / 2],
      [o.position[0] + w, a + bw, zc + bd / 2],
    ]);
  }
  const p = [o.position[0] + x, o.position[1] + y, o.position[2] - t];
  if (boxes.some(([lo, hi]) => p[0] > lo[0] && p[0] < hi[0] && p[1] > lo[1] && p[1] < hi[1])) return null;
  const inside = (q) => Math.abs(q[0] - o.position[0]) <= w && Math.abs(q[1] - o.position[1]) <= h,
    L = [0, 0, 0];
  for (const light of o.lights) {
    const d = light.position.map((c, k) => c - p[k]);
    if (!(d[2] < 0)) continue;
    const blocked = boxes.some(([lo, hi]) => {
      let t0 = 0,
        t1 = 1;
      for (let k = 0; k < 3; k++) {
        let a = (lo[k] - p[k]) / d[k],
          b = (hi[k] - p[k]) / d[k];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
      return t0 < t1;
    });
    const r = o.reveal ?? 0,
      s = Math.min(1, r / -d[2]);
    if (blocked || (r > 0 && !inside(p.map((c, k) => c + s * d[k])))) continue;
    const r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2,
      e = -d[2] / r2 ** 1.5,
      mean = light.flicker?.curve === 'candle' ? 0.9 : light.flicker?.curve === 'fire' ? 0.75 : 1;
    for (let k = 0; k < 3; k++) L[k] += (light.intensity ?? 1) * mean * (light.color ?? [1, 1, 1])[k] * e;
  }
  const room = openingLight({ ...o, glazing: 'clear', lites: [1, 1] }).color;
  return L.map((c, k) => FROSTED_GLAZING.transmittance * (c / Math.PI + room[k]));
}
const decode = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
test('the frosted pane is brightest nearest the lamp: its peak radiance is tau_d E_max / pi', () => {
  const look = glazingSurface(scene);
  let best = 0;
  for (let i = 0; i <= 600; i++)
    for (let j = 0; j <= 550; j++) {
      const L = bruteRadiance(scene, -0.6 + i * 0.002, -0.55 + j * 0.002);
      if (L) best = Math.max(best, ...L);
    }
  // The texel grid (4.7 mm) samples the smooth peak; it may sit under the true maximum by the curvature over half a
  // texel, under 0.1% here, never over it.
  const peak = look.outside.emissiveIntensity;
  assert.ok(peak <= best * (1 + 1e-9) && peak >= best * 0.999, `peak ${peak} against tau_d E_max / pi ${best}`);
  assert.deepEqual(look.outside.emissive, [1, 1, 1]);
  // Far brighter than the opening's mean: the glow is uneven, the lantern 0.5 m behind the upper lites.
  const mean = openingLight(scene).color[0];
  assert.ok(peak > 2 * mean, `peak ${peak} against the mean ${mean}`);
});
test("the pane falls off from the centre to its corner as the lamp's cosine over the squared distance says", () => {
  const look = glazingSurface({ ...scene, lites: [1, 1] }),
    { data, width, height } = look.emissiveMap,
    at = (i, j) => [0, 1, 2].map((k) => decode(data[(j * width + i) * 4 + k]) * look.outside.emissiveIntensity),
    centre = (n) => (n % 2 ? [(n - 1) / 2] : [n / 2 - 1, n / 2]),
    texel = (i, j) => [-0.6 + ((i + 0.5) * 1.2) / width, 0.55 - ((j + 0.5) * 1.1) / height],
    one = { ...scene, lites: [1, 1] },
    mid = (fn) => {
      const cells = centre(width).flatMap((i) => centre(height).map((j) => [i, j]));
      return cells.reduce((a, [i, j]) => a.map((v, k) => v + fn(i, j)[k] / cells.length), [0, 0, 0]);
    },
    measured = mid(at)[0] / at(0, height - 1)[0],
    predicted = mid((i, j) => bruteRadiance(one, ...texel(i, j)))[0] / bruteRadiance(one, ...texel(0, height - 1))[0];
  // Each texel holds its radiance to half an 8-bit sRGB code, a share 2.4 x (0.5 / 255) / (code / 255 + 0.055) of it
  // (the sRGB curve's slope); the ratio is good to the sum of the two texels' shares.
  const share = (i, j) => (2.4 * (0.5 / 255)) / (data[(j * width + i) * 4] / 255 + 0.055),
    tolerance =
      Math.max(...centre(width).flatMap((i) => centre(height).map((j) => share(i, j)))) + share(0, height - 1);
  assert.ok(
    Math.abs(measured / predicted - 1) < tolerance,
    `centre over bottom-left corner ${measured} against ${predicted} (${tolerance})`,
  );
  assert.ok(predicted > 2, `the centre is ${predicted} times the corner`);
});
test("the bars shade the frost behind them and send no light out, and the opening carries the pane's flux", () => {
  const light = openingLight(scene),
    steps = [1200, 1100],
    sum = [0, 0, 0];
  for (let i = 0; i < steps[0]; i++)
    for (let j = 0; j < steps[1]; j++) {
      const L = bruteRadiance(scene, ((i + 0.5) / steps[0] - 0.5) * 1.2, ((j + 0.5) / steps[1] - 0.5) * 1.1);
      if (L) for (let k = 0; k < 3; k++) sum[k] += L[k] / (steps[0] * steps[1]);
    }
  // The area light's flux is pi x its radiance x the opening's area: the same as the pane's radiance integrated over its
  // glass. The grid's 1 mm cells cut the bars' and shadows' edges; at most a cell's width of each edge is wrong.
  for (let k = 0; k < 3; k++)
    assert.ok(Math.abs(light.color[k] - sum[k]) < 2e-3 * sum[k], `channel ${k}: ${light.color[k]} against ${sum[k]}`);
  // The map: the frost just below the cross bar is in the bar's shadow (the lantern is above it, so the bar's room-side
  // 23 mm throws a shadow 12 mm deep below it); a little lower it is lit.
  const look = glazingSurface({ ...scene, mapSize: 1200 }),
    { data, width } = look.emissiveMap,
    read = (x, y) =>
      decode(data[(Math.floor((0.55 - y) * 1000) * width + Math.floor((x + 0.6) * 1000)) * 4]) *
      look.outside.emissiveIntensity,
    shaded = read(0.3, -0.0225 - 0.006),
    lit = read(0.3, -0.0225 - 0.03),
    room = FROSTED_GLAZING.transmittance * openingLight({ ...scene, glazing: 'clear', lites: [1, 1] }).color[0];
  assert.ok(Math.abs(shaded - bruteRadiance(scene, 0.3, -0.0285)[0]) < 0.01 * lit, `shaded ${shaded}`);
  assert.ok(
    shaded < 1.6 * room + 0.05 * lit && lit > 3 * shaded,
    `the bar's shadow ${shaded} against the frost below it ${lit}`,
  );
  // Without bars or reveal the frost is lit everywhere the lamp sees it.
  const bare = { ...scene, lites: [1, 1], reveal: 0 };
  assert.ok(openingLight(bare).color[0] > light.color[0]);
});

test("glazingSurface gives the frosted pane its radiance outside and the frost's reflectance on both faces", () => {
  const opening = {
      position: [0, 1.5, 0],
      direction: [0, 0, 1],
      width: 1.2,
      height: 1.1,
      glazing: 'frosted',
      room: room(0.3, 60),
      lights: [{ position: [0, 1.8, -0.6], ...hurricaneLantern() }],
    },
    look = glazingSurface(opening),
    light = openingLight(opening),
    { data, width, height } = look.emissiveMap;
  // The map's mean over the pane is the opening's radiance (to its texels and its 8-bit codes).
  for (let k = 0; k < 3; k++) {
    let sum = 0;
    for (let p = 0; p < width * height; p++) sum += decode(data[p * 4 + k]);
    const mean = (sum / (width * height)) * look.outside.emissiveIntensity;
    assert.ok(
      Math.abs(mean - light.color[k]) < 0.01 * light.color[0] + 1e-9,
      `channel ${k}: ${mean} against ${light.color[k]}`,
    );
  }
  assert.deepEqual([width, height], [256, 235]);
  assert.equal(data.length, width * height * 4);
  assert.deepEqual(look.inside.color, look.outside.color);
  assert.ok(
    Math.abs(FROSTED_GLAZING.transmittance - 0.9 / 1.4125) < 1e-12 &&
      Math.abs(FROSTED_GLAZING.reflectance - (1 - 1 / 1.4125)) < 1e-12,
  );
  assert.throws(() => glazingSurface({ ...opening, glazing: 'clear' }), RangeError);
  for (const mapSize of [1, 2.5, 4096]) assert.throws(() => glazingSurface({ ...opening, mapSize }), RangeError);
  for (const bad of [
    { glazing: 'etched' },
    { glazing: 'frosted', frost: 1.5 },
    { glazing: 'frosted', transmittance: -0.1 },
    { glazing: 'frosted', lights: [{ intensity: 1 }] },
    { lites: [0, 1] },
    { lites: [2, 1.5] },
    { lites: [2, 2], barWidth: 0.6 },
    { barDepth: 0.002 },
    { thickness: 0 },
    { reveal: -1 },
  ])
    assert.throws(() => openingLight({ ...opening, ...bad }), RangeError, JSON.stringify(bad));
  // Bars in clear glass block their share of the room's light.
  const clear = { ...opening, glazing: 'clear' },
    barred = openingLight({ ...clear, lites: [2, 2], barWidth: 0.05 }).color[0];
  assert.ok(Math.abs(barred - (openingLight(clear).color[0] * (1.15 * 1.05)) / (1.2 * 1.1)) < 1e-12);
});

// KB-BOUNCE-REVEAL1: an opening set back in a thick wall hands its reveal and sill to the light, which AreaLights and
// LightBounce clip the rectangle to (packages/clustered/test/area.test.js, test/bounce.test.js).
test('openingLight passes the wall face it is set back from and its sill to the light', () => {
  const opening = {
      position: [0, 1.5, 0],
      direction: [0, 0, 1],
      width: 1.2,
      height: 1.1,
      room: room(0.3, 60),
      lights: [{ intensity: 6.5 }],
    },
    plain = openingLight(opening),
    set = openingLight({ ...opening, recess: 0.216, sill: 0.09 });
  assert.deepEqual([plain.recess, plain.sill], [undefined, undefined]);
  assert.deepEqual([set.recess, set.sill], [0.216, 0.09]);
  assert.deepEqual(set.color, plain.color, 'the reveal outside does not change what leaves the room');
  for (const bad of [{ recess: -1 }, { sill: Infinity }, { recess: 'deep' }])
    assert.throws(() => openingLight({ ...opening, ...bad }), RangeError, JSON.stringify(bad));
});
