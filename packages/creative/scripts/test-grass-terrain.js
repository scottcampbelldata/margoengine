import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const browser = await openBrowser({ port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/extension.js');
    const { createTerrainGrass } = await import('/packages/creative/dist/grass-terrain.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px';
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', samples: 1 });
    engine.scene.background = '#000000';
    engine.camera.position = [0, 9, 12];
    engine.camera.target = [0, 1, 0];
    const errors = [];
    let device = engine.gpu;
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const makeMap = (data) => {
      const t = device.createTexture({
        size: [2, 2],
        format: 'r32float',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      device.queue.writeTexture({ texture: t }, new Float32Array(data), { bytesPerRow: 8 }, [2, 2]);
      return t;
    };
    let height = makeMap([0, 2, 0, 2]),
      density = makeMap([0, 1, 0, 1]),
      field;
    const options = {
      count: 1024,
      area: [12, 12],
      bounds: [-6, -6, 6, 6],
      heightmap: () => height,
      densityMap: () => density,
      wind: [1, 0, 0],
      color: [1, 1, 1],
      lod: [20, 30, 50],
      scale: [1, 1],
      interaction: { size: 32, resolution: 32, recover: 0.1 },
    };
    const make = async (color) => {
      field?.dispose();
      field = await createTerrainGrass(engine, {
        ...options,
        colorMap: { width: 1, height: 1, data: new Float32Array([...color, 1]) },
      });
    };
    const frame = async (delta = 0) => {
      await waitForPipelines(async () => {
        engine.render({ delta });
        await device.queue.onSubmittedWorkDone();
      });
    };
    const read = async (buffer) => {
      let source=buffer,copy;
      if(!(buffer.usage&GPUBufferUsage.COPY_SRC)){
        copy=device.createBuffer({size:buffer.size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
        const module=device.createShaderModule({code:'@group(0) @binding(0) var<storage,read> source:array<u32>; @group(0) @binding(1) var<storage,read_write> copied:array<u32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&source)){copied[id.x]=source[id.x];}}'});
        const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}},{binding:1,resource:{buffer:copy}}]}));pass.dispatchWorkgroups(Math.ceil(buffer.size/256));pass.end();device.queue.submit([encoder.finish()]);source=copy;
      }
      const b = device.createBuffer({ size: buffer.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        e = device.createCommandEncoder();
      e.copyBufferToBuffer(source, 0, b, 0, buffer.size);
      device.queue.submit([e.finish()]);
      await b.mapAsync(GPUMapMode.READ);
      const a = b.getMappedRange().slice(0);
      b.unmap();
      b.destroy();copy?.destroy();
      return a;
    };
    const image = async () => {
      engine.render();
      const bitmap = await createImageBitmap(canvas),
        off = new OffscreenCanvas(canvas.width, canvas.height),
        ctx = off.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0,
        blue = 0,
        hash = 0;
      for (let i = 0; i < a.length; i += 4) {
        red += a[i];
        blue += a[i + 2];
        hash = (Math.imul(hash, 31) + a[i] + a[i + 1] * 256 + a[i + 2] * 65536) | 0;
      }
      return { red, blue, hash };
    };
    try {
      await make([1, 0, 0]);
      await frame();
      const red = await image();
      const commands = new Uint32Array(await read(field.commands));
      let roots = 0,
        worst = 0;
      for (let ring = 0; ring < 3; ring++) {
        const data = new Float32Array(await read(field.instances[ring]));
        for (let i = 0; i < commands[ring * 5 + 1]; i++) {
          const x = data[i * 8],
            y = data[i * 8 + 1];
          if (x < 0) throw new Error(`density leaked at ${x}`);
          const want = Math.min(1, Math.max(0, (x + 3) / 6)) * 2;
          worst = Math.max(worst, Math.abs(y - want));
          roots++;
        }
      }
      field.setInteractors([{ position: [2, 1.7, 0], radius: 3 }]);
      await frame();
      const bent = await image();
      const push = new Float32Array(await read(field.field));
      const pressed = push.slice(6).some((x) => x !== 0);
      field.setInteractors([]);
      await frame(1);
      const recovered = await image();
      await make([0, 0, 1]);
      await frame();
      const blue = await image();
      const before = await image();
      await engine.rebootDevice();
      device = engine.gpu;
      height.destroy();
      density.destroy();
      height = makeMap([0, 2, 0, 2]);
      density = makeMap([0, 1, 0, 1]);
      await frame();
      const after = await image();
      return { roots, worst, red, blue, bent, recovered, pressed, before, after, errors };
    } finally {
      field?.dispose();
      height.destroy();
      density.destroy();
      engine.dispose();
    }
  });
  console.log(JSON.stringify(result));
  assert.ok(result.roots > 100);
  assert.ok(result.worst < 1e-5);
  assert.ok(result.red.red > result.red.blue + 100);
  assert.ok(result.blue.blue > result.blue.red + 100);
  assert.ok(result.pressed);
  assert.notEqual(result.red.hash, result.bent.hash);
  assert.equal(result.red.hash, result.recovered.hash);
  assert.deepEqual(result.before, result.after);
  assert.deepEqual(result.errors, []);

} finally {
  await browser.close();
}
