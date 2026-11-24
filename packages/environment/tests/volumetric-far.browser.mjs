// Real-GPU check of VolumetricFog's far air (`@margoengine/environment/volumetric`, `range`, `visibility`, `sky`): a
// flat Water sea to the horizon seen from 300 m, fogged through a post capture with the water's depth (`depth`), and
// once with no `depth`, where the fog finds the depth the water drew by itself; no `Water.setFog`. Each pixel's
// transmittance is measured from linear HDR light, T = (L_f - L) / (L_f - L_0), with L_0 the frame without fog and
// L_f the fully fogged light (the ambient of 1), and compared with exp(-optical depth) integrated on the CPU along the pixel's ray from the near plane to the sea or,
// above the horizon, to the sky. Until 2026-11-16 the fog stopped at `range` (here 600 m): the sea at 1 km, at 3 km and
// at the horizon all got the fog of 600 m.
//   - Koschmieder: the sea at the visibility V shows exp(-3.912) = 2% (+-0.5%) contrast against the fully fogged sky.
//   - A sea 3 km out fades by exp(-3.912 x 3,000 / V); every sea and sky pixel within 0.01 of the integral, uniform fog
//     and height fog (falloff 0.004 above 50 m, and above 400 m with the camera in the layer) alike, past `range` and before it.
//   - The join at `range`: the luma step there is under 1 code (8-bit sRGB) beyond its neighbours'.
//   - With a Sky and no `ambient`, a fully fogged far sea equals the fogged sky just above it within 1% (no step at the
//     horizon) and the unfogged sky 2.8 degrees up, the sky map row the fog's light is, within 2%; its gap to the
//     horizon sky is then the sky's own gradient from 0.5 to 2.8 degrees, read from the unfogged frame.
//   - KB-FOG-FAR-TRANSPARENT: a transparent pane on the sea added with `fog.add` takes the same far air: within 0.01 of
//     the integral past range, and with a Sky within 1% of the fogged sea under it.
// Run: npm run test:fog-far:browser (native, then the WebGL2 compatibility layer with --compat).
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 320,
  HEIGHT = 240,
  FOV = 40,
  NEAR = 1,
  EYE = [0, 300, 0],
  PITCH = (15 * Math.PI) / 180,
  TARGET = [0, EYE[1] - Math.tan(PITCH) * 1000, -1000],
  RANGE = 600;
const compat = compatRun();
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

// Each pixel's ray (unnormalised, forward component 1, so its length is the distance per metre of view depth).
const sub = (a, b) => a.map((v, i) => v - b[i]),
  norm = (a) => a.map((v) => v / Math.hypot(...a)),
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const forward = norm(sub(TARGET, EYE)),
  right = norm(cross(forward, [0, 1, 0])),
  up = cross(right, forward),
  tan = Math.tan((FOV * Math.PI) / 360);
function ray(x, y) {
  const sx = ((2 * (x + 0.5)) / WIDTH - 1) * tan * (WIDTH / HEIGHT),
    sy = (1 - (2 * (y + 0.5)) / HEIGHT) * tan;
  return forward.map((f, i) => f + sx * right[i] + sy * up[i]);
}
// Optical depth of sigma(y) = density exp(-falloff max(y - height, 0)) along the pixel's ray from the near plane to the
// sea (y = 0) or, for the sky, to where the density is e^-40 of its peak, by the midpoint rule over 20,000 steps (about
// 0.5 m of height a step).
function optical(x, y, { density, falloff, height }) {
  const d = ray(x, y),
    length = Math.hypot(...d),
    w = d.map((v) => v / length),
    start = NEAR * length,
    // Up to where the density has fallen by e^-40 (uniform fog: 1,000 km, fully fogged either way).
    end = w[1] < 0 ? EYE[1] / -w[1] : falloff > 0 ? Math.max(start, (height + 40 / falloff - EYE[1]) / w[1]) : 1e6,
    steps = 20000,
    h = (end - start) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const s = start + (i + 0.5) * h,
      altitude = EYE[1] + w[1] * s;
    sum += density * Math.exp(-falloff * Math.max(altitude - height, 0));
  }
  return { tau: sum * h, distance: w[1] < 0 ? end : Infinity, depth: (w[1] < 0 ? end : Infinity) / length };
}
const code = (v) => {
  const c = Math.min(Math.max(v, 0), 1);
  return 255 * (c >= 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : c * 12.92);
};

