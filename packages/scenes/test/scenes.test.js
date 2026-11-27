// The scene catalogue and the dune-coast landform, with no GPU: the root lists each scene with defaults inside their
// ranges, the entry's info is the catalogue's, settings are checked, and the built ground has the flat, the big dune
// and the beach where the layout puts them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneInfo, scenes } from '@margoengine/scenes';
import { attach, grassCover, ground, info } from '@margoengine/scenes/dune-coast';

test('the catalogue lists dune-coast, timber-valley, fauld-tunnels, fauld-countryside, fauld-crater and fauld-blast with every default inside its range', () => {
  assert.deepEqual(
    scenes.map((s) => s.name),
    ['dune-coast', 'timber-valley', 'fauld-tunnels', 'fauld-countryside', 'fauld-crater', 'fauld-blast'],
  );
  assert.equal(sceneInfo('dune-coast'), info);
  assert.throws(() => sceneInfo('nowhere'), RangeError);
  for (const [key, spec] of Object.entries(info.settings)) {
    if (spec.range) assert.ok(spec.default >= spec.range[0] && spec.default <= spec.range[1], key);
    if (spec.options) assert.ok(spec.options.includes(spec.default), key);
  }
  for (const preset of Object.values(info.presets))
    for (const key of Object.keys(preset)) assert.ok(key in info.settings, `preset setting ${key}`);
});

test('bad settings throw before anything is built', () => {
  const engine = {};
  assert.throws(() => attach(engine, { hour: 25 }), RangeError);
  assert.throws(() => attach(engine, { weather: 'storm' }), RangeError);
  assert.throws(() => attach(engine, { date: '17/12/1903' }), RangeError);
  assert.throws(() => attach(engine, null), TypeError);
  // Colours: three linear RGB values from 0 to 1 for the sand, the shed boards and the roof.
  for (const key of ['sand', 'boards', 'roof'])
    for (const bad of [[0.5, 0.5], [0.5, 0.5, 1.2], '0.5,0.5,0.5', [0.5, Number.NaN, 0.5]])
      assert.throws(
        () => attach(engine, { [key]: bad }),
        /is not a colour; pass three linear RGB values/,
        `${key} ${bad}`,
      );
});

test('the shed boards and roof are settings whose defaults are the weatheredWood preset, the look before they existed', async () => {
  const { weatheredWood } = await import('@margoengine/materials/presets');
  for (const key of ['boards', 'roof'])
    assert.deepEqual(info.settings[key].default, weatheredWood.color.slice(0, 3), key);
});

test('the built ground: a flat at the rail, the big dune to the south, the beach to the east', () => {
  const h = ground();
  assert.ok(Math.abs(h(0, 0) - 2.5) < 0.3, `rail ${h(0, 0)}`);
  assert.ok(h(-40, 430) > 30 && h(-40, 430) < 33.5, `hill crest ${h(-40, 430)}`);
  // Windward (north) side gentle, lee (south) side steeper.
  const north = (h(-40, 380) - h(-40, 330)) / 50,
    south = (h(-40, 460) - h(-40, 475)) / 15;
  assert.ok(north > 0.1 && north < 0.27 && south > 0.4, `slopes ${north} ${south}`);
  assert.ok(Math.abs(h(900, 0)) < 0.05 && h(950, 0) < -0.5, 'waterline at x = 900, shelf below');
  assert.equal(ground({ hill: 0 })(-40, 430) < 5, true);
  // Real heights replace the landform; sea cells go under the water.
  const samples = new Float32Array(16).fill(3);
  samples[0] = 0;
  const real = ground({ heights: { samples, width: 4, depth: 4, origin: [0, 0] } });
  assert.equal(real(2, 2), 3);
  assert.equal(real(0, 0), -1.5);
});

