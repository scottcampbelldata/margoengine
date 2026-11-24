// BlastCloud of @margoengine/weather/eruption: the instantaneous source of Morton, Taylor and Turner (1956) measured
// against its similarity laws, determinism over film time, and the puffs it draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlastCloud, airStability, thermalTop } from '../dist/eruption.js';

test('in still uniform air the thermal spreads as db/dz = alpha and rises as z^2 = A^2 t (Scorer 1957)', () => {
  const alpha = 0.25,
    k = 0.5;
  const c = new BlastCloud({
    sources: [{ tnt: 1e6, radius: 5 }],
    stability: 0,
    entrainment: alpha,
    addedMass: k,
    horizon: 900,
  });
  const [a] = c.thermals(600),
    [b] = c.thermals(900);
  // Once the hot start has mixed out (rho near rho_a) the Boussinesq laws hold.
  assert.ok(b.density > 0.999, 'mixed to the air density');
  assert.ok(Math.abs((b.radius - a.radius) / (b.height - a.height) - alpha) < 0.005, 'db / dz = alpha');
  // d/dt((1 + k) b^3 w) = B with b = alpha z gives z = A t^(1/2), A^4 = 2 B / ((1 + k) alpha^3).
  // About the virtual origin z + z0 = b / alpha, which the hot start moves.
  const A2 = Math.sqrt((2 * b.sourceBuoyancy) / ((1 + k) * alpha ** 3)),
    slope = ((b.radius / alpha) ** 2 - (a.radius / alpha) ** 2) / 300;
  assert.ok(Math.abs(slope / A2 - 1) < 0.02, `z^2 grows at ${slope}, the law ${A2}`);
  assert.ok(Math.abs(b.buoyancy * b.radius ** 3 - b.sourceBuoyancy) / b.sourceBuoyancy < 1e-9, 'buoyancy is conserved');
});

test('in stable air the thermal stops at a height scaling as B^(1/4) N^(-1/2) (Morton et al. 1956)', () => {
  const N2 = 1e-4,
    B = 1e7,
    h = thermalTop(B, N2, 0.25, 0.5, 1);
  assert.ok(
    Math.abs(thermalTop(16 * B, N2, 0.25, 0.5, 1) / h - 2) < 0.03,
    'sixteen times the buoyancy rises twice as high',
  );
  assert.ok(Math.abs(thermalTop(B, N2 / 16, 0.25, 0.5, 1) / h - 2) < 0.03, 'a quarter of N rises twice as high');
  // ICAO troposphere: N^2 = g / T (dT/dz + g / c_p) = 9.80665 / 288.15 (-0.0065 + 0.009758).
  assert.ok(Math.abs(airStability(0) - (9.80665 / 288.15) * (-0.0065 + 9.80665 / 1005)) < 1e-6);
  assert.ok(airStability(15000) > 3 * airStability(0), 'the stratosphere is far more stable');
});

test('a hot start is light and rises faster than the Boussinesq thermal of the same buoyancy', () => {
  const hot = new BlastCloud({ sources: [{ tnt: 1e6 }], stability: 0 }),
    [start] = hot.thermals(0.05);
  // At 2,000 K the air is 288 / 2,000 of its density.
  assert.ok(Math.abs(start.density - 288.15 / 2000) < 0.02, `starts at ${start.density} of the air's density`);
  const cool = new BlastCloud({ sources: [{ tnt: 1e6, radius: 400 }], stability: 0 });
  assert.ok(hot.thermals(10)[0].height > cool.thermals(10)[0].height, 'the light cloud has risen further');
});

test('the rise matches measured clouds: Glasstone and Dolan 1977 table 2.12 and the Halifax cloud of 1917', () => {
  // 1 Mt air burst, 0.65 of the yield left as heat (0.35 leaves as thermal radiation, Glasstone and Dolan ch. 1).
  // Table 2.12: the cloud top at 2, 4 and 6 miles after 0.3, 0.7 and 1.1 minutes. The model is within 20 percent low.
  const mt = new BlastCloud({ sources: [{ tnt: 1e9 }], heatShare: 0.65 });
  for (const [minutes, miles] of [
    [0.3, 2],
    [0.7, 4],
    [1.1, 6],
  ]) {
    const [x] = mt.thermals(minutes * 60),
      top = (x.height + x.radius) / 1609.344;
    assert.ok(top > 0.8 * miles && top < 1.05 * miles, `top ${top.toFixed(2)} mi at ${minutes} min, measured ${miles}`);
  }
  // Halifax 1917, about 2.9 kt of TNT: the cloud's peak measured at 3,600 m (Ruffman and Howell 1994, p. 323).
  const halifax = new BlastCloud({ sources: [{ tnt: 2.9e6 }] });
  let peak = 0;
  for (let t = 0; t <= 900; t += 5) {
    const [x] = halifax.thermals(t);
    peak = Math.max(peak, x.height + x.radius);
  }
  assert.ok(Math.abs(peak / 3600 - 1) < 0.1, `Halifax peak ${peak.toFixed(0)} m, measured 3,600`);
});