try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT, FOV, NEAR, EYE, TARGET }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { engineRuntime } = await import('/packages/core/dist/extension.js');
      const { Water } = await import('/packages/water/dist/index.js');
      const { PostStack } = await import('/packages/post/dist/index.js');
      const { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: EYE, target: TARGET, fov: FOV, near: NEAR, far: 100000 },
      });
      engine.gpu.pushErrorScope('validation');
      const runtime = engineRuntime(engine);
      // No sun; an ambient of 1, which a fog with no sky scatters: its fully fogged light is 1.
      runtime.lighting.direction.set([0, 1, 0, 0]);
      runtime.lighting.radiance.set([0, 0, 0, 1]);
      const stack = PostStack.attach(engine, [new Tonemap()]);
      const water = Water.attach(engine, {
        size: [2000, 2000],
        segments: 64,
        horizon: true,
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
      });
      const half = (bits) => {
        const e = (bits >> 10) & 31,
          m = bits & 1023,
          s = bits & 32768 ? -1 : 1;
        return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
      };
      // A transparent pane lying on the sea's plane (y = 0) from 100 m to 100 km out, drawn through the fog's hook with
      // alpha 1 and linear colour 0.2: where it covers the sea its pixel is 0.2 T + L, so its fog is measured as the sea's.
      const device = engine.gpu,
        camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      let panePipeline;
      const pane = {
        setTransparency(hook) {
          pane.hook = hook;
          return () => (pane.hook = undefined);
        },
        drawTransparent(c, hook) {
          device.queue.writeBuffer(camera, 0, new Float32Array(c.camera.matrix));
          if (!panePipeline) {
            const module = device.createShaderModule({
              code: `${hook.surface(0)}
@group(1) @binding(0) var<uniform> viewProjection:mat4x4f;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let c=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1))[i];
  return viewProjection*vec4f(c.x*60000.0,0.0,-50050.0+c.y*49950.0,1);
}
@fragment fn transparent(@builtin(position) p:vec4f)->MargoTransparent {return margoTransparentAt(vec4f(0.2,0.2,0.2,1.0),p,0.0);}`,
            });
            panePipeline = device.createRenderPipeline({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: { module, entryPoint: 'transparent', targets: [...hook.targets] },
              depthStencil: { format: c.descriptor.depthStencil.format, depthWriteEnabled: false, depthCompare: 'always' },
              multisample: { count: c.descriptor.multisample?.count ?? 1 },
            });
          }
          const pass = hook.begin();
          pass.setPipeline(panePipeline);
          pass.setBindGroup(0, device.createBindGroup({ layout: panePipeline.getBindGroupLayout(0), entries: hook.bindings() }));
          pass.setBindGroup(1, device.createBindGroup({ layout: panePipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: camera } }] }));
          pass.draw(6);
        },
      };
      window.farTest = {
        pane,
        engine,
        runtime,
        stack,
        water,
        // Two frames (the second reads the sky map the first asked for), then the capture's linear HDR green channel.
        async frame() {
          const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
          await waitForPipelines(async () => {
            engine.render({ delta: 0 });
            await engine.gpu.queue.onSubmittedWorkDone();
          });
          engine.render({ delta: 0 });
          await engine.gpu.queue.onSubmittedWorkDone();
          const texture = stack.sceneTexture;
          if (!texture || texture.format !== 'rgba16float') throw new Error(`capture format ${texture?.format}`);
          const row = Math.ceil((texture.width * 8) / 256) * 256,
            buffer = engine.gpu.createBuffer({ size: row * texture.height, usage: 1 | 8 });
          const encoder = engine.gpu.createCommandEncoder();
          encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
          engine.gpu.queue.submit([encoder.finish()]);
          await buffer.mapAsync(1);
          const bits = new Uint16Array(buffer.getMappedRange().slice(0)),
            out = [];
          buffer.unmap();
          buffer.destroy();
          for (let y = 0; y < texture.height; y++)
            for (let x = 0; x < texture.width; x++) out.push(half(bits[(y * row) / 2 + x * 4 + 1]));
          return out;
        },
      };
    },
    { WIDTH, HEIGHT, FOV, NEAR, EYE, TARGET },
  );
  // L_0 (the fog off) and L (on) for one fog.
  // `own`: the fog given no `depth`, so it must find the depth the water drew this frame by itself.
  const pair = (options, own = false) =>
    page.evaluate(async ({ options, own }) => {
      const t = window.farTest,
        { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
      t.fog?.dispose();
      t.fog = VolumetricFog.attach(t.engine, own ? options : { ...options, depth: () => t.water.depthTexture });
      t.fog.options.enabled = false;
      const clear = await t.frame();
      t.fog.options.enabled = true;
      return { clear, fogged: await t.frame() };
    }, { options, own });
  const base = { range: RANGE, temporal: 0, sky: null },
    report = { hardware, compat, checks: [], cases: {} };
  const cases = [
    { name: 'uniform-1km', fog: { ...base, visibility: 1000, heightFalloff: 0 }, medium: { visibility: 1000, falloff: 0, height: 0 } },
    { name: 'uniform-10km', fog: { ...base, visibility: 10000, heightFalloff: 0 }, medium: { visibility: 10000, falloff: 0, height: 0 } },
    {
      name: 'height-2km',
      fog: { ...base, visibility: 2000, heightFalloff: 0.004, height: 50 },
      medium: { visibility: 2000, falloff: 0.004, height: 50 },
    },
    // The camera inside the dense layer, under its 400 m top: rays up leave it, rays down stay in it.
    {
      name: 'height-inside',
      fog: { ...base, visibility: 3000, heightFalloff: 0.004, height: 400 },
      medium: { visibility: 3000, falloff: 0.004, height: 400 },
    },
    // KB-FOG-WATERDEPTH1: with no `depth` the fog read the capture's depth, which holds no water, so every sea pixel
    // took the infinite far air and drew fully fogged (T = 0 where the integral gives 0.08 to 0.81 in 10 km air).
    {
      name: 'uniform-10km-no-depth',
      own: true,
      fog: { ...base, visibility: 10000, heightFalloff: 0 },
      medium: { visibility: 10000, falloff: 0, height: 0 },
    },
  ];
  for (const { name, fog, medium, own } of cases) {
    const { clear, fogged } = await pair(fog, own),
      density = Math.log(50) / medium.visibility;
    let worst = 0,
      compared = 0,
      past = 0,
      sea = 0,
      sky = 0;
    const koschmieder = [],
      at3km = [];
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        const i = y * WIDTH + x,
          l0 = clear[i];
        // Only pixels the fog can measurably change (L_f = 1 against L_0 at least 0.2 away).
        if (!(1 - l0 >= 0.2)) continue;
        const { tau, distance, depth } = optical(x, y, { density, falloff: medium.falloff, height: medium.height }),
          want = Math.exp(-tau),
          got = (1 - fogged[i]) / (1 - l0);
        worst = Math.max(worst, Math.abs(got - want));
        compared++;
        if (depth > RANGE) past++;
        if (distance < Infinity) sea++;
        else sky++;
        if (name === 'uniform-1km' && Math.abs(distance - 1000) <= 15) koschmieder.push(got);
        if (name === 'uniform-10km' && Math.abs(distance - 3000) <= 40) at3km.push({ got, want: Math.exp(-density * 3000) });
      }
    report.cases[name] = { worst, compared, past, sea, sky };
    assert.ok(past > 5000 && sea > 5000, `${name}: ${past} pixels past range, ${sea} sea pixels`);
    assert.ok(worst <= 0.01, `${name}: transmittance off the integral by ${worst.toFixed(4)} at worst`);
    report.checks.push(`${name}: ${compared} sea and sky pixels (${past} past range) within 0.01 of exp(-optical depth)`);
    if (name === 'uniform-1km') {
      const contrast = koschmieder.reduce((a, b) => a + b, 0) / koschmieder.length;
      report.cases[name].contrast = contrast;
      assert.ok(koschmieder.length > 20, `${koschmieder.length} sea pixels at 1 km`);
      assert.ok(Math.abs(contrast - 0.02) <= 0.005, `Koschmieder: the sea at V shows ${contrast} contrast, not 2%`);
      report.checks.push(`Koschmieder: the sea at the 1 km visibility shows ${(contrast * 100).toFixed(2)}% contrast`);
    }
    if (name === 'uniform-10km') {
      const mean = at3km.reduce((a, b) => a + b.got, 0) / at3km.length,
        want = at3km[0].want;
      report.cases[name].at3km = { mean, want };
      assert.ok(at3km.length > 20 && Math.abs(mean - want) <= 0.01, `the sea 3 km out: T ${mean}, want ${want}`);
      report.checks.push(`the sea 3 km out fades to ${mean.toFixed(4)} (exp(-sigma 3,000) = ${want.toFixed(4)})`);
      // The join at `range`: in the middle column, the 8-bit luma step where the view depth crosses it, beyond the
      // mean step 3 to 6 rows away.
      const x = WIDTH >> 1,
        rows = [];
      for (let y = 0; y < HEIGHT; y++) rows.push(optical(x, y, { density, falloff: 0, height: 0 }).depth);
      const at = rows.findIndex((d, y) => y > 0 && rows[y - 1] > RANGE && d <= RANGE),
        luma = (y) => code(fogged[y * WIDTH + x]),
        step = (y) => Math.abs(luma(y) - luma(y - 1));
      assert.ok(at > 8 && at < HEIGHT - 8, `range crossed at row ${at}`);
      let around = 0;
      for (let d = 3; d <= 6; d++) around += step(at - d) + step(at + d);
      const seam = Math.max(step(at - 1), step(at), step(at + 1)) - around / 8;
      report.cases[name].rangeSeam = seam;
      assert.ok(seam < 1, `luma step at range ${seam.toFixed(2)} codes`);
      report.checks.push(`the luma step where the view depth crosses range is ${seam.toFixed(2)} codes beyond its neighbours`);
    }
  }

  // KB-FOG-FAR-TRANSPARENT: a transparent added with `fog.add` past `range` takes the far air too. The pane lies on the
  // sea, so each of its pixels is measured against the same integral as the sea pixel it covers. Until 2026-11-17 it
  // took the fog of the first 600 m only: at 1 km in 1 km air T was exp(-3.912 x 0.6) = 0.096 where the sea showed 0.020.
  const paneRun = await page.evaluate(async (RANGE) => {
    const t = window.farTest,
      { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
    t.fog?.dispose();
    t.fog = VolumetricFog.attach(t.engine, { range: RANGE, temporal: 0, sky: null, visibility: 1000, heightFalloff: 0, depth: () => t.water.depthTexture });
    t.fog.add(t.pane);
    return t.frame();
  }, RANGE);
  {
    const density = Math.log(50) / 1000;
    let worst = 0,
      past = 0,
      compared = 0;
    const atV = [];
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        const { tau, distance, depth } = optical(x, y, { density, falloff: 0, height: 0 });
        if (!(distance < 90000)) continue;
        const got = (1 - paneRun[y * WIDTH + x]) / (1 - 0.2),
          want = Math.exp(-tau);
        worst = Math.max(worst, Math.abs(got - want));
        compared++;
        if (depth > RANGE) past++;
        if (Math.abs(distance - 1000) <= 15) atV.push(got);
      }
    const contrast = atV.reduce((a, b) => a + b, 0) / atV.length;
    report.cases.paneUniform = { worst, compared, past, contrast };
    assert.ok(past > 5000 && atV.length > 20, `pane: ${past} pixels past range, ${atV.length} at 1 km`);
    assert.ok(worst <= 0.01, `a fogged transparent past range is off the integral by ${worst.toFixed(4)} at worst`);
    assert.ok(Math.abs(contrast - 0.02) <= 0.005, `Koschmieder: a transparent at V shows ${contrast} contrast, not 2%`);
    report.checks.push(
      `a transparent pane added with fog.add: ${compared} pixels (${past} past range) within 0.01 of exp(-optical depth); ${(contrast * 100).toFixed(2)}% contrast at the 1 km visibility`,
    );
  }

  // The sky lights the fog: a Sky and no `ambient` (and no `sky` option: the fog finds it). The engine's ambient of 1 is
  // far from the evening sky's light, so a fog lit by it, as before, could not match the sky.
  const skyRun = await page.evaluate(async () => {
    const t = window.farTest,
      { VolumetricFog } = await import('/packages/environment/dist/volumetric.js'),
      { Sky } = await import('/packages/sky/dist/index.js');
    t.fog?.dispose();
    t.sky = Sky.attach(t.engine, { hours: 19.2, timeScale: 0 });
    t.fog = VolumetricFog.attach(t.engine, {
      visibility: 300,
      heightFalloff: 0,
      range: 600,
      temporal: 0,
      depth: () => t.water.depthTexture,
    });
    t.fog.options.enabled = false;
    const clear = await t.frame();
    t.fog.options.enabled = true;
    return { clear, fogged: await t.frame() };
  });
  let horizonRow = -1;
  for (let y = 1; y < HEIGHT && horizonRow < 0; y++)
    if (optical(WIDTH >> 1, y, { density: 0, falloff: 0, height: 0 }).distance < Infinity) horizonRow = y;
  // The model of the fog's light at the far sea: past 4 km in 300 m visibility the sea's transmittance is
  // exp(-3.912 x 4,000 / 300) = 2e-23 (Koschmieder), so the sea shows the fog's light alone, and that light is by
  // definition the sky map's row 15, the sky evaluated at its texel centre 2.8125 degrees up (90 - 180 x 15.5 / 32) in
  // the view's azimuth. So the gap to the unfogged sky 0.3 to 0.7 degrees up is the sky's own brightening between
  // 2.8 and 0.5 degrees, read here from the unfogged frame at those elevations (the top of the view is 5 degrees up),
  // not a number fitted to the fogged frame.
  const elevation = (y) => {
    const d = ray(WIDTH >> 1, y);
    return (Math.asin(d[1] / Math.hypot(...d)) * 180) / Math.PI;
  };
  const mapRow = 90 - (180 * 15.5) / 32;
  let above = -1;
  for (let y = horizonRow - 1; y > 0 && above < 0; y--) if (elevation(y - 1) >= mapRow && elevation(y) < mapRow) above = y - 1;
  assert.ok(above > 0, `the sky ${mapRow} degrees up is in the view (row ${above})`);
  // Linear between the two rows that straddle 2.8125 degrees.
  const share = (mapRow - elevation(above + 1)) / (elevation(above) - elevation(above + 1));
  let skyWorst = 0,
    seamWorst = 0,
    modelWorst = 0,
    gapLeast = Infinity,
    gapMost = 0;
  for (let x = 4; x < WIDTH - 4; x += 8) {
    // The sky 2 to 4 rows above the horizon (0.3 to 0.7 degrees up), unfogged and fogged, and the far sea 6 to 8 rows
    // below it (over 4 km: fully fogged).
    const skyLight = [2, 3, 4].map((d) => skyRun.clear[(horizonRow - d) * WIDTH + x]),
      foggedSky = [2, 3, 4].map((d) => skyRun.fogged[(horizonRow - d) * WIDTH + x]),
      seaLight = [6, 7, 8].map((d) => skyRun.fogged[(horizonRow + d) * WIDTH + x]),
      mean = (a) => a.reduce((s, v) => s + v, 0) / a.length,
      mapLight = share * skyRun.clear[above * WIDTH + x] + (1 - share) * skyRun.clear[(above + 1) * WIDTH + x],
      gap = Math.abs(mapLight / mean(skyLight) - 1);
    seamWorst = Math.max(seamWorst, Math.abs(mean(seaLight) / mean(foggedSky) - 1));
    skyWorst = Math.max(skyWorst, Math.abs(mean(seaLight) / mean(skyLight) - 1));
    modelWorst = Math.max(modelWorst, Math.abs(mean(seaLight) / mapLight - 1));
    gapLeast = Math.min(gapLeast, gap);
    gapMost = Math.max(gapMost, gap);
  }
  report.cases.sky = { horizonRow, seam: seamWorst, worst: skyWorst, model: modelWorst, gap: [gapLeast, gapMost], mapRow: above };
  // No step where the sea meets the sky: the fully fogged far sea is the fogged sky just above it.
  assert.ok(seamWorst <= 0.01, `a fully fogged far sea differs from the fogged sky above it by ${(seamWorst * 100).toFixed(2)}%`);
  report.checks.push(`with a Sky, the fully fogged far sea is within ${(seamWorst * 100).toFixed(2)}% of the fogged sky above it`);
  // The far sea is the sky 2.8 degrees up, within 2%: 1% for the composite (the same bound as the seam above) and 1%
  // for the map's half floats and its linear blend across 5.6 degree texels in azimuth, where the screen samples each
  // pixel's own direction. The engine's ambient of 1 would be 55 times too bright.
  assert.ok(modelWorst <= 0.02, `a fully fogged far sea differs from the sky 2.8 degrees up by ${(modelWorst * 100).toFixed(2)}%`);
  report.checks.push(`with a Sky, the fully fogged far sea is within ${(modelWorst * 100).toFixed(2)}% of the unfogged sky 2.8 degrees up`);
  // So its gap to the horizon sky is the sky's own gradient, gap +- 2%, never more.
  assert.ok(
    skyWorst <= gapMost + 0.02,
    `a fully fogged far sea differs from the horizon sky by ${(skyWorst * 100).toFixed(1)}%, the sky's own gradient ${(gapMost * 100).toFixed(1)}%`,
  );
  report.checks.push(
    `with a Sky, the fully fogged far sea is within ${(skyWorst * 100).toFixed(1)}% of the horizon sky (the sky's own gradient from 0.5 to 2.8 degrees: ${(gapLeast * 100).toFixed(1)} to ${(gapMost * 100).toFixed(1)}%)`,
  );

  // With a Sky, the fully fogged pane past range takes the far air's light from the sky map as the sea does: the pane
  // over the far sea equals the fogged sea pixel it covers within 1%.
  const skyPane = await page.evaluate(async () => {
    const t = window.farTest;
    t.fog.add(t.pane);
    return t.frame();
  });
  let paneSky = 0;
  for (let x = 4; x < WIDTH - 4; x += 8)
    for (const d of [6, 7, 8]) {
      const i = (horizonRow + d) * WIDTH + x;
      paneSky = Math.max(paneSky, Math.abs(skyPane[i] / skyRun.fogged[i] - 1));
    }
  report.cases.paneSky = paneSky;
  assert.ok(paneSky <= 0.01, `with a Sky, a fully fogged transparent past range differs from the fogged sea under it by ${(paneSky * 100).toFixed(2)}%`);
  report.checks.push(`with a Sky, a fully fogged transparent past range is within ${(paneSky * 100).toFixed(2)}% of the fogged sea under it`);

  const validation = await page.evaluate(async () => (await window.farTest.engine.gpu.popErrorScope())?.message);
  assert.equal(validation, undefined, `validation error: ${validation}`);
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/fog-far-${compat ? 'compat' : 'native'}-${hardware.webgpu.vendor}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(report.checks.join('\n'));
  console.log(`fog far air: ${report.checks.length} checks passed${compat ? ' (WebGL2 compatibility layer)' : ''}`);
} finally {
  await page.evaluate(() => window.farTest?.engine.dispose());
  await closeAll({ browser });
}