// KB-SCENES-GRASS1: the old grass rules (minHeight 2.95 m on a 2.5 m flat whose hummocks fade out within 220 m of the
// camp, a 140 m cull distance, 12 to 29 cm three-blade tufts) left 20 to 120 tiny tufts near any view: none showed.
test('dune grass grows in clumps around every land view, and not on the beach or the bare hill top', () => {
  const cover = grassCover(),
    h = ground();
  for (const [view, [x0, z0]] of Object.entries({
    'first-flight': [14, -14],
    'camp-buildings': [-40, -12],
    'killdevil-from-flat': [10, -60],
    'landing-rail-view': [-4, -48],
    'killdevil-back': [-40, 640],
  })) {
    let sum = 0,
      full = 0,
      bare = 0,
      n = 0;
    for (let x = -60; x <= 60; x += 1.5)
      for (let z = -60; z <= 60; z += 1.5) {
        const v = cover(x0 + x, z0 + z);
        sum += v;
        full += v > 0.5 ? 1 : 0;
        bare += v < 0.05 ? 1 : 0;
        n++;
      }
    // Some ground in grass, in patches with bare sand between them.
    assert.ok(sum / n > 0.1, `${view}: cover ${sum / n}`);
    assert.ok(full / n > 0.08 && bare / n > 0.3, `${view}: patches ${full / n}, bare ${bare / n}`);
  }
  for (let z = -300; z <= 300; z += 25) assert.equal(cover(900, z), 0, `wet beach ${z}`);
  assert.ok(h(-40, 430) > 30 && cover(-40, 430) === 0, 'the big dune crest is bare');
  // The setting scales it; 0 removes it.
  const none = grassCover({ grass: 0 }),
    more = grassCover({ grass: 1 });
  let a = 0,
    b = 0;
  for (let x = -100; x <= 100; x += 2) {
    assert.equal(none(x, 40), 0);
    a += cover(x, 40);
    b += more(x, 40);
  }
  assert.ok(b > a * 1.5, `grass 1 ${b} against 0.5 ${a}`);
});

// The film's look needs the grass, the crest and the sand far detail as settings; their defaults are the values the
// scene built before they existed, so a scene without them looks the same.
test('grass colour, height, clump and variety, crest sharpness and sand bands are settings with the old look as default', () => {
  const d = (k) => info.settings[k].default;
  assert.deepEqual(d('grassColor'), [0.36, 0.31, 0.16]);
  assert.equal(d('grassHeight'), 0.8);
  assert.equal(d('grassBlades'), 30);
  assert.equal(d('grassVariety'), 0.035);
  assert.equal(d('crest'), 0);
  assert.equal(d('sandBands'), 0);
  assert.equal(d('grassTranslucency'), 0);
  assert.equal(d('grassWidth'), 0.016);
  const engine = {};
  for (const bad of [
    [0.5, 0.5],
    [0.5, 0.5, 1.2],
  ])
    assert.throws(() => attach(engine, { grassColor: bad }), /grassColor is not a colour/);
  assert.throws(() => attach(engine, { grassHeight: 3 }), RangeError);
  assert.throws(() => attach(engine, { grassBlades: 12.5 }), /grassBlades is not a whole number/);
  assert.throws(() => attach(engine, { grassBlades: 80 }), RangeError);
  assert.throws(() => attach(engine, { crest: 2 }), RangeError);
  // Crest 0 is the old ground; a sharp crest keeps the crest height and fills the rounded shoulders out to a brink.
  const old = ground(),
    same = ground({ crest: 0 }),
    sharp = ground({ crest: 1 });
  for (const z of [400, 420, 430, 440, 460]) assert.equal(same(-40, z), old(-40, z));
  assert.ok(Math.abs(sharp(-40, 430) - old(-40, 430)) < 1.5, `crest ${sharp(-40, 430)} against ${old(-40, 430)}`);
  let fuller = 0;
  for (let z = 410; z <= 450; z += 2) fuller += sharp(-40, z) - old(-40, z);
  assert.ok(fuller > 0.4, `sharp brink adds ${fuller} m over the crest`);
});

// KB-SCENES-PRINTS1: the sand round the camp is trodden by default; 0 leaves it untouched.
test('footprints is a setting from 0 to 1, trodden by default', () => {
  assert.equal(info.settings.footprints.default, 1);
  assert.throws(() => attach({}, { footprints: 2 }), RangeError);
  assert.throws(() => attach({}, { footprints: -0.1 }), RangeError);
});

test('the shed overhang, weathering and windows are settings with the old sheds as default', () => {
  assert.equal(info.settings.shedOverhang.default, 0.2);
  assert.equal(info.settings.shedWeathering.default, 0.5);
  assert.equal(info.settings.shedWindows.default, false);
  assert.throws(() => attach({}, { shedOverhang: 2 }), RangeError);
  assert.throws(() => attach({}, { shedWeathering: -1 }), RangeError);
});

// Kitty Hawk film review (Scott, 2026-11-17): the big dune's face showed regular rows, the flat's 0.8 m hummock field
// laid over it. The hummocks now fade out as a dune rises, so the dune faces are smooth sand.
test('the big dune carries no hummock rows: its windward face rises smoothly', () => {
  const h = ground(),
    bare = ground({ hill: 0 });
  // Second differences along the face (2 m steps, 340 to 400 m south): no hummock-sized bumps.
  let rough = 0;
  for (let z = 340; z <= 400; z += 2) rough = Math.max(rough, Math.abs(h(-40, z + 2) - 2 * h(-40, z) + h(-40, z - 2)));
  assert.ok(rough < 0.08, `face roughness ${rough}`);
  // The flat away from the dunes keeps its hummocks.
  let flat = 0;
  for (let z = -400; z <= -340; z += 2)
    flat = Math.max(flat, Math.abs(bare(300, z + 2) - 2 * bare(300, z) + bare(300, z - 2)));
  assert.ok(flat > 0.08, `flat roughness ${flat}`);
});