test('past its neutral height the cap spreads into an umbrella at its own volume (Benjamin 1968)', () => {
  const c = new BlastCloud({ sources: [{ tnt: 1e6 }], stability: 1e-4, horizon: 1800 }),
    early = c.thermals(20)[0],
    late = c.thermals(1500)[0];
  assert.ok(Math.abs(early.spread ** 2 * early.thickness - early.radius ** 3) < 1e-6 * early.radius ** 3, 'one volume');
  assert.ok(Math.abs(early.spread / early.radius - 1 / Math.sqrt(0.75)) < 1e-9, 'no umbrella while it rises');
  assert.ok(late.spread > 1.4 * late.radius, `umbrella ${late.spread} over the radius ${late.radius}`);
  assert.ok(late.thickness < 0.6 * late.radius, 'flattened');
});

test('two caps whose spheres overlap merge into one cap of their summed volume (Kaye and Linden 2004)', () => {
  const pair = new BlastCloud({
      sources: [
        { tnt: 1e6, position: [0, 0, 0] },
        { tnt: 1e6, position: [60, 0, 0] },
      ],
    }),
    [a, b] = pair.thermals(30);
  assert.equal(a.merged, 1);
  assert.deepEqual(a.centre, b.centre, 'one cap');
  const apart = new BlastCloud({
    sources: [
      { tnt: 1e6, position: [0, 0, 0] },
      { tnt: 1e6, position: [5000, 0, 0] },
    ],
  });
  assert.equal(apart.thermals(30)[0].merged, 0, 'far apart they stay two');
  const single = new BlastCloud({ sources: [{ tnt: 1e6 }] }).thermals(30)[0];
  assert.ok(Math.abs(a.radius / single.radius - Math.cbrt(2)) < 0.02, 'radius of twice the volume');
  assert.equal(a.radius, b.radius, 'one size');
});

test('the cloud is a function of film time: seeks in any order, and update, give the same thermals', () => {
  const make = () =>
    new BlastCloud({
      sources: [
        { at: 0, tnt: 1.6e6, speed: 40 },
        { at: 2, tnt: 5e5, position: [60, 0, 10], speed: 30 },
      ],
      wind: 6,
    });
  const a = make(),
    b = make();
  a.seek(37.3);
  b.seek(200);
  b.seek(3);
  for (let i = 0; i < 343; i++) b.update(0.1);
  assert.deepEqual(a.thermals(), b.thermals(37.3));
  const [, second] = a.thermals(1.5);
  assert.equal(second.height, 0, 'the second source has not gone off');
  assert.equal(second.fire, 0);
  const [first] = a.thermals(37.3);
  assert.ok(first.centre[2] > 0, 'the wind drifts the cap toward +Z');
  assert.ok(first.height > 300 && first.radius > first.height * 0.2, 'a rising mushroom cap');
});

