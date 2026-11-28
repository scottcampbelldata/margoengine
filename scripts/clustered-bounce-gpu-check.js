// Real-GPU check of LightBounce (@margoengine/clustered/bounce, KB-CABIN-SNOWBOUNCE1): one bounce of a spot light off
// a floor patch onto the wall beside it, captured on the GPU with core's own lit shader, read back, reduced to virtual
// point lights and added to clusterLighting. Fixture tests/clustered-shadow-browser.ts (production clusterLighting
// probed at world points, the bounce hook's declarations and bindings included).
// - A 2 x 2 m patch of albedo 0.8 under a spot 100 m up (intensity 1e4, so irradiance 1, the cone's half angle
//   atan(0.02)); a wall of albedo 0.5 along its edge. A wall point c above the middle of the edge sees the patch with
//   the form factor F(c) of a differential element to a perpendicular rectangle (Howell's catalogue), so bounce on
//   minus bounce off is the radiance 0.5 / pi x 0.8 x F(c): 0.04043 at c 0.5 and 0.02421 at c 1. Within 5% of that,
//   and within 2% of the JS twin `bounceIrradiance` over the very data the GPU reads (the WGSL against its twin).
// - Two rooms with a 0.3 m wall between them, the lamp in one: the dark room's floor gets under 2% of what it gets
//   with `occlusion: false` (the imperfect shadow maps stop the bounce at the wall).
// - Halving the spot halves the bounce the same frame (intensities are written every frame; no capture is redone).
// node scripts/run-with-timeout.mjs -- node scripts/clustered-bounce-gpu-check.js (MARGO_COMPAT=1: WebGL2 layer)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { compatRun } from './support/compat-shim.js';
import { bounceIrradiance } from '../packages/clustered/dist/bounce.js';