test('blown sand is a setting from 0 to 1 that is off by default, and the crest view is listed', () => {
  assert.equal(info.settings.blownSand.default, 0);
  assert.deepEqual(info.settings.blownSand.range, [0, 1]);
  assert.ok(info.views.includes('crest'));
  for (const bad of [-0.1, 1.5, Number.NaN]) assert.throws(() => attach({}, { blownSand: bad }), RangeError, `${bad}`);
});

// KB-SCENES-BLOWNSAND-STATIC1: pay only for what you import. The blown sand is off by default, so the dune-coast entry
// loads @margoengine/vfx/blown-sand on demand (scene.ready) and never imports it statically.
test('dune-coast loads the blown sand on demand, never by a static import', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../dist/dune-coast.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s[^;]*?from\s*['"]@margoengine\/vfx\/blown-sand['"]/m);
  assert.doesNotMatch(source, /^\s*export\s[^;]*?from\s*['"]@margoengine\/vfx\/blown-sand['"]/m);
  assert.match(source, /import\(\s*['"]@margoengine\/vfx\/blown-sand['"]\s*\)/);
});

// KB-SCENES-CAMPGRASS1: dune grass grew through the hangar and shed floors (the Kitty Hawk film's shot from inside the
// hangar showed clumps indoors); the camp yard is bare sand, also at full grass and with the camp left to a film.
test('no dune grass grows in the camp yard, inside the hangar and the shed', () => {
  for (const settings of [{}, { grass: 1 }, { grass: 1, camp: false }]) {
    const cover = grassCover(settings);
    for (let x = -96; x <= -62.5; x += 0.5)
      for (let z = 27.5; z <= 32.5; z += 0.5) assert.equal(cover(x, z), 0, `${JSON.stringify(settings)} at ${x}, ${z}`);
  }
  // Grass still grows round the yard.
  const cover = grassCover({ grass: 1 });
  let outside = 0;
  for (let x = -110; x <= -50; x += 1) outside += cover(x, 45) + cover(x, 15);
  assert.ok(outside > 5, `grass round the camp ${outside}`);
});

test('the wind shapes the sand round the camp: moats and deposits at the sheds, dunes behind grass, none when calm', () => {
  assert.equal(info.settings.scour.default, 1);
  assert.throws(() => attach({}, { scour: 1.5 }), RangeError);
  const shaped = ground(),
    plain = ground({ scour: 0 }),
    half = ground({ scour: 0.5 }),
    change = (x, z) => shaped(x, z) - plain(x, z);
  // The north wind blows toward +z: the hangar's windward wall is at z = 27.55, its horseshoe about 2 m in front.
  const front = Array.from({ length: 80 }, (_, k) => change(-70, 27.5 - k * 0.05));
  assert.ok(Math.min(...front) < -0.08, `moat ${Math.min(...front)}`);
  assert.ok(Math.max(...front) > 0.1, `horseshoe ${Math.max(...front)}`);
  assert.ok(Math.abs(half(-70, 26.8) - plain(-70, 26.8) - 0.5 * change(-70, 26.8)) < 1e-9);
  // Nothing under or against a shed, so both stand on the ground they stood on.
  for (const [x, z] of [
    [-70, 30],
    [-88.5, 30],
    [-76.7, 30],
    [-63.3, 32.45],
  ])
    assert.ok(Math.abs(change(x, z)) < 1e-6, `${x}, ${z}: ${change(x, z)}`);
  // Shadow dunes behind grass round the camp and the rail, none on the rail's cleared strip or far from the camp.
  let dunes = 0;
  for (let x = -60; x <= -10; x += 0.5) for (let z = -50; z <= 0; z += 0.5) dunes = Math.max(dunes, change(x, z));
  assert.ok(dunes > 0.1, `dunes ${dunes}`);
  for (let z = -19; z <= 0; z += 0.5) for (const x of [-1, 0, 1]) assert.equal(change(x, z), 0);
  assert.equal(change(300, -300), 0);
  // Without the camp only the dunes are left; calm air moves nothing.
  const bare = ground({ camp: false });
  assert.ok(bare(-70, 25.6) - ground({ camp: false, scour: 0 })(-70, 25.6) >= 0);
  const calm = ground({ wind: 5 }),
    still = ground({ wind: 5, scour: 0 });
  for (let x = -90; x <= -60; x += 0.7) assert.equal(calm(x, 26), still(x, 26));
});