test('draw lays out one smoke cloud and one fire cloud for all sources, and takes the fire out when it burns down', () => {
  const made = (log) => ({
    add(o) {
      const c = { options: { ...o }, matrix: new Float32Array(16) };
      log.push(c);
      return c;
    },
    remove(c) {
      log.splice(log.indexOf(c), 1);
      return true;
    },
  });
  const smoke = [],
    fire = [];
  const c = new BlastCloud({
    sources: [
      { tnt: 1e6, speed: 40 },
      { at: 2, tnt: 1e6, position: [50, 0, 0], speed: 40 },
    ],
    fireDuration: 4,
  });
  const counts = { cap: 252, stem: 84, fire: 8 };
  c.seek(1);
  c.draw(made(smoke), made(fire), counts);
  assert.equal(smoke.length, 1, 'cap and stem in one cloud, so the cap shades the stem');
  const one = smoke[0].options.segments;
  assert.ok(one >= 252 && one <= 252 + 84, `one source so far: ${one}`);
  assert.equal(fire.length, 1);
  // The fire lights the smoke from inside: the lowest cap puffs glow, and the glow is gone once the fire is out.
  const glow = (cloud) => {
    let most = 0;
    for (let i = 0; i < cloud.options.segments; i++)
      most = Math.max(most, cloud.options.distribute(i, Math.random).emission[0]);
    return most;
  };
  assert.ok(glow(smoke[0]) > 1, 'bright fire glow in the first second');
  c.seek(3);
  c.draw(made(smoke), made(fire), counts);
  assert.ok(smoke[0].options.segments > one, 'both sources in one smoke cloud');
  const placed = [],
    sizes = new Set();
  for (let i = 0; i < smoke[0].options.segments; i++) {
    const p = smoke[0].options.distribute(i, Math.random);
    placed.push(p.point);
    sizes.add(Math.round(p.volume * 20));
    assert.equal(p.color.length, 3);
  }
  assert.ok(
    placed.flat().every((v) => v >= -1 - 1e-9 && v <= 1 + 1e-9),
    'puffs lie in the box',
  );
  assert.ok(sizes.size >= 8, 'lobes at many scales (Bouthors and Neyret 2004)');
  c.seek(10);
  c.draw(made(smoke), made(fire), counts);
  assert.equal(glow(smoke[0]), 0, 'no glow once the fire is out');
  assert.equal(fire.length, 0, 'the fire is out');
  assert.ok(smoke[0].matrix[13] > 0, 'the cap is above the ground');
  c.clear();
});

test('validation', () => {
  assert.throws(() => new BlastCloud({ entrainment: 0.9 }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [] }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [{ tnt: 0 }] }), RangeError);
  assert.throws(() => new BlastCloud({ sources: [{ speed: -1 }] }), RangeError);
  assert.throws(() => new BlastCloud({ color: [2, 0, 0] }), RangeError);
  assert.throws(() => new BlastCloud({ seed: 1.5 }), RangeError);
  assert.doesNotThrow(() => new BlastCloud({ stability: null }));
  const c = new BlastCloud();
  assert.throws(() => c.seek(-1), RangeError);
  assert.throws(() => c.draw({ add() {}, remove() {} }, undefined, { cap: 2 }), RangeError);
  assert.throws(() => new BlastCloud({ fireTemperature: 100 }), RangeError);
});

// The puffs a draw lays out, in world units: centre, radius, colour and glow (the Clouds target's distribute, read back
// through the cloud's box and matrix).
const drawn = (c, counts = {}) => {
  const log = { smoke: [], fire: [] },
    target = (list) => ({
      add(o) {
        const one = { options: { ...o }, matrix: new Float32Array(16) };
        list.push(one);
        return one;
      },
      remove(one) {
        list.splice(list.indexOf(one), 1);
        return true;
      },
    });
  c.draw(target(log.smoke), target(log.fire), counts);
  const read = (one) => {
    if (!one) return [];
    const { bounds, volume, segments } = one.options,
      m = one.matrix,
      big = volume / 2.4,
      out = [];
    for (let i = 0; i < segments; i++) {
      const p = one.options.distribute(i, Math.random);
      out.push({
        at: [
          m[12] + (p.point[0] * bounds[0]) / 2,
          m[13] + (p.point[1] * bounds[1]) / 2,
          m[14] + (p.point[2] * bounds[2]) / 2,
        ],
        r: p.volume * big,
        color: p.color,
        glow: p.emission,
      });
    }
    return out;
  };
  return { smoke: read(log.smoke[0]), fire: read(log.fire[0]) };
};

