import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5194 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
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
  });
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
