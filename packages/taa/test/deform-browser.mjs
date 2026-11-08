// Real-GPU check of TAA's velocity for shapes a shader moves (built packages; takes the GPU lock itself). A plane 40
// units wide, bright 1 px dots 4 px apart on dark with a white bar one unit wide, all fixed to the plane, slides 6 px a
// frame to the right by its vertex shader alone: the mesh's matrix never changes, so only the graph's or the shader's
// own motion can tell TAA where each pixel was. Without it every pixel reads its own history: the bar's white stays in
// the box the bright dots open and trails behind it. Five engines, each with TAA:
//   graph: NodeMaterial, `positionNode` = positionLocal + (uniform shift, 0, 0);
//   rigid: the same NodeMaterial, no positionNode, the mesh moved by its matrix (the reference TAA already gets right);
//   raw: RawShaderMaterial moving its vertices by `uniforms.shift`, with `velocityEntry` (last frame's shift beside it);
//   rawPlain: the same raw shader without `velocityEntry`, today's raw behaviour: depth and camera motion only.
// Trail: the mean red of a band 40 px wide behind the bar's left edge, minus the reference's, in sRGB levels.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-deform' });
const timer = setTimeout(() => {
  console.error('deform-browser: timed out after 180 s');
  process.exit(1);
}, 180_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-deform/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5378, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5378 });
const browser = await launchBrowser({ headless: true });
const WIDTH = 320,
  HEIGHT = 240,
  // Pixels per world unit on the plane z = 0, camera at z = 9 with the default 60 degree field of view.
  PIXELS = HEIGHT / 2 / Math.tan(Math.PI / 6) / 9,
  STEP = 6 / PIXELS,
  START = -3,
  FRAMES = 20;
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5378/packages/taa/test/upscale-browser.html');
  await page.evaluate(
    async ({ WIDTH, HEIGHT, PIXELS, START }) => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { TAA } = await import('/packages/taa/dist/index.js'),
        { createMesh } = await import('/packages/materials/dist/index.js'),
        { planeGeometry } = await import('/packages/geometry/dist/index.js'),
        { NodeMaterial, positionLocal, uniform, vec3, step, fract, abs, mix } = await import(
          '/packages/shader/dist/index.js'
        ),
        { RawShaders, RawShaderMaterial, RawMesh } = await import('/packages/shader/dist/raw.js');
      document.querySelector('canvas').remove();
      const k = (PIXELS / 4).toFixed(5);
      const engineOn = async (id) => {
        const canvas = Object.assign(document.createElement('canvas'), { id, width: WIDTH, height: HEIGHT });
        canvas.style.cssText = `display:inline-block;width:${WIDTH}px;height:${HEIGHT}px`;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 9], target: [0, 0, 0] },
        });
        engine.stop();
        engine.lighting.direction[3] = 0;
        engine.lighting.radiance[3] = 0;
        const gpuErrors = [];
        engine.gpu.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        return { engine, gpuErrors, taa: TAA.attach(engine) };
      };
      const graphRig = async (id, moved) => {
        const r = await engineOn(id),
          shift = uniform(0),
          x = positionLocal.x,
          y = positionLocal.y,
          dots = step(0.75, fract(x.mul(+k))).mul(step(0.75, fract(y.mul(+k)))).mul(0.88).add(0.02),
          bar = step(abs(x.sub(START)), 0.5),
          material = new NodeMaterial({
            color: [0, 0, 0],
            toneMapped: false,
            doubleSided: true,
            emissiveNode: vec3(mix(dots, 1, bar)),
            ...(moved ? { positionNode: positionLocal.add(vec3(shift, 0, 0)) } : {}),
          }),
          mesh = createMesh(r.engine, planeGeometry(40, 40), material);
        return { ...r, move: (u) => (moved ? (shift.value = u) : mesh.root.setPosition([u, 0, 0])) };
      };
      const vertexShader = `
struct Out { @builtin(position) clip:vec4f, @location(0) local:vec2f }
@vertex fn vertex(a:Attributes)->Out {
  return Out(camera.viewProjection*mesh.world*vec4f(a.position+vec3f(uniforms.shift,0,0),1), a.position.xy);
}
@vertex fn velocity(a:Attributes)->MargoVelocity {
  return margoVelocity(a.position+vec3f(uniforms.shift,0,0), a.position+vec3f(uniforms.shiftBefore,0,0));
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let dots=step(0.75,fract(i.local.x*${k}))*step(0.75,fract(i.local.y*${k}))*0.88+0.02;
  let bar=step(abs(i.local.x-(${START.toFixed(1)})),0.5);
  return margoEncode(vec4f(vec3f(mix(dots,1.0,bar)),1));
}`;
      const rawRig = async (id, opted) => {
        const r = await engineOn(id),
          raw = RawShaders.attach(r.engine),
          material = new RawShaderMaterial({
            vertexShader: opted ? vertexShader : vertexShader.replace(/@vertex fn velocity[^}]*\}\n/, ''),
            uniforms: { shift: { value: 0 }, shiftBefore: { value: 0 } },
            cull: 'none',
            ...(opted ? { velocityEntry: 'velocity' } : {}),
          });
        raw.add(
          new RawMesh({
            material,
            attributes: { position: { data: [-20, -20, 0, 20, -20, 0, 20, 20, 0, -20, 20, 0], type: 'vec3f' } },
            index: [0, 1, 2, 0, 2, 3],
          }),
        );
        r.taa.add(raw);
        await raw.ready();
        return {
          ...r,
          move(u) {
            material.uniforms.shiftBefore.value = material.uniforms.shift.value;
            material.uniforms.shift.value = u;
          },
        };
      };
      const rigs = {
        graph: await graphRig('graph', true),
        rigid: await graphRig('rigid', false),
        raw: await rawRig('raw', true),
        rawPlain: await rawRig('rawPlain', false),
      };
      window.t = {
        gpuErrors: () => Object.values(rigs).flatMap((r) => r.gpuErrors),
        async frames(n, from, step) {
          for (const r of Object.values(rigs))
            for (let i = 0; i < n; i++) {
              r.move(from + i * step);
              r.engine.render({ delta: 1 / 60 });
            }
          await Promise.all(Object.values(rigs).map((r) => r.engine.gpu.queue.onSubmittedWorkDone()));
        },
      };
    },
    { WIDTH, HEIGHT, PIXELS, START },
  );
  // Settle still (pipelines compile, history fills), then slide.
  await page.evaluate(() => window.t.frames(30, 0, 0));
  await page.evaluate(() => window.t.frames(30, 0, 0));
  await page.evaluate(({ STEP, FRAMES }) => window.t.frames(FRAMES, STEP, STEP), { STEP, FRAMES });
  const band = (image, from, to) => {
    let sum = 0,
      n = 0;
    for (let y = 96; y < 144; y++)
      for (let x = Math.round(from); x < Math.round(to); x++) {
        sum += image.data[(y * image.width + x) * 4];
        n++;
      }
    return sum / n;
  };
  // The bar's left edge in pixels after the last frame (shift FRAMES x STEP).
  const left = WIDTH / 2 + (START - 0.5 + FRAMES * STEP) * PIXELS,
    images = {};
  for (const id of ['graph', 'rigid', 'raw', 'rawPlain'])
    images[id] = await decodePNG(await page.locator('#' + id).screenshot());
  // Against the matrix-moved reference, which draws the same picture: the trail band's brightening, and the mean and
  // worst difference over the whole frame.
  const result = {};
  for (const id of ['graph', 'raw', 'rawPlain']) {
    let sum = 0,
      worst = 0;
    for (let i = 0; i < images[id].data.length; i += 4) {
      const d = Math.abs(images[id].data[i] - images.rigid.data[i]);
      sum += d;
      worst = Math.max(worst, d);
    }
    result[id] = {
      trail: band(images[id], left - 46, left - 6) - band(images.rigid, left - 46, left - 6),
      mean: sum / (images[id].data.length / 4),
      worst,
    };
  }
  console.log('against the matrix-moved plane, in sRGB levels', result);
  // M6 Mac mini, Metal: the raw shape without its own motion trails 24.7 levels; with it, and the graph, the frames
  // match the reference but for rounding (a level at most).
  assert.ok(result.rawPlain.trail > 15, `a raw shape without its own motion trails (${result.rawPlain.trail.toFixed(1)})`);
  for (const id of ['graph', 'raw']) {
    assert.ok(Math.abs(result[id].trail) < 2, `${id}: no trail (${result[id].trail.toFixed(1)})`);
    assert.ok(result[id].mean < 0.5, `${id}: the frame matches the matrix-moved one (mean ${result[id].mean.toFixed(3)})`);
  }
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('deforming velocity check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