test('the cap is lobes all over its face, never one smooth blob showing between them (KB-BLAST-CAPBLUR)', () => {
  // Cap trees laid on random directions left open patches of the cap's face where the large inner filling puffs showed
  // as a smooth dark blur; laid on a spiral of even area (Gonzalez 2010) the lobes cover every direction of the face.
  for (const seed of [1, 2, 5, 1944]) {
    const c = new BlastCloud({ sources: [{ tnt: 2e6, speed: 100 }], seed });
    c.seek(40);
    const [th] = c.thermals(),
      { smoke } = drawn(c),
      [cx, cy, cz] = th.centre,
      norm = (p) => Math.hypot((p[0] - cx) / th.spread, (p[1] - cy) / th.thickness, (p[2] - cz) / th.spread),
      lobes = smoke.filter((p) => norm(p.at) > 0.6);
    let open = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      // Directions over the face a camera sees: from the top down to 30 degrees under the equator.
      const ct = 1 - (1.5 * (i + 0.5)) / N,
        st = Math.sqrt(1 - ct * ct),
        phi = i * 2.399963,
        s = [
          cx + 0.92 * th.spread * st * Math.cos(phi),
          cy + 0.92 * th.thickness * ct,
          cz + 0.92 * th.spread * st * Math.sin(phi),
        ];
      if (!lobes.some((p) => Math.hypot(p.at[0] - s[0], p.at[1] - s[1], p.at[2] - s[2]) < p.r)) open++;
    }
    assert.ok(open <= N * 0.01, `seed ${seed}: ${open} of ${N} directions of the cap's face have no lobe over them`);
  }
});

test('the smoke of an ammunition blast is grey-black, not brown (KB-BLAST-BROWN)', () => {
  // TNT's oxygen balance is -74 percent (Akhavan 2011), so its detonation leaves free carbon: black soot, as in the
  // Halifax (1917) and ammunition-dump photographs. The default cap and stem are neutral greys, the cap dark.
  const c = new BlastCloud({ sources: [{ tnt: 2e6, speed: 100 }] });
  c.seek(30);
  const { smoke } = drawn(c);
  for (const p of smoke) {
    const [r, g, b] = p.color,
      sum = r + g + b;
    assert.ok((r - b) / sum < 0.03, `puff colour ${p.color.map((v) => v.toFixed(3))} is brown`);
    assert.ok(sum / 3 < 0.25, `puff colour ${p.color.map((v) => v.toFixed(3))} is too pale for soot`);
  }
});

test('the fireball is white-hot at its base, brighter than display white, and dims as it burns down (KB-BLAST-PEACH)', () => {
  const c = new BlastCloud({ sources: [{ tnt: 2e6, speed: 100 }], fireDuration: 6 }),
    bright = (t) => {
      c.seek(t);
      const { fire } = drawn(c);
      return Math.max(0, ...fire.map((p) => p.color[1] + p.glow[1]));
    };
  const early = bright(0.3);
  assert.ok(early >= 3, `the fire's brightest puff is ${early.toFixed(2)} in green, under white-hot`);
  assert.ok(bright(4) < early, 'cooler later');
});

test('dark jets of thrown earth shoot out past the fireball in the first second and are gone by fifteen (KB-BLAST-JETS)', () => {
  const c = new BlastCloud({ sources: [{ tnt: 2e6, speed: 100 }], seed: 3 }),
    first = c.thermals(0.05)[0],
    out = (t) => {
      c.seek(t);
      const [th] = c.thermals(),
        { smoke } = drawn(c),
        cap = c.options.color ?? [0.16, 0.16, 0.165];
      return smoke.filter(
        (p) =>
          p.at[1] > 0.6 * first.radius &&
          Math.hypot(
            (p.at[0] - th.centre[0]) / th.spread,
            (p.at[1] - th.centre[1]) / th.thickness,
            (p.at[2] - th.centre[2]) / th.spread,
          ) > 1.15 &&
          p.color[1] < cap[1],
      ).length;
    };
  assert.ok(out(1) >= 20, `${out(1)} dark puffs out past the fireball at 1 s`);
  // Gone by fifteen: the draw is puff for puff the draw with no jets. (Counting dark puffs out past the cap, as at 1 s,
  // also counted the risen stem and the darker-mottled cap lobes, which are not jets.)
  const without = new BlastCloud({ sources: [{ tnt: 2e6, speed: 100 }], seed: 3, jets: 0 });
  for (const t of [6, 15]) {
    c.seek(t);
    without.seek(t);
    assert.deepEqual(drawn(c).smoke, drawn(without).smoke, `the jets have settled into the cloud by ${t} s`);
  }
  c.seek(1);
  without.seek(1);
  assert.notDeepEqual(drawn(c).smoke, drawn(without).smoke, 'the jets show at 1 s');
  assert.throws(() => new BlastCloud({ jets: 100 }), RangeError);
  assert.throws(() => new BlastCloud({ jets: 2.5 }), RangeError);
});
