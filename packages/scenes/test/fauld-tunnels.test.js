import assert from 'node:assert/strict';
import test from 'node:test';

const m = await import('../dist/fauld-tunnels.js');

test('fauld-tunnels: every state dresses with models, its lamps and one metered exposure', () => {
  assert.equal(m.FAULD_TUNNEL_STATES.length, 10);
  for (const state of m.FAULD_TUNNEL_STATES) {
    const d = m.dressState(state);
    assert.ok(d.pieces.size > 0, state);
    assert.ok(Number.isFinite(m.FAULD_STATE_EV[state]), state);
    for (const lamp of d.lamps) assert.ok(lamp.at.every(Number.isFinite), state);
  }
  // The mains states light the store with dozens of bulkheads; the day yard has none.
  assert.ok(m.dressState('working').lamps.length > 40);
  assert.equal(m.dressState('yard_day').lamps.length, 0);
});

test('fauld-tunnels: plan metres map to Margo (x, z, -y) and the tungsten colour has luminance 1', () => {
  assert.deepEqual(m.toWorld(10, 2, 3), [10, 3, -2]);
  const [r, g, b] = m.TUNGSTEN_2700;
  assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 0.01);
  assert.ok(r > g && g > b);
});

test('fauld-tunnels: attach rejects an unknown state before touching the engine', async () => {
  await assert.rejects(m.attach({}, { state: 'nowhere' }), RangeError);
});

// KB-FAULD-BULBHUE1: absolute luminance overflowed the half-float colour target (a 2700 K bulb's red channel about
// 100,000 cd/m2, past 65,504), clipping red alone so the bulbs read white-green under the 3200 K balance. Every light
// is now pre-exposed: the brightest glass of every state stays well inside half-float range.
test('fauld-tunnels: every state pre-exposes its lights so a bulb fits the half-float colour target', () => {
  for (const state of m.FAULD_TUNNEL_STATES) {
    const { lamps, exposure } = m.stateLights(state);
    assert.ok(exposure > 0 && exposure < 1, state);
    for (const lamp of lamps) {
      const radiance = lamp.intensity / (Math.PI * lamp.radius ** 2),
        top = Math.max(...lamp.color) * radiance;
      assert.ok(top < 65504 / 8, `${state}: a lamp's glass reaches ${top.toFixed(0)}, past half-float range`);
    }
  }
});

// The 3200 K white balance the store's tonemap uses (Bradford, from @margoengine/tonemap): a lamp must still read warm
// through it, red over green over blue. The plan's hand lamps were [1, 0.82, 0.6] (about 3,800 K), which read blue.
test('fauld-tunnels: every lamp reads warm through the 3200 K white balance', async () => {
  const { whiteBalanceMatrix } = await import('@margoengine/tonemap');
  const wb = whiteBalanceMatrix(3200, 0),
    balance = (c) => [0, 1, 2].map((r) => wb[r] * c[0] + wb[r + 3] * c[1] + wb[r + 6] * c[2]);
  for (const state of m.FAULD_TUNNEL_STATES)
    for (const lamp of m.stateLights(state).lamps) {
      // the blast flash too: a 3,000 K fireball, white-orange through the balance (KB-FAULD-BLASTBLUE1)
      const [r, g, b] = balance(lamp.color);
      assert.ok(r > g && g > b, `${state}: a lamp of colour ${lamp.color} reads ${[r, g, b].map((v) => v.toFixed(2))}`);
    }
});

// KB-FAULD-FIRELAMPS1: the plan's fire lamps were skipped as if a vfx fire lit each, but two of the fire state's four
// had no fire: the bays they lit stayed black. Every fire lamp now has a fire within 1.5 m.
test('fauld-tunnels: every fire lamp of a state burns as a fire', () => {
  for (const state of m.FAULD_TUNNEL_STATES) {
    const { lamps, fx } = m.dressState(state),
      { fires } = m.stateLights(state),
      burning = [
        ...fx.filter((f) => f[1] === 'fire').map((f) => [f[2], f[3]]),
        ...fires.map((f) => [f.at[0], f.at[1]]),
      ];
    for (const lamp of lamps.filter((l) => l.extra?.fire))
      assert.ok(
        burning.some(([x, y]) => Math.hypot(x - lamp.at[0], y - lamp.at[1]) <= 1.5),
        `${state}: the fire lamp at ${lamp.at} has no fire`,
      );
  }
  assert.ok(m.stateLights('fire').fires.length >= 1);
});

// KB-FAULD-BLASTDARK1: the blast flash sat in the work bay, behind its walls from the main drift, so the drift read
// black at the blast's exposure. A second flash stands in the drift abreast of each blast fire.
test('fauld-tunnels: the blast flash also stands in the main drift', () => {
  const flashes = m
    .stateLights('blast')
    .lamps.filter((l) => l.intensity === m.BLAST_FLASH_CD * m.stateLights('blast').exposure);
  assert.ok(
    flashes.some((l) => Math.abs(l.position[2]) < 0.01),
    'no flash on the drift centre line (plan y 0)',
  );
});

