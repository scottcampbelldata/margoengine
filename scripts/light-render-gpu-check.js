// Real-WebGPU render check of light fixes on core meshes. Two floor halves under one occluder, read back from the canvas:
// - receiveShadow: a core mesh with `mesh.receiveShadow = false` (or `shadows.add(mesh, {receiveShadow: false})`) is
//   lit inside the occluder's shadow exactly as with no shadow plugin, while the receiving half is dark, for
//   @margoengine/shadows and for clustered local shadows (LocalShadows and ClusteredOptions.shadows).
// - pi/2 spots: a downward spot of angle pi/2 (penumbra 0) lights everything below its plane exactly as a point light of
//   the same range and decay (so cluster culling drops no lit cluster) and a wall above it not at all; with
//   LocalShadows or integrated shadows its six-face cube shadow is the point light's, pixel for pixel.
// Run after npm run build:packages: node scripts/light-render-gpu-check.js (takes the GPU lock).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'light-render-gpu-check' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 5234 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      core = await import('/packages/core/dist/extension.js');
    const width = 256,
      height = 256,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${width}px;height:${height}px`;
    document.body.append(canvas);
    const instance = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 9, 7], target: [0, 0, 0], fov: 50, near: 0.1, far: 60 },
      }),
      engine = core.engineRuntime(instance),
      validation = [];
    instance.stop();
    engine.gpu.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
    const geometry = core.box(),
      grey = new core.PbrMaterial({ color: [0.6, 0.6, 0.6], roughness: 0.9 }),
      mesh = (scale, position) => instance.createMesh().setGeometry(geometry).setScale(scale).setPosition(position);
    const scene = {
      left: mesh([3, 0.2, 7], [-1.6, -0.1, 0]).setMaterial(grey),
      right: mesh([3, 0.2, 7], [1.6, -0.1, 0]).setMaterial(grey),
      occluder: mesh([4.4, 0.2, 2], [0, 2.5, 0]).setMaterial(grey),
      wall: mesh([8, 8, 0.2], [0, 4, -3.1]).setMaterial(grey),
    };
    scene.wall.visible = false;
    // Copy the canvas texture right after submit: MSAA resolve, core batches and the frame graph stay in the path.
    const render = async () => {
      const device = engine.gpu,
        context = canvas.getContext('webgpu'),
        format = navigator.gpu.getPreferredCanvasFormat(),
        bytesPerRow = width * 4;
      let current;
      context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const getCurrentTexture = context.getCurrentTexture.bind(context);
      context.getCurrentTexture = () => (current = getCurrentTexture());
      const read = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        instance.render({ culling: false });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: current }, { buffer: read, bytesPerRow }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(read.getMappedRange()).slice();
        if (format.startsWith('bgra'))
          for (let i = 0; i < bytes.length; i += 4) [bytes[i], bytes[i + 2]] = [bytes[i + 2], bytes[i]];
        if (validation.length) throw new Error(validation.join('\n'));
        return bytes;
      } finally {
        context.getCurrentTexture = getCurrentTexture;
        read.destroy();
      }
    };
    // Canvas pixel of a world point, and the RGB there (3x3 mean).
    const project = (position) => {
      const m = engine.camera.matrix,
        v = [0, 0, 0, 0];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) v[r] += m[c * 4 + r] * [...position, 1][c];
      return [Math.round(((v[0] / v[3]) * 0.5 + 0.5) * width), Math.round((0.5 - (v[1] / v[3]) * 0.5) * height)];
    };
    const pixel = (bytes, position) => {
      const [x, y] = project(position),
        rgb = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          for (let c = 0; c < 3; c++) rgb[c] += bytes[((y + dy) * width + x + dx) * 4 + c] / 9;
      return rgb.map((v) => +v.toFixed(2));
    };
    // Points: under the occluder (shadowed) and in the open, on each half.
    const points = { left: [-1.6, 0, 0], right: [1.6, 0, 0], leftOpen: [-1.6, 0, 2.8], rightOpen: [1.6, 0, 2.8] };
    const frame = async (where = points) => {
      const bytes = await render();
      return { bytes, ...Object.fromEntries(Object.entries(where).map(([k, p]) => [k, pixel(bytes, p)])) };
    };
    // Pixels that differ between two frames, and how many lie right of the centre column (the right half).
    const diff = (a, b) => {
      let pixels = 0,
        right = 0,
        max = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (!d) continue;
        pixels++;
        max = Math.max(max, d);
        if ((i / 4) % width > width / 2 + 2) right++;
      }
      return { pixels, right, max };
    };
    // Pixels that differ, and the lowest canvas row holding one.
    const rows = (a, b) => {
      let pixels = 0,
        lowest = -1;
      for (let i = 0; i < a.length; i += 4)
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
          pixels++;
          lowest = Math.max(lowest, Math.floor(i / 4 / width));
        }
      return { pixels, lowest };
    };
    window.lightCheck = { instance, engine, scene, frame, diff, rows, project, strip: ({ bytes, ...rest }) => rest };
  });

  const receive = await browser.page.evaluate(async () => {
    const { instance, engine, scene, frame, diff, strip } = window.lightCheck,
      { Shadows } = await import('/packages/shadows/dist/index.js'),
      { Clustered } = await import('/packages/clustered/dist/index.js'),
      { LocalShadows } = await import('/packages/clustered/dist/shadows.js');
    const out = {};
    // The occluder casts but does not receive (no self-shadowing to compare), so only the left floor may differ.
    scene.occluder.receiveShadow = false;
    // Directional: sun straight down, no ambient, so the umbra is black.
    engine.lighting.direction.set([0, 1, 0, 3]);
    engine.lighting.radiance.set([1, 1, 1, 0]);
    const plain = await frame(),
      shadows = new Shadows();
    instance.use(shadows);
    shadows.add(scene.occluder);
    shadows.add(scene.left);
    const removeRight = shadows.add(scene.right, { receiveShadow: false });
    out.addFalse = scene.right.receiveShadow;
    const optedOut = await frame();
    removeRight();
    out.restored = scene.right.receiveShadow;
    const both = await frame();
    scene.right.receiveShadow = false;
    const property = await frame();
    scene.right.receiveShadow = true;
    out.directional = {
      plain: strip(plain),
      optedOut: strip(optedOut),
      both: strip(both),
      property: strip(property),
      optedOutVsPlain: diff(optedOut.bytes, plain.bytes),
      propertyVsPlain: diff(property.bytes, plain.bytes),
    };
    instance.removePlugin(shadows.name);
    // Local: a point light above the occluder, sun off.
    engine.lighting.direction.set([0, 1, 0, 0]);
    const light = { position: [0, 5, 0], range: 12, intensity: 40 };
    let lights = Clustered.attach(instance, { grid: [8, 8, 16] });
    lights.setLights([{ ...light, castShadow: true }]);
    const localPlain = await frame(),
      local = LocalShadows.attach(instance, { lights });
    local.add(scene.occluder);
    const localBoth = await frame();
    scene.right.receiveShadow = false;
    const localOptedOut = await frame();
    instance.removePlugin(local.name);
    lights.dispose();
    lights = Clustered.attach(instance, { grid: [8, 8, 16], shadows: { resolution: 512 } });
    lights.setLights([{ ...light, shadow: true }]);
    lights.addShadowCaster(scene.occluder);
    const integratedOptedOut = await frame();
    scene.right.receiveShadow = true;
    const integratedBoth = await frame();
    lights.dispose();
    out.local = {
      plain: strip(localPlain),
      both: strip(localBoth),
      optedOut: strip(localOptedOut),
      integratedOptedOut: strip(integratedOptedOut),
      integratedBoth: strip(integratedBoth),
      optedOutVsPlain: diff(localOptedOut.bytes, localPlain.bytes),
      integratedVsPlain: diff(integratedOptedOut.bytes, localPlain.bytes),
    };
    return out;
  });
  console.log(JSON.stringify(receive));
  const dark = (shadowed, open) =>
    assert.ok(Math.max(...shadowed) < 0.25 * Math.max(...open), `${shadowed} vs ${open}`);
  const { directional: d, local: l } = receive;
  assert.equal(receive.addFalse, false, 'shadows.add(mesh, {receiveShadow: false}) sets mesh.receiveShadow');
  assert.equal(receive.restored, true, 'the remover restores mesh.receiveShadow');
  for (const [name, f] of [
    ['directional', d],
    ['local', l],
  ]) {
    assert.ok(Math.min(...f.plain.right, ...f.plain.left) > 40, `${name}: the floor is lit without shadows`);
    dark(f.both.left, f.plain.left);
    dark(f.both.right, f.plain.right);
  }
  for (const [name, f] of [
    ['directional add', d.optedOut],
    ['directional property', d.property],
    ['local', l.optedOut],
    ['integrated', l.integratedOptedOut],
  ]) {
    dark(f.left, d.plain.left);
    assert.ok(Math.min(...f.right) > 40, `${name}: the non-receiving half is lit under the occluder`);
  }
  dark(l.integratedBoth.right, l.plain.right);
  for (const [name, delta] of [
    ['directional add', d.optedOutVsPlain],
    ['directional property', d.propertyVsPlain],
    ['local', l.optedOutVsPlain],
    ['integrated', l.integratedVsPlain],
  ]) {
    assert.ok(delta.pixels > 200, `${name}: the receiving half is shadowed (${JSON.stringify(delta)})`);
    assert.equal(delta.right, 0, `${name}: the non-receiving half matches the unshadowed frame exactly`);
  }
  assert.deepEqual(errors, []);
  console.log(
    `receiveShadow: the non-receiving half is pixel-identical to the frame without shadows (directional, LocalShadows, integrated) on ${browser.hardware.webgpu?.vendor} ${browser.hardware.webgpu?.architecture}`,
  );

  const hemisphere = await browser.page.evaluate(async () => {
    const { instance, engine, scene, frame, rows, project, strip } = window.lightCheck,
      { Clustered } = await import('/packages/clustered/dist/index.js'),
      { LocalShadows } = await import('/packages/clustered/dist/shadows.js');
    // A light at y = 2 over a small occluder at y = 1, a wall behind reaching above the light; sun and ambient off.
    scene.wall.visible = true;
    scene.occluder.setPosition([0, 1, 0]).setScale([1.6, 0.2, 1.6]);
    engine.lighting.direction.set([0, 1, 0, 0]);
    engine.lighting.radiance.set([1, 1, 1, 0]);
    const where = {
        floorShadow: [0.6, 0, 1.25],
        floorOpen: [1.6, 0, 2.8],
        wallLow: [0, 1, -3],
        wallHigh: [0, 3.2, -3],
      },
      point = { position: [0, 2, 0], range: 10, intensity: 20, decay: 2 },
      spot = { ...point, direction: [0, -1, 0], angle: Math.PI / 2 };
    const pair = async (lights, extra) => {
      lights.setLights([{ ...point, ...extra }]);
      const p = await frame(where);
      lights.setLights([{ ...spot, ...extra }]);
      const s = await frame(where);
      return { point: strip(p), spot: strip(s), diff: rows(p.bytes, s.bytes) };
    };
    const out = { lightRow: project([0, 2, -3])[1] };
    let lights = Clustered.attach(instance, { grid: [8, 8, 16] });
    out.unshadowed = await pair(lights, {});
    const local = LocalShadows.attach(instance, { lights });
    local.add(scene.occluder);
    out.local = await pair(lights, { castShadow: true });
    instance.removePlugin(local.name);
    lights.dispose();
    lights = Clustered.attach(instance, { grid: [8, 8, 16], shadows: { resolution: 512 } });
    lights.addShadowCaster(scene.occluder);
    out.integrated = await pair(lights, { shadow: true });
    lights.dispose();
    return out;
  });
  console.log(JSON.stringify(hemisphere));
  const { unshadowed: u } = hemisphere;
  assert.ok(Math.min(...u.point.wallHigh) > 40, 'the point light lights the wall above it');
  assert.deepEqual(u.spot.wallHigh, [0, 0, 0], 'the pi/2 spot does not light behind its plane');
  assert.ok(Math.min(...u.spot.wallLow, ...u.spot.floorOpen) > 40, 'the pi/2 spot lights everything in front');
  for (const name of ['unshadowed', 'local', 'integrated']) {
    const { diff: delta, point: p } = hemisphere[name];
    assert.ok(delta.pixels > 100, `${name}: the wall above the light differs (${JSON.stringify(delta)})`);
    assert.ok(
      delta.lowest <= hemisphere.lightRow + 1,
      `${name}: below the light's plane the pi/2 spot equals the point light (differing row ${delta.lowest}, plane row ${hemisphere.lightRow})`,
    );
    if (name !== 'unshadowed') dark(p.floorShadow, u.point.floorShadow);
  }
  assert.deepEqual(errors, []);
  console.log(
    `pi/2 spot: pixel-identical to a point light in front of its plane (unshadowed, LocalShadows cube, integrated cube), dark behind it`,
  );
} finally {
  await browser?.close();
  release();
}
