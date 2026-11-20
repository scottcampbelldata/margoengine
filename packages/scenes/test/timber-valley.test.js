// The timber-valley scene on the CPU: its catalogue entry, settings, presets, shots and the valley it lays out (lines,
// town lots, fuel, fire start, camera places). Its drawing is proved on a real GPU by timber-valley-still.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneInfo, scenes } from '@margoengine/scenes';
import { checkShotSettings } from '@margoengine/scenes/shot-settings';
import { attach, check, info, layout, weatherState, world } from '@margoengine/scenes/timber-valley';
import { WEATHER_SETTINGS } from '@margoengine/weather/settings';
import { SKY_SETTINGS } from '@margoengine/sky/settings';
import { FIRE_SETTINGS } from '@margoengine/vfx/settings';
import { fuelMap } from '@margoengine/biomes/fuel';

test('the catalogue lists timber-valley with every default in range and presets that name real settings', () => {
  assert.ok(scenes.some((s) => s.name === 'timber-valley'));
  assert.equal(sceneInfo('timber-valley'), info);
  const s = check({});
  assert.equal(s.date, '1910-08-20');
  for (const [name, preset] of Object.entries(info.presets)) {
    for (const key of Object.keys(preset)) assert.ok(key in info.settings, `${name}: ${key} is a setting`);
    check(preset);
  }
});

test('bad settings throw before anything is built', async () => {
  const engine = {};
  assert.throws(() => check(null), TypeError);
  assert.throws(() => check({ hour: 25 }), RangeError);
  assert.throws(() => check({ weather: 'storm' }), RangeError);
  assert.throws(() => check({ houses: 2.5 }), RangeError);
  assert.throws(() => check({ date: '1910-13-40' }), RangeError);
  assert.throws(() => check({ meshes: 3 }), TypeError);
  await assert.rejects(attach(engine, { fire: 'smouldering' }), RangeError);
});

test('every shot names real anchors and its settings check against the package tables', () => {
  const tables = { weather: WEATHER_SETTINGS, sky: SKY_SETTINGS, fire: FIRE_SETTINGS };
  assert.equal(info.shots.length, 8);
  for (const shot of info.shots) {
    assert.equal(shot.probes.length, 3, `${shot.name}: three probes`);
    for (const key of shot.camera) assert.ok(info.anchors.includes(key), `${shot.name}: ${key} is an anchor`);
    if (shot.settings) {
      for (const target of Object.keys(shot.settings)) assert.ok(target in info.targets);
      checkShotSettings(shot.settings, tables, shot.seconds);
    }
  }
  for (const v of info.views) assert.ok(info.anchors.includes(v));
});

test('the weather states: the blowup gale blows from the south-west toward the north-east', () => {
  const gale = weatherState('blowup', 225);
  assert.equal(gale.wind, 20);
  assert.ok(gale.humidity <= 0.15);
  // Toward the north-east: +x and -z; WeatherState's direction is 0 toward +z, pi/2 toward +x.
  assert.ok(Math.sin(gale.windDirection) > 0.7 && Math.cos(gale.windDirection) < -0.7, String(gale.windDirection));
  assert.ok(weatherState('smoke', 225).smoke > 0.3);
  assert.equal(weatherState('redFlag', 225).humidity, 0.15);
});