// The casings were copy-pasted: every stack drew the one tone. Each now has its own paint from its place.
test('fauld-tunnels: neighbouring stacks get different paint, the same place the same paint', () => {
  const tones = new Set();
  for (let x = 0; x < 30; x += 3)
    tones.add(
      m
        .paintTone(x, 0)
        .map((v) => v.toFixed(3))
        .join(),
    );
  assert.ok(tones.size >= 8, `only ${tones.size} tones over ten stacks`);
  assert.deepEqual(m.paintTone(12, -5.6), m.paintTone(12, -5.6));
  for (const v of m.paintTone(7, 3)) assert.ok(v > 0.8 && v < 1.15);
});

// KB-FAULD-GLOBE1: the bulbs drew a 30 mm sphere at the lamp's whole candela, about 26,000 in the pre-exposed frame
// (past the /8 headroom). A 60 or 100 W lamp in a 140 mm opal well glass emits from the globe, so the globe is the
// emitter: the light's radius is the globe's (WELL_GLASS_RADIUS, measured on tn_wellglass), the lumens unchanged, and
// the radiance falls with the larger area. Hand lamps emit through their 104 mm lens, the cradle's lamp from its bowl.
test('fauld-tunnels: the well glass is the emitter, each lamp keeping its luminous power', async () => {
  const { lumensToCandela, exposureFromEV100 } = await import('@margoengine/clustered/units');
  assert.equal(m.WELL_GLASS_RADIUS, 0.07);
  assert.equal(m.HANDLAMP_LENS_RADIUS, 0.052);
  const bulkhead = (lm) =>
      lumensToCandela(lm * m.BULKHEAD_OUTPUT, { outerAngle: Math.PI / 2, innerAngle: Math.PI * 0.32 }),
    allowed = [m.FAULD_LAMPS.w40, m.FAULD_LAMPS.w60, m.FAULD_LAMPS.w100].map(bulkhead);
  for (const state of m.FAULD_TUNNEL_STATES) {
    const { lamps, glass, exposure } = m.stateLights(state);
    assert.equal(exposure, exposureFromEV100(m.FAULD_STATE_EV[state]), state);
    for (const lamp of lamps) {
      const cd = lamp.intensity / exposure;
      if (lamp.outerAngle === Math.PI / 2) {
        // a mains lamp: 40, 60 or 100 W lumens through the caged fitting, unchanged, from the globe's area
        assert.equal(lamp.radius, m.WELL_GLASS_RADIUS, state);
        assert.ok(
          allowed.some((a) => Math.abs(cd - a) < 1e-6 * a),
          `${state}: a mains lamp gives ${cd.toFixed(1)} cd`,
        );
        const radiance = (Math.max(...lamp.color) * lamp.intensity) / (Math.PI * lamp.radius ** 2);
        assert.ok(radiance < 65504 / 8, `${state}: a well glass reads ${radiance.toFixed(0)}`);
      } else if (lamp.outerAngle !== undefined) {
        // an aimed lamp keeps the hand lamp's 40 lm in its cone
        const half = lamp.outerAngle;
        assert.ok(
          Math.abs(cd - lumensToCandela(m.FAULD_LAMPS.handlamp, { outerAngle: half, innerAngle: half * 0.55 })) <
            1e-6 * cd,
        );
        assert.ok([m.WELL_GLASS_RADIUS, m.HANDLAMP_LENS_RADIUS, m.DEEP_BOWL_RADIUS].includes(lamp.radius), state);
      }
    }
    // the fittings hang: every drawn globe is a hung lamp's, on the arch or the roadway roof
    for (const p of glass) assert.ok(p[1] >= m.HUNG_Z, `${state}: a well glass at ${p[1]} m`);
  }
  // the old 30 mm bulb would not have held: the working state's 100 W lamp read over the headroom at radius 0.03
  const w100 = m.stateLights('working').lamps.find((l) => l.outerAngle === Math.PI / 2 && l.position[0] === 8);
  assert.ok((Math.max(...w100.color) * w100.intensity) / (Math.PI * 0.03 ** 2) > 65504 / 8);
});

