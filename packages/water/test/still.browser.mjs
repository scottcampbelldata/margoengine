// Still river water: `fill` and `still` stand a sloped surface in a narrow channel. On a 2 percent slope the state read
// back falls with the bed within 0.2 m, no flow pass moves it, the water pixels from above stay inside the channel, and
// from the side the drawn surface is at the fill's height at both ends of the channel (the mesh on the dry cells beside
// a narrow channel used to fall to the sea, so the surface sank up to the bank). Without `still` the same fill runs off.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const r = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js'),
      { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    const W = 480,
      H = 320,
      canvas = document.createElement('canvas');
    canvas.style.cssText = `width:${W}px;height:${H}px`;
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 700, 1], target: [0, 0, 0], near: 1, far: 5000 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    // 128 x 128 cells of 4 m over 512 m: a channel 3 cells wide (x from -6 to 6) along z, its bed 2 percent higher per
    // metre of z from 10 m at z = -256 to about 20 m; banks 30 m above the sea level everywhere else.
    const N = 128,
      CELL = 4,
      bed = (z) => 15 + z * 0.02,
      surface = (z) => bed(z) + 1.5,
      inChannel = (x) => Math.abs(x) <= 6,
      ground = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -256 + (i + 0.5) * CELL,
          z = -256 + (j + 0.5) * CELL;
        ground[j * N + i] = inChannel(x) ? bed(z) : bed(z) + 30;
      }
    const texture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: N * 4 }, [N, N]);
    const read = device.createBuffer({ size: N * N * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    async function stateOf(water) {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: water.coastalDepthTexture }, { buffer: read, bytesPerRow: N * 16 }, [
        N,
        N,
      ]);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(read.getMappedRange()).slice();
      read.unmap();
      return data;
    }
    const render = async (frames) => {
      for (let i = 0; i < frames; i++) {
        engine.render({ delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
      }
    };
    // Fill two cells wider than the channel, so the dry cells beside it hold the level for the mesh.
    const fill = (x, z) => (Math.abs(x) <= 14 ? surface(z) : undefined),
      base = {
        size: [512, 512],
        // Mesh cells of 8 m over heightmap cells of 4 m: some vertices beside the channel stand on dry cells.
        segments: 64,
        height: -5,
        color: [0.9, 0.1, 0.1],
        waves: [{ direction: [1, 0], amplitude: 0, wavelength: 20 }],
        lights: [],
        terrain: { heightmap: () => texture, origin: [-256, -256], size: [512, 512] },
      };
    const water = Water.attach(engine, { ...base, fill, still: true });
    await waitForPipelines(() => render(1));
    await render(2);
    const first = await stateOf(water);
    await render(30);
    const later = await stateOf(water);
    let worst = 0,
      moved = 0,
      wetOutside = 0;
    for (let j = 8; j < N - 8; j++)
      for (let i = 0; i < N; i++) {
        const o = (j * N + i) * 4,
          x = -256 + (i + 0.5) * CELL,
          z = -256 + (j + 0.5) * CELL;
        for (let c = 0; c < 4; c++) moved = Math.max(moved, Math.abs(later[o + c] - first[o + c]));
        if (inChannel(x)) worst = Math.max(worst, Math.abs(later[o] + later[o + 1] - surface(z)));
        else if (later[o] > 0) wetOutside++;
      }
    const shoot = async (position, target) => {
      engine.camera.position = [...position];
      engine.camera.target = [...target];
      const off = new OffscreenCanvas(W, H),
        c = off.getContext('2d', { willReadFrequently: true });
      // In the same task as the frame: the canvas holds it until the browser presents.
      engine.render({ delta: 1 / 60 });
      c.drawImage(canvas, 0, 0);
      return c.getImageData(0, 0, W, H).data;
    };
    // Water pixels differ from the clear colour, which a dry corner of the frame shows.
    const isWater = (d, o) => Math.abs(d[o] - d[0]) + Math.abs(d[o + 1] - d[1]) + Math.abs(d[o + 2] - d[2]) > 8;
    // From above: a pinhole over the middle, 700 m up.
    const above = await shoot([0, 700, 0.01], [0, 0, 0]),
      fov = 60,
      fy = H / 2 / Math.tan((fov * Math.PI) / 360);
    let inside = 0,
      total = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (isWater(above, (y * W + x) * 4)) {
          total++;
          // 684 m above the mid surface; screen x is world x. The channel's cells end at x = 8.
          if (Math.abs(((x + 0.5 - W / 2) * 684) / fy) <= 8) inside++;
        }
    // From the side and above: the water's rows in a column near each end of the channel, against the fill's height.
    const eye = [-160, 200, 0],
      look = [0, surface(0), 0],
      side = await shoot(eye, look);
    const matrix = Array.from(engine.camera.matrix),
      row = (p) => {
        const w = matrix[3] * p[0] + matrix[7] * p[1] + matrix[11] * p[2] + matrix[15],
          y = matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
          x = matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12];
        return [((x / w + 1) * W) / 2, ((1 - y / w) * H) / 2];
      };
    const ends = [-90, 90].map((z) => {
      // The wet run ends where the surface meets the bank, 30 m up across the cell from x = 6 to 10: at 6.2.
      const [cx] = row([0, surface(z), z]),
        column = Math.round(cx),
        near = row([-6.2, surface(z), z])[1],
        farther = row([6.2, surface(z), z])[1];
      let top = -1,
        bottom = -1;
      for (let y = 0; y < H; y++)
        if (isWater(side, (y * W + column) * 4)) {
          if (top < 0) top = y;
          bottom = y;
        }
      return { z, near, farther, top, bottom };
    });
    water.dispose();
    // The waterline of a diagonal channel, close up: where the surface meets the ground between texels it is straight. Depth
    // clamped to 0 on the dry texels put it on their centres: a staircase of whole cells.
    const slanted = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const d = Math.abs((i + 0.5) * CELL - 256 - ((j + 0.5) * CELL - 256)) * Math.SQRT1_2;
        slanted[j * N + i] = 15 + Math.max(0, d - 6);
      }
    const slantedTexture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: slantedTexture }, slanted, { bytesPerRow: N * 4 }, [N, N]);
    const diagonal = Water.attach(engine, {
      ...base,
      terrain: { ...base.terrain, heightmap: () => slantedTexture },
      fill: () => 16.5,
      still: true,
    });
    await waitForPipelines(() => render(1));
    const close = await shoot([0, 216.5, 0.01], [0, 16.5, 0]);
    diagonal.dispose();
    slantedTexture.destroy();
    const edges = [];
    for (let y = 40; y < H - 40; y++)
      for (let x = 0; x < W; x++)
        if (isWater(close, (y * W + x) * 4)) {
          if (x > 0) edges.push([y, x]);
          break;
        }
    const mean = (f) => edges.reduce((a, e) => a + f(e), 0) / edges.length,
      my = mean((e) => e[0]),
      mx = mean((e) => e[1]),
      gain = mean((e) => (e[0] - my) * (e[1] - mx)) / mean((e) => (e[0] - my) ** 2),
      waterline = Math.sqrt(mean((e) => (e[1] - mx - gain * (e[0] - my)) ** 2));
    // The same fill with flow: the passes run, the world's edge cells go to the sea, so `still` is what holds it.
    const flowing = Water.attach(engine, { ...base, fill });
    await waitForPipelines(() => render(1));
    await render(120);
    const ran = await stateOf(flowing);
    let flowWorst = 0;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -256 + (i + 0.5) * CELL,
          z = -256 + (j + 0.5) * CELL,
          o = (j * N + i) * 4;
        if (inChannel(x)) flowWorst = Math.max(flowWorst, Math.abs(ran[o] + ran[o + 1] - surface(z)));
      }
    flowing.dispose();
    // Shoreline foam on a calm sea: a beach rising along x at 5 percent to sea level at x = 0, seen from above under a plain
    // light. The water within 1 m of depth from the waterline is whiter than the water 2.5 to 5 m deep beyond the foam's
    // 3 m band (foamDistance 6): the minimum channel, in which foam adds and the deep body has little.
    const beach = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) beach[j * N + i] = ((i + 0.5) * CELL - 256) * 0.05;
    const beachTexture = device.createTexture({
      size: [N, N],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: beachTexture }, beach, { bytesPerRow: N * 4 }, [N, N]);
    const shore = Water.attach(engine, {
      ...base,
      height: 0,
      foamDistance: 6,
      color: [0.02, 0.24, 0.34],
      lights: undefined,
      terrain: { ...base.terrain, heightmap: () => beachTexture },
      still: true,
    });
    await waitForPipelines(() => render(1));
    const beachShot = await shoot([-30, 200, 0.01], [-30, 0, 0]);
    shore.dispose();
    beachTexture.destroy();
    const pxPerM = fy / 200,
      band = (from, to) => {
        let sum = 0,
          n = 0;
        for (let y = 40; y < H - 40; y++)
          for (let x = 0; x < W; x++) {
            const world = (x + 0.5 - W / 2) / pxPerM - 30;
            if (world < from || world >= to) continue;
            const o = (y * W + x) * 4;
            sum += Math.min(beachShot[o], beachShot[o + 1], beachShot[o + 2]);
            n++;
          }
        return sum / n;
      },
      foamEdge = band(-20, -2),
      foamOpen = band(-100, -60);
    // Options: fill and still need a terrain; still takes no spray.
    const rejected = [
      { fill },
      { still: true },
      { still: 1, terrain: base.terrain },
      { fill: 3, terrain: base.terrain },
      { still: true, spray: true, terrain: base.terrain },
    ].map((o) => {
      try {
        new Water(o);
        return false;
      } catch (e) {
        return e instanceof TypeError;
      }
    });
    const validation = await device.popErrorScope();
    texture.destroy();
    read.destroy();
    engine.dispose();
    return {
      worst,
      moved,
      wetOutside,
      inside,
      total,
      ends,
      flowWorst,
      edges: edges.length,
      waterline,
      foamEdge,
      foamOpen,
      rejected,
      validation: validation?.message ?? null,
    };
  });
  assert.equal(r.validation, null);
  assert.deepEqual(errors, []);
  assert.ok(r.worst <= 0.2, `the surface follows the bed within 0.2 m: ${r.worst}`);
  assert.equal(r.moved, 0, 'still: no pass moves the state');
  assert.equal(r.wetOutside, 0, 'the banks stay dry');
  assert.ok(r.flowWorst > 0.2, `without still the same fill runs off: ${r.flowWorst}`);
  assert.ok(r.total > 500, `water pixels from above: ${r.total}`);
  assert.ok(r.inside / r.total >= 0.95, `water pixels inside the channel: ${r.inside} of ${r.total}`);
  for (const end of r.ends) {
    assert.ok(end.top >= 0, `water seen at z ${end.z}`);
    assert.ok(
      Math.abs(end.top - end.farther) <= 2 && Math.abs(end.bottom - end.near) <= 2,
      `drawn level with the fill up to the bank at z ${end.z}: rows ${end.top} to ${end.bottom}, expected ${end.farther} to ${end.near}`,
    );
  }
  assert.ok(r.edges > 100, `waterline rows: ${r.edges}`);
  assert.ok(r.waterline < 0.7, `the waterline is straight, not a staircase: ${r.waterline} px off its line`);
  // Scott's S6: 76.96 at the old 8 percent cap, 111.72 at 35 (RTX A6000). The open water beside it is unchanged.
  assert.ok(r.foamEdge > 95, `shoreline foam shows at the waterline: ${r.foamEdge}`);
  assert.ok(r.foamOpen < 40, `no shoreline foam on open water: ${r.foamOpen}`);
  assert.ok(r.rejected.every(Boolean), `fill and still options are checked: ${r.rejected}`);
  await writeFile('test-results/water-still-gpu.json', JSON.stringify({ hardware, ...r }, null, 2));
  console.log('ok water still:', JSON.stringify(r));
} finally {
  await closeAll({ browser });
}