const folder = 'test-results/clustered-bounce';
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 5321 });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.clusteredShadowFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const call = (name, ...args) =>
    page.evaluate(({ name, args }) => window.clusteredShadowFixture[name](...args), { name, args });
  function check(name, ok, detail) {
    checks.push({ name, ok, ...detail });
    if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
  }
  const wall = { base: [0.5, 0.5, 0.5], roughness: 1, metal: 0, specular: false },
    results = {};

  // The patch and the wall.
  const formFactor = (c, a = 2, b = 1) =>
      (2 * (Math.atan(b / c) - (c / Math.hypot(a, c)) * Math.atan(b / Math.hypot(a, c)))) / (2 * Math.PI),
    half = Math.atan(0.02),
    spot = { position: [0, 100, 1], direction: [0, -1, 0], angle: half, range: 0, intensity: 1e4, bounce: true },
    heights = [0.5, 1],
    points = heights.map((c) => [0, c, 0, 0, 0, 1]),
    patchScene = (bounce) => ({
      meshes: ['patch', 'patchWall'],
      local: false,
      points: [spot],
      ...(bounce ? { bounce } : {}),
    });
  await call('camera', [0, 1.5, 5], [0, 0.6, 0]);
  await call('scene', patchScene());
  await call('render', 1);
  const off = await call('probe', points, wall);
  await call('scene', patchScene({}));
  const settled = await call('settle', 30),
    on = await call('probe', points, wall);
  results.patch = { stats: settled.stats, rows: [] };
  check(
    'the spot is one bouncing source, captured and reduced to its virtual point lights',
    settled.stats.sources === 1 && settled.stats.vpls >= 24 && settled.stats.vpls <= 32 && settled.stats.captures >= 1,
    settled.stats,
  );
  heights.forEach((c, i) => {
    const gpu = on[i][0] - off[i][0],
      twin =
        (0.5 / Math.PI) *
        bounceIrradiance(new Float32Array(settled.data), points[i].slice(0, 3), points[i].slice(3))[0],
      analytic = (0.5 / Math.PI) * 0.8 * formFactor(c);
    results.patch.rows.push({ c, gpu, twin, analytic, errorAnalytic: gpu / analytic - 1, errorTwin: gpu / twin - 1 });
    check(
      `c ${c}: bounce ${gpu.toFixed(5)} within 5% of the form factor's ${analytic.toFixed(5)}`,
      Math.abs(gpu / analytic - 1) < 0.05,
      { gpu, analytic },
    );
    check(
      `c ${c}: bounce ${gpu.toFixed(5)} within 2% of the JS twin's ${twin.toFixed(5)}`,
      Math.abs(gpu / twin - 1) < 0.02,
      { gpu, twin },
    );
  });
  // Half the spot: the direct light and the bounce both halve on the next frame, with no new capture.
  await call('lights', [{ ...spot, intensity: spot.intensity / 2 }]);
  await call('render', 1);
  const halved = await call('probe', points, wall);
  heights.forEach((c, i) => {
    const ratio = (halved[i][0] - off[i][0] / 2) / (on[i][0] - off[i][0]);
    results.patch.rows[i].halfRatio = ratio;
    check(
      `c ${c}: half the spot gives half the bounce the same frame (${ratio.toFixed(4)})`,
      Math.abs(ratio - 0.5) < 0.005,
      { ratio },
    );
  });

  // KB-BOUNCE-CAPTURE1: the patch as a gltf/pbr model added to the bounce (`bounce.add`) reflects as the core patch
  // does: its capture draws the model's own material into the same target, so the wall's bounce matches the core
  // patch's within 2%, and the JS twin over the data the GPU reads within 2%. Not added, the model reflects nothing.
  results.model = { rows: [] };
  await call('scene', { ...patchScene({}), meshes: ['patchWall'], patchModel: 'not added' });
  const unadded = (await call('settle', 30)).stats,
    unaddedOn = await call('probe', points, wall);
  results.model.notAdded = { stats: unadded, bounce: heights.map((_, i) => unaddedOn[i][0] - off[i][0]) };
  check(
    'a gltf/pbr patch not added to the bounce reflects nothing',
    results.model.notAdded.bounce.every((b, i) => Math.abs(b) < 0.01 * (on[i][0] - off[i][0])),
    results.model.notAdded,
  );
  await call('scene', { ...patchScene({}), meshes: ['patchWall'], patchModel: true });
  const modelSettled = await call('settle', 30),
    modelOn = await call('probe', points, wall);
  results.model.stats = modelSettled.stats;
  check(
    'an added gltf/pbr patch is captured and reduced to virtual point lights',
    modelSettled.stats.sources === 1 && modelSettled.stats.vpls >= 24 && modelSettled.stats.vpls <= 32,
    modelSettled.stats,
  );
  heights.forEach((c, i) => {
    const gpu = modelOn[i][0] - off[i][0],
      core = on[i][0] - off[i][0],
      twin =
        (0.5 / Math.PI) *
        bounceIrradiance(new Float32Array(modelSettled.data), points[i].slice(0, 3), points[i].slice(3))[0];
    results.model.rows.push({ c, gpu, core, twin, errorCore: gpu / core - 1, errorTwin: gpu / twin - 1 });
    check(
      `c ${c}: the gltf/pbr patch bounces ${gpu.toFixed(5)}, within 2% of the core patch's ${core.toFixed(5)}`,
      Math.abs(gpu / core - 1) < 0.02,
      { gpu, core },
    );
    check(
      `c ${c}: the gltf/pbr patch bounce ${gpu.toFixed(5)} within 2% of the JS twin's ${twin.toFixed(5)}`,
      Math.abs(gpu / twin - 1) < 0.02,
      { gpu, twin },
    );
  });

  // KB-BOUNCE-CAPTURE2: the patch drawn by @margoengine/materials (createMesh with a standard Material) reflects as the
  // glTF quad does, and a clearcoat of 1, from materials (`clearcoat: 1`) or from KHR_materials_clearcoat drawn by
  // `materials.install`, keeps the base layer's 1 - F_coat(n.v) of it (KHR_materials_clearcoat, "Layering"): the spot
  // and the capture's eye sit 100 m straight over the patch, so n.v is 1 to within 2e-4 and F_coat the coat's F0 0.04,
  // and the bounce is 0.96 of the core patch's (within 1%). The JS twin over the data the GPU reads within 2%.
  results.layered = {};
  for (const [kind, weight] of [
    ['materials', 1],
    ['coated', 0.96],
    ['installed', 0.96],
    // A raw WGSL quad (@margoengine/shader/raw) whose captureEntry returns albedo 0.8: as the core patch.
    ['raw', 1],
  ]) {
    await call('scene', { ...patchScene({}), meshes: ['patchWall'], patchModel: kind });
    const settledKind = await call('settle', 30),
      kindOn = await call('probe', points, wall),
      rows = (results.layered[kind] = { stats: settledKind.stats, weight, rows: [] });
    check(
      `the ${kind} patch is captured and reduced to virtual point lights`,
      settledKind.stats.sources === 1 && settledKind.stats.vpls >= 24 && settledKind.stats.vpls <= 32,
      settledKind.stats,
    );
    heights.forEach((c, i) => {
      const gpu = kindOn[i][0] - off[i][0],
        core = on[i][0] - off[i][0],
        twin =
          (0.5 / Math.PI) *
          bounceIrradiance(new Float32Array(settledKind.data), points[i].slice(0, 3), points[i].slice(3))[0];
      rows.rows.push({ c, gpu, core, twin, ratio: gpu / core, errorTwin: gpu / twin - 1 });
      check(
        `c ${c}: the ${kind} patch bounces ${gpu.toFixed(5)}, ${weight} of the core patch's ${core.toFixed(5)} within 1%`,
        Math.abs(gpu / (weight * core) - 1) < 0.01,
        { gpu, core, weight },
      );
      check(
        `c ${c}: the ${kind} patch bounce ${gpu.toFixed(5)} within 2% of the JS twin's ${twin.toFixed(5)}`,
        Math.abs(gpu / twin - 1) < 0.02,
        { gpu, twin },
      );
    });
  }

  // The raw quad without captureEntry gives the capture its depth alone, so it reflects nothing.
  await call('scene', { ...patchScene({}), meshes: ['patchWall'], patchModel: 'raw depth' });
  await call('settle', 30);
  const rawDepthOn = await call('probe', points, wall);
  results.rawDepth = heights.map((_, i) => rawDepthOn[i][0] - off[i][0]);
  check(
    'a raw patch without captureEntry reflects nothing',
    results.rawDepth.every((b, i) => Math.abs(b) < 0.01 * (on[i][0] - off[i][0])),
    { bounce: results.rawDepth },
  );

  // KB-BOUNCE-TERMS1: the same spot projecting a red | blue image (linear) bounces the colours it casts. Its direct light
  // on the floor is red on +x and blue on -x (the image's u runs along the spot camera's x, here -x); the bounce at a
  // wall point on either side follows it, red and blue sum to the plain spot's bounce there (the halves are
  // complementary), and each channel is within 2% of the JS twin over the very VPLs the GPU reads.
  const sides = [0.5, -0.5],
    wallAt = sides.map((x) => [x, 0.5, 0, 0, 0, 1]),
    floorAt = sides.map((x) => [x, 0, 1, 0, 1, 0]);
  await call('scene', patchScene());
  await call('render', 1);
  const plainOff = await call('probe', wallAt, wall);
  await call('scene', patchScene({}));
  await call('settle', 30);
  const plainOn = await call('probe', wallAt, wall),
    projected = (bounce) =>
      page.evaluate(
        (config) =>
          window.clusteredShadowFixture.scene({
            ...config,
            projectors: [
              {
                image: { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) },
                colorSpace: 'linear',
              },
            ],
          }),
        patchScene(bounce),
      );
  await projected();
  await call('render', 1);
  const projOff = await call('probe', wallAt, wall),
    direct = await call('probe', floorAt, wall);
  await projected({});
  const projSettled = await call('settle', 30),
    projOn = await call('probe', wallAt, wall);
  results.projector = { direct, rows: [] };
  // The 2 x 1 image filtered bilinearly: x 0.5 is a quarter texel from the red texel's centre toward blue (the image
  // spans x -2 to 2), so red over blue is 0.75 / 0.25 = 3 there, and the mirror on -x.
  check(
    'the projected spot lights the floor 3 red to 1 blue at x 0.5, and the mirror at -0.5',
    Math.abs(direct[0][0] / direct[0][2] / 3 - 1) < 0.02 &&
      Math.abs(direct[1][2] / direct[1][0] / 3 - 1) < 0.02 &&
      direct[0][1] === 0,
    { direct },
  );
  sides.forEach((x, i) => {
    const gpu = [0, 1, 2].map((k) => projOn[i][k] - projOff[i][k]),
      plain = plainOn[i][0] - plainOff[i][0],
      twin = bounceIrradiance(new Float32Array(projSettled.data), wallAt[i].slice(0, 3), wallAt[i].slice(3)).map(
        (e) => (0.5 / Math.PI) * e,
      ),
      lead = x > 0 ? 0 : 2,
      other = 2 - lead;
    results.projector.rows.push({ x, gpu, twin, plain });
    check(
      `x ${x}: the bounce leans to the colour cast on its side (${gpu.map((v) => v.toFixed(5))})`,
      gpu[lead] > 1.5 * gpu[other] && Math.abs(gpu[1]) < 1e-4,
      { gpu },
    );
    check(
      `x ${x}: red and blue sum to the plain spot's bounce ${plain.toFixed(5)}`,
      Math.abs((gpu[0] + gpu[2]) / plain - 1) < 0.02,
      { gpu, plain },
    );
    for (const k of [0, 2])
      check(
        `x ${x} channel ${k}: bounce ${gpu[k].toFixed(5)} within 2% of the JS twin's ${twin[k].toFixed(5)}`,
        Math.abs(gpu[k] / twin[k] - 1) < 0.02,
        { gpu, twin },
      );
  });

  // Two rooms: the lamp in room A (x 0 to 4), the receiver on room B's floor (x 4.3 to 8.3).
  const lamp = { position: [2, 2.2, 2], range: 0, intensity: 10, bounce: true },
    dark = [[6.3, 0, 2, 0, 1, 0]],
    floor = { base: [0.5, 0.5, 0.5], roughness: 1, metal: 0, specular: false },
    rooms = (bounce) => ({
      meshes: ['roomsFloor', 'roomsCeiling', 'roomsWall'],
      local: false,
      points: [lamp],
      ...(bounce ? { bounce } : {}),
    });
  await call('camera', [4, 6, 10], [4, 1, 2]);
  await call('scene', rooms());
  await call('render', 1);
  const roomOff = (await call('probe', dark, floor))[0][0];
  await call('scene', rooms({ occlusion: false }));
  await call('settle', 30);
  const open = (await call('probe', dark, floor))[0][0] - roomOff;
  await call('scene', rooms({}));
  const roomStats = (await call('settle', 30)).stats,
    blocked = (await call('probe', dark, floor))[0][0] - roomOff;
  results.rooms = { open, blocked, share: blocked / open, stats: roomStats };
  check('the lamp is captured on all six faces', roomStats.sources === 1 && roomStats.captures >= 6, roomStats);
  check(`without occlusion the room's bounce reaches the dark room (${open.toExponential(3)})`, open > 1e-4, { open });
  check(
    `the wall keeps it out: ${blocked.toExponential(3)} under 2% of ${open.toExponential(3)}`,
    Math.abs(blocked) < 0.02 * open,
    { blocked, open },
  );

  // KB-BOUNCE-OCCLUDE1: the wall as a glTF box added to the bounce occludes as the core wall does: its triangles join the
  // visibility maps' scene occluders (the same count as the core wall's), and the dark room stays dark.
  await call('scene', { ...rooms({}), meshes: ['roomsFloor', 'roomsCeiling'], wallModel: true });
  const wallStats = (await call('settle', 30)).stats,
    wallBlocked = (await call('probe', dark, floor))[0][0] - roomOff;
  results.wallModel = { blocked: wallBlocked, share: wallBlocked / open, stats: wallStats, core: roomStats };
  check(
    `the glTF wall's triangles are occluders: ${wallStats.occluders} pieces, as the core wall's ${roomStats.occluders}`,
    wallStats.occluders === roomStats.occluders && wallStats.occluders > 0,
    { wall: wallStats, core: roomStats },
  );
  check(
    `the glTF wall keeps it out: ${wallBlocked.toExponential(3)} under 2% of ${open.toExponential(3)}`,
    Math.abs(wallBlocked) < 0.02 * open,
    { wallBlocked, open },
  );

  const compiled = await call('compile');
  check('WGSL compiles without errors or warnings', !compiled.core.length && !compiled.probe.length, compiled);
  check('no page errors', pageErrors.length === 0, { pageErrors });
  const fixtureErrors = await page.evaluate(() => window.clusteredShadowFixture.errors);
  check('no GPU validation or engine errors', fixtureErrors.length === 0, { fixtureErrors });
  const report = `${folder}/gpu${compatRun() ? '-compat' : ''}.json`;
  await writeFile(report, JSON.stringify({ hardware: browser.hardware, results, checks, failures }, null, 2) + '\n');
  console.log(JSON.stringify({ hardware: browser.hardware.webgpu, results, failures, report }, null, 2));
  assert.deepEqual(failures, [], 'LightBounce GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.clusteredShadowFixture?.dispose()).catch(() => {});
  await browser?.close();
}