// The metered exposure (lighting plan, step 2): a white card at the state's key mark reads 1.0, within a third of a
// stop (as channel-films test_state_ev_is_frozen_to_the_meter). Direct light of every lamp, cosine and the spot's cone,
// no occlusion. After, flooded and sealed read 7.4 at EV 1 once the hand lamps were lifted (KB-FAULD-GLOBE1).
test('fauld-tunnels: the key card of each lamp-lit state reads 1.0 at its EV', () => {
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const card = (state, at, face) => {
    let e = 0;
    const n = face.map((v, i) => v - at[i]),
      nl = Math.hypot(...n);
    for (const lamp of m.stateLights(state).lamps) {
      const d = lamp.position.map((v, i) => v - at[i]),
        r = Math.hypot(...d),
        l = d.map((v) => v / r),
        cos = Math.max(0, (l[0] * n[0] + l[1] * n[1] + l[2] * n[2]) / nl),
        cone = lamp.direction
          ? smooth(
              Math.cos(lamp.outerAngle),
              Math.cos(lamp.innerAngle),
              -(l[0] * lamp.direction[0] + l[1] * lamp.direction[1] + l[2] * lamp.direction[2]),
            )
          : 1;
      e += (lamp.intensity * cone * cos) / r ** 2;
    }
    return e / Math.PI;
  };
  const along = (state, run, k) => {
    const row = m.dressState(state).lamps.find((l) => l.run === run),
      p = m.toWorld(...row.at),
      a = m.toWorld(...row.extra.aim),
      d = a.map((v, i) => v - p[i]),
      l = Math.hypot(...d);
    return [p.map((v, i) => v + (d[i] / l) * k), p];
  };
  const keys = {
    working: [m.toWorld(125.5, -5.25, 1.2), m.toWorld(123, -5.25, 2.95)],
    after: along('after', 't_drift1', 2),
    flooded: along('flooded', 't_flood1', 2),
    sealed: along('sealed', 't_seal1', 2),
    yard_night: along('yard_night', 'yard_lamp', 1.75),
  };
  for (const [state, [at, face]] of Object.entries(keys)) {
    const stops = Math.log2(card(state, at, face));
    assert.ok(Math.abs(stops) <= 1 / 3, `${state}: the key card reads ${2 ** stops} (${stops.toFixed(2)} stops)`);
  }
});

// No people in the Fauld film (Scott, 2026-11-24: "Build the entire video with no people"): a hand lamp lit at chest
// height with nobody holding it floated. Every hand lamp stands on the floor in its own fitting, lens toward its aim.
test('fauld-tunnels: every hand lamp stands on the floor in a tn_handlamp fitting', () => {
  let n = 0;
  for (const state of m.FAULD_TUNNEL_STATES) {
    const d = m.dressState(state),
      fittings = d.pieces.get(m.HANDLAMP_ASSET) ?? [];
    for (const lamp of d.lamps) {
      if (!lamp.extra?.aim || lamp.run === 'yard_lamp' || lamp.run === 'bulbs_cradle') continue;
      n++;
      assert.ok(
        Math.abs(lamp.at[2] - (m.HANDLAMP_STAND[0] - m.HANDLAMP_STAND[2])) < 1e-9,
        `${state} ${lamp.run} lens height ${lamp.at[2]}`,
      );
      const w = m.toWorld(...lamp.at);
      assert.ok(
        fittings.some(
          (f) => Math.hypot(f[12] - w[0], f[14] - w[2]) < 0.05 && Math.abs(f[13] - m.HANDLAMP_STAND[0]) < 1e-9,
        ),
        `${state} ${lamp.run}: no fitting under the lamp`,
      );
    }
  }
  assert.ok(n >= 10, `hand lamps checked: ${n}`);
});

// KB-VFX-SMOKEROOF1: the fire state's smoke climbed through the rock and veiled the flames in pale ovals.
test('fauld-tunnels: smoke underground stops at the roof, over every fire of the fire state', () => {
  assert.equal(m.fauldRoofHeight(125), 3.2);
  assert.equal(m.fauldRoofHeight(60), 3.39);
  const fx = m.dressState('fire').fx.filter((f) => f[1] === 'fire'),
    burning = [
      ...fx.map((f) => [f[2], f[4], f[5]]),
      ...m.stateLights('fire').fires.map((f) => [f.at[0], f.at[2], f.scale]),
    ];
  assert.ok(burning.length >= 3);
  for (const [x, z, scale] of burning) {
    const smoke = m.fauldFireSmoke(x, 0);
    assert.equal(smoke.ceiling, m.fauldRoofHeight(x));
    assert.ok(z + Math.min(3, 1.6 * scale) < smoke.ceiling, 'every flame stands under its roof');
    assert.ok(Math.max(...smoke.color) < 0.1, 'sooty smoke');
  }
});

// KB-VFX-ROOFDOTS1: each fire's smoke runs along its own gallery, so every fire stands between that gallery's walls.
test('fauld-tunnels: every fire of the fire state stands between its gallery walls', () => {
  const plan = [
    ...m
      .dressState('fire')
      .fx.filter((f) => f[1] === 'fire')
      .map((f) => [f[2], f[3], f[4]]),
    ...m.stateLights('fire').fires.map((f) => f.at),
  ];
  assert.ok(plan.length >= 3);
  for (const [px, py, pz] of plan) {
    const [x, , z] = m.toWorld(px, py, pz),
      { axis, walls } = m.fauldFireSmoke(x, z).gallery,
      across = axis === 'x' ? z : x;
    assert.ok(walls[0] < across && across < walls[1], `fire at ${x}, ${z} between ${walls}`);
  }
  assert.deepEqual(m.fauldGallery(125, 23), { axis: 'z', walls: [122.35, 127.65] });
  const aisle = m.fauldGallery(60, 5.6);
  assert.equal(aisle.axis, 'x');
  assert.ok(Math.abs(aisle.walls[0] - 2.8) < 1e-9 && Math.abs(aisle.walls[1] - 8.4) < 1e-9, 'the aisle between piers');
});
