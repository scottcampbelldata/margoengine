import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { fileURLToPath } from 'node:url';
import { windShader } from '../src/wind.ts';
import { poseShader } from '../src/pose.ts';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5194 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ({ windShader, poseShader }) => {
      const { EngineKernel, Geometry, PbrMaterial } = await import('/packages/core/dist/index.js');
      const { Scatter } = await import('/packages/scatter/dist/index.js');
      const { icosahedronGeometry, toGeometry } = await import('/packages/geometry/dist/index.js');
      const check = (ok, message) => {
          if (!ok) throw new Error(message);
        },
        canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 0, 3], target: [0, 0, 0], far: 100 },
        }),
        modules = [];
      const instrument = () => {
        modules.length = 0;
        const device = engine.gpu,
          create = device.createBuffer.bind(device),
          shader = device.createShaderModule.bind(device);
        // Test-only readback usage; production keeps all instance data on the GPU.
        device.createBuffer = (descriptor) =>
          create({
            ...descriptor,
            usage:
              descriptor.usage |
              (descriptor.usage & (GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT) ? GPUBufferUsage.COPY_SRC : 0),
          });
        device.createShaderModule = (descriptor) => {
          const module = shader(descriptor);
          modules.push(module);
          return module;
        };
        device.pushErrorScope('validation');
      };
      const read = async (buffer) => {
        const device = engine.gpu,
          target = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
          encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, target, 0, buffer.size);
        device.queue.submit([encoder.finish()]);
        await target.mapAsync(GPUMapMode.READ);
        const data = target.getMappedRange().slice(0);
        target.unmap();
        target.destroy();
        return data;
      };
      const frame = async () => {
        engine.render({ delta: 0, culling: false });
        await engine.gpu.queue.onSubmittedWorkDone();
      };
      instrument();
      engine.use({ name: 'lod-test:restore', setup() {}, onDeviceRestored: instrument });
      const summaries = [];
      for (const lit of [false, true]) {
        const material = lit ? new PbrMaterial({ color: [1, 1, 1], roughness: 1 }) : undefined;
        const geometries = [2, 1, 0].map((detail) => toGeometry(icosahedronGeometry(1, detail, true)));
        const effect = Scatter.attach(engine, geometries, {
          count: 1,
          area: [0.001, 0.001],
          scale: [1, 1],
          lod: [5, 10, 20],
          material,
        });
        await frame();
        const position = new Float32Array(await read(effect.instances[0])).slice(0, 3),
          steps = [];
        for (const [distance, expected] of [
          [3, [1, 0, 0]],
          [4, [1, 0, 0]],
          [4.5, [1, 1, 0]],
          [5.5, [1, 1, 0]],
          [6.1, [0, 1, 0]],
          [9.5, [0, 1, 1]],
          [10.5, [0, 1, 1]],
          [11.1, [0, 0, 1]],
          [21, [0, 0, 0]],
          [3, [1, 0, 0]],
        ]) {
          engine.camera.position = [position[0], position[1], position[2] + distance];
          engine.camera.target = Array.from(position);
          await frame();
          const command = new Uint32Array(await read(effect.commands)),
            counts = [command[1], command[6], command[11]];
          check(
            counts.every((count, i) => count === expected[i]),
            'Unexpected LOD counts at ' + distance + ': ' + counts,
          );
          const active = expected.flatMap((count, i) => (count ? [i] : []));
          for (const ring of active) {
            const instance = new Float32Array(await read(effect.instances[ring]));
            check(instance.slice(0, 6).every(Number.isFinite), 'Invalid placement or rotation');
            if (active.length === 2) {
              check(instance[7] === (ring === active[0] ? 1 : 2), 'Incorrect complementary fade mode');
              check(
                Math.abs(instance[6] - ((distance - (active[0] === 0 ? 5 : 10)) / 2 + 0.5)) < 1e-5,
                'Incorrect transition factor',
              );
            } else check(instance[7] === 0, 'Fade persisted outside its band');
          }
          steps.push({ distance, counts });
        }
        effect.dispose();
        summaries.push({ lit, steps });
      }
      const obstacleGeometry = toGeometry(icosahedronGeometry(1, 2, true)),
        exclusionSteps = [];
      for (const [center, scale, expected] of [
        [[0, 0, 0], 1, 0],
        [[2.6, 0, 0], 1, 0],
        [[3.6, 0, 0], 2, 0],
        [[3.6, 0, 0], 1, 1],
        [[2.8, 0, 2.8], 1, 1],
      ]) {
        engine.camera.position = [center[0], 0, center[2] + 5];
        engine.camera.target = center;
        const effect = Scatter.attach(engine, obstacleGeometry, {
          count: 1,
          area: [0.001, 0.001],
          center,
          scale: [scale, scale],
          exclusions: [[-2, -2, 2, 2]],
        });
        await frame();
        const command = new Uint32Array(await read(effect.commands));
        check(command[1] + command[6] + command[11] === expected, 'Scaled footprint crossed a building exclusion');
        exclusionSteps.push({ center, scale, expected });
        effect.dispose();
      }
      summaries.push({ exclusionSteps });
      engine.camera.position = [0, 0, 3];
      engine.camera.target = [0, 0, 0];
      const shared = toGeometry(icosahedronGeometry(1, 1, true)),
        same = Scatter.attach(engine, shared, { count: 1, area: [0.001, 0.001], scale: [1, 1], lod: [3, 10, 20] });
      await frame();
      const commands = new Uint32Array(await read(same.commands));
      check(commands[1] + commands[6] + commands[11] === 1, 'Identical geometries were duplicated');
      same.dispose();
      // edgeShrink 4 before the cull distance 20: full size up to 16, half at 18, a quarter at 19.
      const shrinking = Scatter.attach(engine, shared, {
        count: 1,
        area: [0.001, 0.001],
        scale: [1, 1],
        lod: [3, 10, 20],
        edgeShrink: 4,
      });
      await frame();
      const root = new Float32Array(await read(shrinking.instances[0])).slice(0, 3);
      for (const [distance, expected] of [
        [12, 1],
        [18, 0.5],
        [19, 0.25],
      ]) {
        engine.camera.position = [root[0], root[1], root[2] + distance];
        engine.camera.target = Array.from(root);
        await frame();
        const scale = new Float32Array(await read(shrinking.instances[2]))[3];
        check(Math.abs(scale - expected) < 1e-3, `Edge shrink ${scale} at ${distance}, expected ${expected}`);
      }
      shrinking.dispose();
      // Every blades variant (lit and unlit, with and without the LOD fade) must compile; validate() checks below.
      for (const material of [undefined, new PbrMaterial({ color: [0.2, 0.3, 0.1], doubleSided: true })])
        for (const lodFade of [2, 0]) {
          const blades = Scatter.attach(
            engine,
            [2, 1, 0].map((detail) => toGeometry(icosahedronGeometry(1, detail, true))),
            {
              count: 16,
              area: [4, 4],
              lodFade,
              material,
              blades: { rootShade: 0.6, widen: 1 },
            },
          );
          await frame();
          blades.dispose();
        }
      engine.camera.position = [0, 0, 3];
      engine.camera.target = [0, 0, 0];
      // Bilinear ground: a 4x4 r32float ramp rising 0.5 per texel along X, one texel per world unit, so texel centres sit
      // at world x = -1.5..1.5 and the interpolated height at x is 0.5 * clamp(x + 1.5, 0, 3). A nearest read is off by
      // up to 0.25.
      const ramp = engine.gpu.createTexture({
        size: [4, 4],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      engine.gpu.queue.writeTexture(
        { texture: ramp },
        Float32Array.from({ length: 16 }, (_, i) => 0.5 * (i % 4)),
        { bytesPerRow: 16 },
        [4, 4],
      );
      engine.camera.position = [0, 8, 8];
      engine.camera.target = [0, 0, 0];
      const groundSteps = [];
      // With sink 0.2 the root drops 0.2 * (1 + tan(slope)): tan is 0.5 on the ramp and 0 on the clamped flats beyond it.
      // The packed ground normal is (-0.5, 1, 0) normalized on the ramp and +Y on the flats.
      for (const fit of [{}, { alignToGround: 1, sink: 0.2 }])
        for (const seed of [1, 2, 3, 4, 5, 6]) {
          const ground = Scatter.attach(engine, toGeometry(icosahedronGeometry(0.1, 0, true)), {
            count: 1,
            area: [4, 4],
            scale: [1, 1],
            seed,
            heightmap: () => ramp,
            ...fit,
          });
          await frame();
          const [x, y, , , , packed] = new Float32Array(await read(ground.instances[0])),
            slope = x + 1.5 >= 0 && x + 1.5 < 3 ? 0.5 : 0,
            expected = 0.5 * Math.min(3, Math.max(0, x + 1.5)) - (fit.sink ?? 0) * (1 + slope),
            qz = Math.floor(packed / 4096),
            normal = [
              ((packed - qz * 4096) / 2047.5 - 1) * Math.hypot(1, slope),
              (qz / 2047.5 - 1) * Math.hypot(1, slope),
            ];
          check(Math.abs(y - expected) < 1e-4, `Ground height ${y} at x ${x}, expected ${expected}`);
          check(Math.abs(normal[0] + slope) < 2e-3 && Math.abs(normal[1]) < 2e-3, `Packed ground normal ${normal}`);
          groundSteps.push({ x, y, ...fit });
          ground.dispose();
        }
      ramp.destroy();
      // scatterTurn on the GPU: +Y lands on up, lengths and angles survive, up = +Y is the plain yaw, and the packed
      // ground normal decodes to within 12-bit precision.
      const probe = engine.gpu.createComputePipeline({
          layout: 'auto',
          compute: {
            module: engine.gpu.createShaderModule({
              code:
                windShader +
                poseShader +
                `
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=f32(id.x);let c=cos(i*0.7);let s=sin(i*0.7);let a=vec3f(0.3,-1.2,0.7);let b=vec3f(-0.5,0.4,1.1);
 let up=normalize(vec3f(sin(i*1.3)*0.8,1.0,cos(i*0.9)*0.8));let ta=scatterTurn(a,c,s,up);let tb=scatterTurn(b,c,s,up);
 let q=round((up.xz*0.5+0.5)*4095.0);
 result[id.x*3u]=vec4f(scatterTurn(vec3f(0,1,0),c,s,up)-up,length(scatterGround(q.x+q.y*4096.0)-up));
 result[id.x*3u+1u]=vec4f(length(ta)-length(a),dot(ta,tb)-dot(a,b),0,0);
 result[id.x*3u+2u]=vec4f(scatterTurn(a,c,s,vec3f(0,1,0))-vec3f(c*a.x+s*a.z,a.y,-s*a.x+c*a.z),0);
}`,
            }),
            entryPoint: 'main',
          },
        }),
        probeResult = engine.gpu.createBuffer({ size: 64 * 3 * 16, usage: GPUBufferUsage.STORAGE }),
        encoder = engine.gpu.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(probe);
      pass.setBindGroup(
        0,
        engine.gpu.createBindGroup({
          layout: probe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: probeResult } }],
        }),
      );
      pass.dispatchWorkgroups(1);
      pass.end();
      engine.gpu.queue.submit([encoder.finish()]);
      const turns = new Float32Array(await read(probeResult));
      check(
        turns.every((v, i) => Math.abs(v) < (i % 12 === 3 ? 2e-3 : 2e-4)),
        'scatterTurn is not a rotation taking +Y to the ground normal',
      );
      probeResult.destroy();
      summaries.push({ groundSteps });
      engine.camera.position = [0, 0, 3];
      engine.camera.target = [0, 0, 0];
      const validate = async () => {
        const compilation = (await Promise.all(modules.map((module) => module.getCompilationInfo()))).flatMap((info) =>
          info.messages.filter((message) => message.type === 'error'),
        );
        const validation = await engine.gpu.popErrorScope();
        check(!validation && !compilation.length, validation?.message ?? JSON.stringify(compilation));
      };
      await validate();
      const quad = (normal) =>
        new Geometry(
          [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
          Array.from({ length: 4 }, () => [0, normal, 0]).flat(),
          [0, 1, 2, 0, 2, 3],
        );
      let fixture;
      window.lodCheck = {
        async makeMask(lit) {
          engine.gpu.pushErrorScope('validation');
          const near = quad(1),
            middle = quad(-1);
          fixture = Scatter.attach(engine, [near, middle, middle], {
            count: 1,
            area: [0.001, 0.001],
            scale: [1, 1],
            lod: [5, 10, 20],
            exclusions: [[50, 50, 60, 60]],
            color: [1, 1, 1],
            material: lit ? new PbrMaterial({ color: [1, 1, 1], roughness: 1 }) : undefined,
          });
          engine.camera.position = [0, 0, 3];
          engine.camera.target = [0, 0, 0];
          await frame();
          const p = new Float32Array(await read(fixture.instances[0])).slice(0, 3);
          engine.camera.position = [p[0], p[1], p[2] + 5];
          engine.camera.target = Array.from(p);
        },
        async render(cutoff) {
          fixture.values[32] = cutoff;
          await frame();
        },
        async dispose() {
          await validate();
          fixture.dispose();
        },
        async restore() {
          await this.makeMask(true);
          await validate();
          await engine.rebootDevice();
          await frame();
          const command = new Uint32Array(await read(fixture.commands));
          check(command[1] === 1 && command[6] === 1, 'Fade was not restored');
          const exclusions = new Float32Array(await read(fixture.exclusionBuffer));
          check(exclusions[0] === 50 && exclusions[3] === 60, 'Occupied footprints were not restored');
          await this.dispose();
          engine.dispose();
        },
      };
      return summaries;
    },
    { windShader, poseShader },
  );
  for (const lit of [false, true]) {
    await page.evaluate((lit) => window.lodCheck.makeMask(lit), lit);
    const frames = [];
    for (const cutoff of [8, 2, 5]) {
      await page.evaluate((cutoff) => window.lodCheck.render(cutoff), cutoff);
      frames.push(await decodePNG(await page.locator('canvas').screenshot()));
    }
    const [near, middle, transition] = frames.map((frame) => frame.data);
    let outgoing = 0,
      incoming = 0;
    for (let pixel = 0; pixel < near.length; pixel += 4) {
      if (near.slice(pixel, pixel + 4).every((value, k) => value === middle[pixel + k])) continue;
      const a = near.slice(pixel, pixel + 4).every((value, k) => value === transition[pixel + k]),
        b = middle.slice(pixel, pixel + 4).every((value, k) => value === transition[pixel + k]);
      assert.ok(a !== b, 'Transition must match exactly one LOD with no double coverage or holes');
      if (a) outgoing++;
      else incoming++;
    }
    assert.ok(outgoing > 100 && incoming > 100);
    assert.ok(Math.abs(outgoing - incoming) < (outgoing + incoming) * 0.1);
    result.push({ lit, outgoing, incoming });
    await page.evaluate(() => window.lodCheck.dispose());
  }
  await page.evaluate(() => window.lodCheck.restore());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ hardware, checks: result }, null, 2));
} finally {
  await browser.close();
}