test('the valley: creek and rail fall to the outlet, the town sits on the floor off the rail and creek, the fire starts in fuel', async () => {
  const w = await world({}),
    plan = layout(w, {}),
    h = (p) => w.heightAt(p[0], p[1]);
  try {
    // Lines run from the west outlet up the valley, and fall all the way to it.
    assert.ok(plan.creek.length > 100 && plan.rail.length > 100);
    assert.ok(plan.creek[0][0] < -1900, 'the creek leaves the west edge');
    for (const line of [plan.creek, plan.rail])
      for (let i = 16; i < line.length; i += 16) assert.ok(h(line[i]) >= h(line[i - 16]) - 0.5, `rises up the valley at ${i}`);
    // The town: lots near the requested count, each on gentle ground near the floor and clear of the rail and creek.
    assert.ok(plan.structures.length >= 24 && plan.structures.length <= 48, `${plan.structures.length} lots`);
    const floor = (p) => {
      let best = Infinity;
      for (const q of plan.axis) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
      return best;
    };
    const near = (line, p) => Math.min(...line.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
    for (const lot of plan.structures) {
      assert.ok(floor(lot.at) < 260, `lot ${lot.at} is on the valley floor`);
      assert.ok(near(plan.rail, lot.at) > 6 && near(plan.creek, lot.at) > 8, `lot ${lot.at} is off the rail and the creek`);
    }
    // Fuel: timber models on the walls, none on the rail or the creek, the start in fuel.
    const fuel = fuelMap(w, { step: 8, bare: plan.town.exclusions });
    assert.equal(fuel.at(...plan.rail[60]), null, 'no fuel on the rail bed');
    assert.equal(fuel.at(...plan.creek[60]), null, 'no fuel in the creek');
    assert.ok(fuel.at(...plan.ignitions[0].at), `the fire starts in fuel (${fuel.at(...plan.ignitions[0].at)})`);
    const names = new Set();
    for (let i = 0; i < fuel.data.length; i++) if (fuel.data[i]) names.add(fuel.names[fuel.data[i] - 1]);
    for (const timber of ['FM8', 'FM10']) assert.ok(names.has(timber), `${timber} timber on the walls: ${[...names]}`);
    // The same settings give the same layout.
    const again = layout(w, {});
    assert.deepEqual(again.structures, plan.structures);
    assert.deepEqual(again.ignitions, plan.ignitions);
    // Lots off: no structures and the lines stay.
    assert.equal(layout(w, { houses: 0 }).structures.length, 0);
  } finally {
    w.dispose();
  }
});

// libraryMesh: a library glTF as one biome mesh part, so a library rock or plant draws by key in the forest scatter.
test('libraryMesh merges a glTF under its node transforms, base on the ground, and refuses heavy meshes', async () => {
  const { libraryMesh } = await import('@margoengine/scenes/library');
  const bin = new ArrayBuffer(3 * 12 * 2 + 6),
    f = new Float32Array(bin, 0, 18),
    u = new Uint16Array(bin, 72, 3);
  f.set([0, 0, 0, 2, 0, 0, 0, 3, 0]);
  f.set([0, 0, 1, 0, 0, 1, 0, 0, 1], 9);
  u.set([0, 1, 2]);
  const doc = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'a.bin', byteLength: 78 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.4, 0.3, 0.2, 1] } }],
      nodes: [{ children: [1], translation: [10, 5, 0] }, { mesh: 0, scale: [2, 2, 2] }],
      scenes: [{ nodes: [0] }],
    },
    fetch = async (url) =>
      url.endsWith('.gltf')
        ? { ok: true, status: 200, json: async () => doc }
        : url.endsWith('a.bin')
          ? { ok: true, status: 200, arrayBuffer: async () => bin }
          : { ok: false, status: 404 },
    part = await libraryMesh('/lib/rock/rock.gltf', { fetch });
  assert.deepEqual(Array.from(part.geometry.positions), [-2, 0, 0, 2, 0, 0, -2, 6, 0], 'scaled by its node, base at 0, centred');
  assert.deepEqual(Array.from(part.geometry.indices), [0, 1, 2]);
  assert.deepEqual(part.color.map((c) => +c.toFixed(3)), [0.4, 0.3, 0.2]);
  assert.equal(part.kind, 'stone');
  await assert.rejects(libraryMesh('/lib/rock/rock.gltf', { fetch, maxTriangles: 0 }), RangeError);
  await assert.rejects(libraryMesh('/lib/none.gltf', { fetch: async () => ({ ok: false, status: 404 }) }), { name: 'TypeError', message: /404; check the URL/ });
});

// The fire's past runs in the weather (the first frames of 2026-11-17: attach stepped the front through its 1,800 s
// before the drive had written any wind, so it burned in still air and covered a few hectares under a 20 m/s gale).
test('rollFire burns the past in the weather: far more ground under the gale than stepped alone', async () => {
  const { rollFire } = await import('@margoengine/scenes/timber-valley'),
    { FireFront } = await import('@margoengine/vfx/fire-front'),
    { WeatherMachine } = await import('@margoengine/weather'),
    { WeatherDrive } = await import('@margoengine/weather/drive'),
    w = await world({}),
    plan = layout(w, {}),
    fuel = fuelMap(w, { step: 8, bare: plan.town.exclusions }),
    run = (withDrive) => {
      const weather = new WeatherMachine(weatherState('blowup', 225)),
        fire = FireFront.create({
          ground: (x, z) => w.heightAt(x, z),
          size: [4096, 4096],
          origin: [-2048, -2048],
          cell: 8,
          fuel: (x, z) => fuel.at(x, z),
          ignitions: plan.ignitions,
          seed: 1910,
        }),
        drive = WeatherDrive.attach({ use() {} }, { weather, fires: fire, auto: false });
      if (withDrive) rollFire(drive, fire, 1800);
      else fire.advanceTime(1800);
      let n = 0;
      for (let z = -2044; z < 2048; z += 8) for (let x = -2044; x < 2048; x += 8) if (fire.state(x, z) === 1 || fire.state(x, z) === 2) n++;
      return n * 64;
    };
  try {
    const gale = run(true),
      still = run(false);
    // A surface fire in timber litter (Anderson 8 and 10) is slow even in a gale (measured 6,016 m2 against 3,776 m2
    // stepped alone); the 1910 runs were crown fires, which FireFront does not model yet (KB-FIRE-CROWN1).
    assert.ok(gale > 1.4 * still, `30 minutes in the gale burn ${gale} m2, stepped alone ${still} m2`);
  } finally {
    w.dispose();
  }
});
