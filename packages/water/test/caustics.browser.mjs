import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Water } = await import('/packages/water/dist/index.js');
    const { FFTOcean } = await import('/packages/water/dist/fft.js');
    const { Caustics } = await import('/packages/water/dist/caustics.js');
    const { PostStack } = await import('/packages/post/dist/stack.js');
    const { invertMatrixStable } = await import('/packages/math/dist/mat4.js');
    const { CameraProjection } = await import('/packages/cameras/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:192px;height:128px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [0, 8, 0], target: [0, -6, 0], near: 0.1, far: 100 },
    });
    const projection = CameraProjection.attach(engine, { mode: 'orthographic', height: 16, up: [0, 0, -1] });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    engine.lighting.direction.set([0, 1, 0, 1]);
    engine.lighting.radiance.set([1, 1, 1, 0.2]);
    engine
      .createMesh()
      .setGeometry(box(60, 0.2, 60))
      .setMaterial(new PbrMaterial({ color: '#a0a0a0', roughness: 1 }))
      .setPosition([0, -6, 0]);
    const raised = engine
      .createMesh()
      .setGeometry(box(3, 3, 3))
      .setMaterial(new PbrMaterial({ color: '#b07050', roughness: 1 }))
      .setPosition([0, -4.4, -3]);
    const water = Water.attach(engine, {
      size: [80, 80],
      segments: 64,
      waves: [{ direction: [1, 0], amplitude: 0.1, wavelength: 12 }],
    });
    water.setWaveHeight(0);
    const options = {
      surface: water,
      resolution: 64,
      layers: 4,
      size: 60,
      heightRange: [-12, 0],
      absorption: [0, 0, 0],
    };
    const caustics = new Caustics(options);
    const stack = PostStack.attach(engine, [caustics]);
    const events = [];
    let capturedMatrix, afterCapture;
    const illuminate = caustics.illuminate.bind(caustics);
    caustics.illuminate = (c) => {
      const changed = illuminate(c);
      capturedMatrix = Array.from(c.camera.matrix);
      events.push({ sourceTime: water.values[20], authoredTime: water.time, mapsReady: caustics.maps.length === 3 });
      const target = caustics.host.target;
      if (afterCapture && (afterCapture.width !== c.width || afterCapture.height !== c.height)) {
        afterCapture.destroy();
        afterCapture = undefined;
      }
      afterCapture ??= d.createTexture({ size: [c.width, c.height], format: target.resolvedColor.format, usage: 6 });
      target.resolve(c.encoder);
      c.encoder.copyTextureToTexture({ texture: target.resolvedColor }, { texture: afterCapture }, [c.width, c.height]);
      return changed;
    };
    const read = async (texture, layer = 0) => {
      const count = texture.width * texture.height;
      const buffer = d.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const staging = d.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const array = texture.depthOrArrayLayers > 1,
        isDepth = texture.format.startsWith('depth');
      const code = `@group(0) @binding(0) var t:${isDepth ? 'texture_depth_2d' : array ? 'texture_2d_array<f32>' : 'texture_2d<f32>'};
@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
 let size=textureDimensions(t);if(any(id.xy>=size)){return;}
 out[id.y*size.x+id.x]=${isDepth ? 'vec4f(' : ''}textureLoad(t,vec2i(id.xy),${array ? `${layer},` : ''}0)${isDepth ? ')' : ''};
}`;
      const pipeline = d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code }), entryPoint: 'main' },
      });
      const bind = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ dimension: array ? '2d-array' : '2d' }) },
          { binding: 1, resource: { buffer } },
        ],
      });
      const e = d.createCommandEncoder(),
        p = e.beginComputePass();
      p.setPipeline(pipeline);
      p.setBindGroup(0, bind);
      p.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
      p.end();
      e.copyBufferToBuffer(buffer, 0, staging, 0, count * 16);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      buffer.destroy();
      return data;
    };
    const frame = async (delta = 0.125) => {
      engine.render({ delta });
      await d.queue.onSubmittedWorkDone();
    };
    await frame();
    const before = await read(caustics.opaque),
      after = await read(afterCapture);
    const eta = 1.333,
      transmission = 1 - ((eta - 1) / (eta + 1)) ** 2;
    const layerWorst = [];
    for (let layer = 0; layer < 4; layer++) {
      const map = await read(caustics.maps[0], layer);
      let worst = 0;
      for (let y = 8; y < 56; y++)
        for (let x = 8; x < 56; x++) {
          const at = (y * 64 + x) * 4;
          worst = Math.max(worst, Math.abs(map[at]), Math.abs(map[at + 1] - transmission), Math.abs(map[at + 2]));
        }
      layerWorst.push(worst);
    }
    options.absorption = [0.38, 0.1, 0.045];
    engine.lighting.direction.set([0.6, 0.8, 0, 1]);
    await frame(0);
    const refractedCosine = Math.sqrt(1 - (1 / eta) ** 2 * (1 - 0.8 ** 2));
    const rs = (0.8 / eta - refractedCosine) / (0.8 / eta + refractedCosine);
    const rp = (0.8 - refractedCosine / eta) / (0.8 + refractedCosine / eta);
    const obliqueFlux = 0.8 * (1 - (rs * rs + rp * rp) / 2);
    let absorptionWorst = 0;
    for (let layer = 0; layer < 4; layer++)
      for (let color = 0; color < 3; color++) {
        const map = await read(caustics.maps[color], layer);
        const height = -12 + layer * 4;
        const flux = obliqueFlux * Math.exp((options.absorption[color] * height) / refractedCosine);
        const vector = [(0.6 / eta / refractedCosine) * flux, flux, 0];
        for (let y = 16; y < 48; y++)
          for (let x = 16; x < 48; x++)
            for (let channel = 0; channel < 3; channel++)
              absorptionWorst = Math.max(absorptionWorst, Math.abs(map[(y * 64 + x) * 4 + channel] - vector[channel]));
      }
    options.absorption = [0, 0, 0];
    engine.lighting.direction.set([0, 1, 0, 1]);
    await frame(0);
    const depths = await read(caustics.depth),
      inverse = new Float64Array(16);
    invertMatrixStable(capturedMatrix, inverse, new Float64Array(52));
    const probes = [];
    let brightened = 0,
      compositeWorst = 0;
    // Select the known horizontal receiver inside the map, independently of
    // the production normal reconstruction and focusing calculation.
    for (let y = 2; y < 126; y++)
      for (let x = 2; x < 190; x++) {
        const at = (y * 192 + x) * 4;
        const ndc = [((x + 0.5) / 192) * 2 - 1, 1 - ((y + 0.5) / 128) * 2, depths[at], 1];
        const world = [0, 0, 0, 0];
        for (let row = 0; row < 4; row++)
          for (let col = 0; col < 4; col++) world[row] += inverse[col * 4 + row] * ndc[col];
        const p = world.slice(0, 3).map((v) => v / world[3]);
        if (x === 96 && [64, 90, 110].includes(y))
          probes.push({ x, y, p, depth: depths[at], before: before[at], after: after[at] });
        if (Math.abs(p[1] + 5.9) > 0.001 || Math.abs(p[0]) > 20 || Math.abs(p[2]) > 20) continue;
        if (before[at] < 0.01) continue;
        for (let c = 0; c < 3; c++)
          compositeWorst = Math.max(compositeWorst, Math.abs(after[at + c] - before[at + c] * (1 + transmission)));
        if (after[at] > before[at]) brightened++;
      }
    const shadowBuffer = d.createBuffer({ size: 16, usage: 72 });
    options.shadows = {
      pbr: (group) => ({
        declarations: `@group(${group}) @binding(0) var<uniform> control:vec4f;
fn shadowLit(color:vec3f,p:vec3f,n:vec3f)->f32{return select(1.0,0.0,(p.x<0.0)&&select((p.y> -0.1),(p.y< -0.1),(control.x>0.5)));}`,
      }),
      bindings: () => [{ binding: 0, resource: { buffer: shadowBuffer } }],
    };
    const shadowRows = [];
    for (const mode of [0, 1]) {
      d.queue.writeBuffer(shadowBuffer, 0, new Float32Array([mode, 0, 0, 0]));
      await frame(0);
      const map = await read(caustics.maps[0], 0),
        composite = await read(afterCapture);
      let mapWorst = 0,
        receiverWorst = 0,
        receiverProbes = 0;
      for (let y = 8; y < 56; y++)
        for (let x = 8; x < 56; x++) {
          mapWorst = Math.max(
            mapWorst,
            Math.abs(map[(y * 64 + x) * 4 + 1] - (mode === 0 && x < 32 ? 0 : transmission)),
          );
        }
      for (let y = 4; y < 124; y++)
        for (let x = 4; x < 188; x++) {
          const at = (y * 192 + x) * 4;
          if (Math.abs(depths[at] - depths[(110 * 192 + 96) * 4]) > 0.000001) continue;
          const worldX = (x + 0.5 - 96) * 0.125;
          const coordinate = worldX / (60 / 64) + 31.5;
          const lo = Math.floor(coordinate),
            blend = coordinate - lo;
          const entryVisibility = (lo < 32 ? 0 : 1) * (1 - blend) + (lo + 1 < 32 ? 0 : 1) * blend;
          const visibility = mode === 0 ? entryVisibility : +(worldX >= 0);
          for (let c = 0; c < 3; c++)
            receiverWorst = Math.max(
              receiverWorst,
              Math.abs(composite[at + c] - before[at + c] * (1 + visibility * transmission)),
            );
          receiverProbes++;
        }
      shadowRows.push({ mode, mapWorst, receiverWorst, receiverProbes });
    }
    delete options.shadows;
    shadowBuffer.destroy();
    options.enabled = false;
    await frame();
    const disabled = await read(afterCapture);
    let disabledWorst = 0;
    for (let i = 0; i < disabled.length; i++)
      disabledWorst = Math.max(disabledWorst, Math.abs(disabled[i] - before[i]));
    options.enabled = true;
    water.setWaveHeight(0.2);
    await frame();
    const sourceAmplitude = water.values[34];
    const animated = await read(caustics.maps[0], 0);
    const changed = Array.from(animated).some((value, i) => i % 4 === 1 && Math.abs(value - transmission) > 0.01);
    const animatedMin = Math.min(...Array.from(animated).filter((_, i) => i % 4 === 1)),
      animatedMax = Math.max(...Array.from(animated).filter((_, i) => i % 4 === 1));
    engine.camera.position = [0, -2, 7];
    await frame();
    const sourceTimesMatch = events.every(
      (event) => event.sourceTime === Math.fround(event.authoredTime) && event.mapsReady,
    );
    const beforeRestore = await read(caustics.maps[0]);
    caustics.onDeviceRestored(caustics.engine);
    await frame(0);
    const afterRestore = await read(caustics.maps[0]);
    const restoredSame = beforeRestore.every((v, i) => v === afterRestore[i]);
    canvas.style.cssText = 'width:160px;height:96px';
    await frame(0);
    const resized = [caustics.opaque.width, caustics.opaque.height];
    caustics.illuminate = illuminate;
    afterCapture.destroy();
    stack.dispose();
    caustics.dispose();
    water.dispose();
    const fft = FFTOcean.attach(engine, { resolution: 16, size: 80, segments: 16, followCamera: false, windSpeed: 8 });
    fft.setTime(2);
    const fftCaustics = new Caustics({ ...options, surface: fft });
    const fftStack = PostStack.attach(engine, [fftCaustics]);
    await frame(0);
    const fftMap = await read(fftCaustics.maps[0], 0);
    const fftFinite = Array.from(fftMap).every(Number.isFinite);
    const fftHasLight = Array.from(fftMap).some((v, i) => i % 4 === 1 && v > 0);
    const fftFirstTime = fft.renderedTime;
    raised.visible = false;
    fft.dispose();
    let detachedCode;
    try {
      await frame(0);
    } catch (error) {
      detachedCode = error.code;
    }
    fftStack.dispose();
    fftCaustics.dispose();
    fft.dispose();
    projection.dispose();
    const validation = await d.popErrorScope();
    engine.dispose();
    return {
      layerWorst,
      absorptionWorst,
      shadowRows,
      restoredSame,
      resized,
      brightened,
      compositeWorst,
      disabledWorst,
      changed,
      animatedMin,
      animatedMax,
      sourceAmplitude,
      probes,
      dimensions: [before.length, depths.length, canvas.width, canvas.height],
      sourceTimesMatch,
      events,
      fftFinite,
      fftHasLight,
      fftFirstTime,
      detachedCode,
      validation: validation?.message,
    };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  for (const worst of result.layerWorst) assert.ok(worst < 0.001, `flat-interface flux ${worst}`);
  assert.ok(result.absorptionWorst < 0.001, `oblique RGB extinction ${result.absorptionWorst}`);
  for (const row of result.shadowRows) {
    assert.ok(row.mapWorst < 0.001, `entry shadow ${row.mode}: ${row.mapWorst}`);
    assert.ok(row.receiverWorst < 0.003, `receiver shadow ${row.mode}: ${row.receiverWorst}`);
    assert.ok(row.receiverProbes > 1000);
  }
  assert.equal(result.restoredSame, true);
  assert.deepEqual(result.resized, [160, 96]);
  assert.ok(result.brightened > 1000);
  assert.ok(result.compositeWorst < 0.003, `pre-water composite ${result.compositeWorst}`);
  assert.equal(result.disabledWorst, 0);
  assert.equal(result.changed, true);
  assert.equal(result.sourceTimesMatch, true);
  assert.equal(result.fftFinite, true);
  assert.equal(result.fftHasLight, true);
  assert.equal(result.fftFirstTime, 2);
  assert.equal(result.detachedCode, 'state');
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-caustics-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify({ ...result, hardware: browser.hardware }, null, 2),
  );
} finally {
  await browser.close();
}
