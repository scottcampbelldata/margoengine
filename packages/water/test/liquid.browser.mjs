import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

// ParticleLiquid against independent arithmetic: the GPU filter against a float64 port of Truong and Yuksel's
// equations on the same raw depth, a 20,000-particle shell against the analytic sphere, an exact chord, refraction
// and Fresnel of one sphere against ray optics, a depth gap left unfiltered, and steady-frame work counts at 1,000,000
// particles in 1920 x 1080.
const reference = await readFile('packages/water/test/liquid-reference.js', 'utf8');
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async (referenceSource) => {
    const { narrowRangeFilter } = await import(
      URL.createObjectURL(new Blob([referenceSource], { type: 'text/javascript' }))
    );
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { ParticleLiquid } = await import('/packages/water/dist/liquid.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const W = 256,
      H = 192,
      tanHalf = Math.tan(Math.PI / 6);
    const make = async (width, height) => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${width}px;height:${height}px`;
      document.body.replaceChildren(canvas);
      return EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 4,
        exactSize: [width, height],
        camera: { position: [0, 0, 4], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
      });
    };
    const engine = await make(W, H);
    const d = engine.gpu;
    d.pushErrorScope('validation');
    engine.lighting.direction.set([0.3, 1, 0.4, 0]);
    // A stage that replaces the scene with a coordinate pattern (x / W, y / H, 0.5) at pixel centres.
    const pattern = () => {
      let pipeline;
      return {
        name: 'pattern',
        setup() {},
        joinStack: () => ({
          kind: 'hdr',
          render(c, input, output) {
            pipeline ??= d.createRenderPipeline({
              layout: 'auto',
              vertex: {
                module: d.createShaderModule({
                  code: `@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@fragment fn f(@builtin(position) at:vec4f)->@location(0) vec4f {return vec4f(at.x/${W}.0,at.y/${H}.0,0.5,1);}`,
                }),
                entryPoint: 'v',
              },
              fragment: {
                module: d.createShaderModule({
                  code: `@fragment fn f(@builtin(position) at:vec4f)->@location(0) vec4f {return vec4f(at.x/${W}.0,at.y/${H}.0,0.5,1);}`,
                }),
                entryPoint: 'f',
                targets: [{ format: output.format }],
              },
            });
            const pass = c.encoder.beginRenderPass({
              colorAttachments: [{ view: output.view, loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(pipeline);
            pass.draw(3);
            pass.end();
          },
        }),
      };
    };
    let recordPipeline;
    const recorder = () => {
      const r = { buffer: undefined };
      r.plugin = {
        name: 'recorder',
        setup() {},
        joinStack: () => ({
          kind: 'hdr',
          render(c, input) {
            recordPipeline ??= d.createComputePipeline({
              layout: 'auto',
              compute: {
                module: d.createShaderModule({
                  code: `@group(0) @binding(0) var t:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(t);if(any(id.xy>=size)){return;}out[id.y*size.x+id.x]=textureLoad(t,vec2i(id.xy),0);
}`,
                }),
                entryPoint: 'main',
              },
            });
            r.buffer ??= d.createBuffer({
              size: c.width * c.height * 16,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            });
            const pass = c.encoder.beginComputePass();
            pass.setPipeline(recordPipeline);
            pass.setBindGroup(
              0,
              d.createBindGroup({
                layout: recordPipeline.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: input },
                  { binding: 1, resource: { buffer: r.buffer } },
                ],
              }),
            );
            pass.dispatchWorkgroups(Math.ceil(c.width / 8), Math.ceil(c.height / 8));
            pass.end();
            return input;
          },
        }),
      };
      return r;
    };
    const readBuffer = async (buffer) => {
      const staging = d.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e = d.createCommandEncoder();
      e.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      return data;
    };
    const f16 = (h) => {
      const s = h & 0x8000 ? -1 : 1,
        e = (h >> 10) & 31,
        m = h & 1023;
      return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
    };
    const readTexture = async (texture, bytes) => {
      const row = Math.ceil((texture.width * bytes) / 256) * 256;
      const buffer = d.createBuffer({
        size: row * texture.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const e = d.createCommandEncoder();
      e.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [texture.width, texture.height]);
      d.queue.submit([e.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = buffer.getMappedRange();
      const out = new Float64Array(texture.width * texture.height);
      for (let y = 0; y < texture.height; y++) {
        const line =
          bytes === 4 ? new Float32Array(raw, y * row, texture.width) : new Uint16Array(raw, y * row, texture.width);
        for (let x = 0; x < texture.width; x++) out[y * texture.width + x] = bytes === 4 ? line[x] : f16(line[x]);
      }
      buffer.destroy();
      return out;
    };
    // Unit view ray through a pixel centre for the camera above (looking down -z, up +y, aspect W / H).
    const ray = (x, y) => {
      const v = [((2 * (x + 0.5)) / W - 1) * tanHalf * (W / H), (1 - (2 * (y + 0.5)) / H) * tanHalf, -1];
      const l = Math.hypot(...v);
      return v.map((c) => c / l);
    };
    const eye = [0, 0, 4];
    const sphere = (dir, center, r) => {
      const oc = center.map((c, i) => c - eye[i]);
      const b = oc[0] * dir[0] + oc[1] * dir[1] + oc[2] * dir[2];
      const m = oc.map((c, i) => c - dir[i] * b);
      const h = r * r - (m[0] ** 2 + m[1] ** 2 + m[2] ** 2);
      return h < 0 ? undefined : [b - Math.sqrt(h), b + Math.sqrt(h)];
    };
    const project = (p) => {
      const m = engine.camera.matrix;
      const q = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
      return [((q[0] / q[3]) * 0.5 + 0.5) * W, ((-q[1] / q[3]) * 0.5 + 0.5) * H];
    };
    const out = {};

    // 1. Shell of 20,000 particles (Fibonacci sphere, radius 1, particle radius 0.05).
    const N = 20000,
      shell = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N,
        r = Math.sqrt(1 - y * y),
        a = i * Math.PI * (3 - Math.sqrt(5));
      shell.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    }
    let liquid = new ParticleLiquid({ particles: { positions: shell } });
    let stack = PostStack.attach(engine, [liquid]);
    engine.render({ delta: 0 });
    const raw = await readTexture(liquid.targets[0], 4);
    const filtered = await readTexture(liquid.targets[1], 4);
    const oracle = narrowRangeFilter(raw, W, H, {
      sigma: 0.035,
      delta: 0.5,
      mu: 0.05,
      maxRadius: 32,
      tanHalfFov: tanHalf,
    });
    let covered = 0,
      close = 0,
      worstOracle = 0,
      shellError = 0,
      shellSigned = 0,
      rawError = 0,
      shellPixels = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (raw[i] > 0 !== filtered[i] > 0) worstOracle = Infinity;
        if (!(raw[i] > 0)) continue;
        covered++;
        const e = Math.abs(filtered[i] - oracle[i]) / oracle[i];
        if (e < 1e-4) close++;
        worstOracle = Math.max(worstOracle, e);
        const dir = ray(x, y),
          t = sphere(dir, [0, 0, 0], 1.05),
          inner = sphere(dir, [0, 0, 0], 0.8 * 1.05);
        if (t && inner) {
          shellError += Math.abs(filtered[i] - t[0] * -dir[2]);
          shellSigned += filtered[i] - t[0] * -dir[2];
          rawError += Math.abs(raw[i] - t[0] * -dir[2]);
          shellPixels++;
        }
      }
    out.shell = {
      covered,
      closeShare: close / covered,
      worstOracle,
      meanError: shellError / shellPixels,
      signedError: shellSigned / shellPixels,
      rawError: rawError / shellPixels,
      pixels: shellPixels,
    };
    const first = { ...liquid.frameStats };
    engine.render({ delta: 0 });
    out.shellStats = { first, steady: { ...liquid.frameStats } };
    stack.dispose();
    liquid.dispose();

    // 2. One sphere of radius 1: exact chord, refraction offset and Fresnel against ray optics.
    const one = new Float32Array([0, 0, 0]);
    const options = {
      particles: { positions: one },
      radius: 1,
      smoothing: 0.0001,
      absorption: [0, 0, 0],
      skyHorizon: [0, 0, 0],
      skyZenith: [0, 0, 0],
    };
    liquid = new ParticleLiquid(options);
    const rec = recorder();
    stack = PostStack.attach(engine, [pattern(), liquid, rec.plugin]);
    engine.render({ delta: 0 });
    const thick = await readTexture(liquid.targets[3], 2);
    const color = await readBuffer(rec.buffer);
    const cx = W / 2,
      cy = H / 2;
    const centerRay = ray(cx, cy),
      chord = sphere(centerRay, [0, 0, 0], 1);
    out.chord = { measured: thick[cy * W + cx], expected: chord[1] - chord[0] };
    let shiftError = 0,
      shiftSamples = 0,
      inward = 0,
      fresnelError = 0;
    const ior = 1.333;
    for (let y = 0; y < H; y += 3)
      for (let x = 0; x < W; x += 3) {
        const dir = ray(x, y),
          t = sphere(dir, [0, 0, 0], 1);
        if (!t || !sphere(dir, [0, 0, 0], 0.6)) continue;
        const c = dir.map((v, i) => eye[i] + v * t[0]),
          n = c,
          cos = -(dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2]),
          eta = 1 / ior,
          k = 1 - eta * eta * (1 - cos * cos),
          bent = dir.map((v, i) => eta * v + (eta * cos - Math.sqrt(k)) * n[i]),
          chordLength = t[1] - t[0],
          exit = c.map((v, i) => v + bent[i] * chordLength),
          [ex, ey] = project(exit);
        const i = (y * W + x) * 4,
          b = color[i + 2],
          mx = (color[i] / b) * 0.5 * W,
          my = (color[i + 1] / b) * 0.5 * H;
        // The composite reads the scene texel the exit point falls in, so compare texel indices.
        shiftError = Math.max(
          shiftError,
          Math.abs(Math.floor(mx) - Math.floor(ex)),
          Math.abs(Math.floor(my) - Math.floor(ey)),
        );
        const toCenter = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (toCenter > 8 && Math.hypot(mx - cx, my - cy) < toCenter) inward++;
        shiftSamples += toCenter > 8 ? 1 : 0;
        const s = Math.sqrt(1 - (1 - cos * cos) / (ior * ior)),
          rs = (cos - ior * s) / (cos + ior * s),
          rp = (ior * cos - s) / (ior * cos + s),
          F = 0.5 * (rs * rs + rp * rp);
        fresnelError = Math.max(fresnelError, Math.abs(1 - 2 * b - F));
      }
    out.refraction = { shiftError, inward, shiftSamples, fresnelError };
    stack.dispose();
    liquid.dispose();

    // 3a. Two spheres of radius 0.2 side by side with a 0.4 (two-radius) gap: the gap stays empty.
    const pair = new Float32Array([-0.4, 0, 0, 0.4, 0, 0]);
    liquid = new ParticleLiquid({ particles: { positions: pair }, radius: 0.2 });
    stack = PostStack.attach(engine, [liquid]);
    engine.render({ delta: 0 });
    const filteredPair = await readTexture(liquid.targets[1], 4);
    const [gx0] = project([-0.18, 0, 0.2]),
      [gx1] = project([0.18, 0, 0.2]);
    let gapFilled = 0;
    for (let y = 0; y < H; y++) for (let x = Math.ceil(gx0); x < gx1; x++) if (filteredPair[y * W + x] > 0) gapFilled++;
    stack.dispose();
    liquid.dispose();
    // 3b. A drop 2 m in front of a large sphere: around the drop's silhouette the background is never pulled toward
    // the camera (bias correction), and the drop's own depth moves less than mu per filter pass.
    const back = [];
    for (let j = -20; j <= 20; j++) for (let i = -20; i <= 20; i++) back.push(i * 0.1, j * 0.1, -1);
    for (const [x, y, z] of [
      [0, 0, 0],
      [0.08, 0, 0],
      [-0.08, 0, 0],
      [0, 0.08, 0],
      [0, -0.08, 0],
      [0, 0, 0.08],
    ])
      back.push(0.3 + x, 0.1 + y, 2 + z);
    liquid = new ParticleLiquid({ particles: { positions: new Float32Array(back), count: 41 * 41 }, radius: 0.1 });
    stack = PostStack.attach(engine, [liquid]);
    engine.render({ delta: 0 });
    const wallAlone = await readTexture(liquid.targets[1], 4);
    liquid.update({ positions: new Float32Array(back) });
    engine.render({ delta: 0 });
    const rawLayer = await readTexture(liquid.targets[0], 4),
      filteredLayer = await readTexture(liquid.targets[1], 4);
    const front = project([0.3, 0.1, 2]);
    let pulledForward = 0,
      backgroundShift = 0,
      backgroundNear = 0,
      dropOut = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!(rawLayer[i] > 0)) continue;
        const background = rawLayer[i] > 3;
        if (background && Math.hypot(x - front[0], y - front[1]) < 60) {
          backgroundNear++;
          // The same wall filtered without the drop: dropping the pairs that touch the drop may move the result by
          // a fraction of the sphere bumps, never toward the drop's depth.
          const shift = filteredLayer[i] - wallAlone[i];
          backgroundShift = Math.max(backgroundShift, Math.abs(shift));
          if (shift < -0.02) pulledForward++;
        }
        if (!background && (filteredLayer[i] < rawLayer[i] - 0.3 || filteredLayer[i] > rawLayer[i] + 0.3 + 1e-4))
          dropOut++;
      }
    out.gap = { gapFilled, gapColumns: gx1 - gx0, pulledForward, backgroundShift, backgroundNear, dropOut };
    stack.dispose();
    liquid.dispose();
    const validation = await d.popErrorScope();
    out.validation = validation?.message;
    engine.dispose?.();

    // 4. Capacity: 1,000,000 particles in a 2 m box at 1920 x 1080, steady-frame work counts.
    const big = await make(1920, 1080);
    big.gpu.pushErrorScope('validation');
    const M = 1000000,
      cloud = new Float32Array(M * 3);
    let seed = 1;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let i = 0; i < cloud.length; i++) cloud[i] = rand();
    const heavy = new ParticleLiquid({ particles: { positions: cloud }, radius: 0.01 });
    const heavyStack = PostStack.attach(big, [heavy]);
    big.render({ delta: 0 });
    const heavyFirst = { ...heavy.frameStats };
    big.render({ delta: 0 });
    const heavySteady = { ...heavy.frameStats };
    const heavyDepth = await (async () => {
      const t = heavy.targets[1];
      return t.width * t.height;
    })();
    await big.gpu.queue.onSubmittedWorkDone();
    out.capacity = {
      first: heavyFirst,
      steady: heavySteady,
      pixels: heavyDepth,
      validation: (await big.gpu.popErrorScope())?.message,
    };
    heavyStack.dispose();
    heavy.dispose();
    return out;
  }, reference);
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  // Filter: the GPU matches the float64 oracle on its own raw depth, and coverage is unchanged by filtering.
  assert.ok(result.shell.covered > 5000, `shell coverage ${result.shell.covered}`);
  assert.ok(result.shell.worstOracle < Infinity, 'filtering changed coverage');
  assert.ok(result.shell.closeShare > 0.995, `GPU vs oracle within 1e-4: ${result.shell.closeShare}`);
  // Shell: filtered depth against the analytic outer sphere, mean error under 1% of the radius.
  assert.ok(result.shell.meanError < 0.01, `shell mean depth error ${result.shell.meanError}`);
  assert.deepEqual(result.shellStats.steady, { passes: 6, draws: 6, bytes: 320, particles: 20000, groups: 0, whitewater: 0 });
  assert.equal(result.shellStats.first.bytes, 320 + 240000);
  // Thickness through the centre equals the exact chord (r16float: 11 significant bits).
  assert.ok(
    Math.abs(result.chord.measured - result.chord.expected) / result.chord.expected < 0.002,
    JSON.stringify(result.chord),
  );
  assert.ok(result.refraction.shiftError <= 1, `refraction texel error ${result.refraction.shiftError}`);
  assert.equal(result.refraction.inward, result.refraction.shiftSamples, 'refraction bends toward the centre');
  assert.ok(result.refraction.shiftSamples > 50);
  assert.ok(result.refraction.fresnelError < 0.004, `Fresnel ${result.refraction.fresnelError}`);
  assert.equal(result.gap.gapFilled, 0);
  assert.ok(result.gap.gapColumns > 4);
  assert.ok(result.gap.backgroundNear > 500, `background near the drop ${result.gap.backgroundNear}`);
  assert.equal(result.gap.pulledForward, 0, 'background pulled toward the drop');
  assert.equal(result.gap.dropOut, 0, 'drop depth moved more than 3 mu');
  assert.equal(result.capacity.validation, undefined);
  assert.deepEqual(result.capacity.steady, { passes: 6, draws: 6, bytes: 320, particles: 1000000, groups: 0, whitewater: 0 });
  assert.equal(result.capacity.first.bytes, 320 + 12000000);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-liquid-${compatRun() ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
