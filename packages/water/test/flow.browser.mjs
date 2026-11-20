import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';

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
  const basins = await page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js'),
      { Water } = await import('/packages/water/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:96px;height:96px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 10, 15], target: [0, 0, 0], near: 0.1, far: 100 },
      }),
      device = engine.gpu;
    device.pushErrorScope('validation');
    const results = [];
    const texture = device.createTexture({
      size: [32, 32],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const ground = new Float32Array(1024),
      read = device.createBuffer({ size: 32 * 32 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    async function capture(water) {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: water.coastal.states[water.coastal.current] },
        { buffer: read, bytesPerRow: 512 },
        [32, 32],
      );
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(read.getMappedRange()).slice();
      read.unmap();
      return data;
    }
    async function advance(frames) {
      for (let i = 0; i < frames; i++) {
        engine.render({ delta: 1 / 60 });
        if (i % 60 === 59) await device.queue.onSubmittedWorkDone();
      }
    }
    for (let pattern = 0; pattern < 12; pattern++) {
      let seed = pattern;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const wet =
            pattern === 0 ||
            (pattern === 1 && x > 0 && y > 0 && x < 31 && y < 31) ||
            (pattern === 2 && (x + y) % 2 === 0) ||
            (pattern === 3 && (x % 4 === 1 || y % 5 === 1)) ||
            (pattern >= 4 && seed / 4294967296 < 0.65);
          ground[y * 32 + x] = wet ? -1 : 2;
        }
      // Independent flood fill checks every component, including isolated ponds and the shared ocean root.
      const expected = new Uint32Array(1025).fill(0xffffffff),
        seen = new Set();
      expected[0] = 0;
      for (let i = 0; i < ground.length; i++)
        if (ground[i] < 0 && !seen.has(i)) {
          const cells = [i];
          seen.add(i);
          let label = i + 1;
          for (let cursor = 0; cursor < cells.length; cursor++) {
            const cell = cells[cursor],
              x = cell % 32,
              y = Math.floor(cell / 32);
            label = Math.min(label, cell + 1);
            if (x === 0 || y === 0 || x === 31 || y === 31) label = 0;
            for (const neighbor of [
              x > 0 ? cell - 1 : -1,
              x < 31 ? cell + 1 : -1,
              y > 0 ? cell - 32 : -1,
              y < 31 ? cell + 32 : -1,
            ])
              if (neighbor >= 0 && ground[neighbor] < 0 && !seen.has(neighbor)) {
                seen.add(neighbor);
                cells.push(neighbor);
              }
          }
          for (const cell of cells) expected[cell + 1] = label;
        }
      device.queue.writeTexture({ texture }, ground, { bytesPerRow: 128 }, [32, 32]);
      for (let repeat = 0; repeat < 3; repeat++) {
        const water = Water.attach(engine, {
          segments: 4,
          terrain: { heightmap: () => texture, origin: [-16, -16], size: [32, 32] },
        });
        try {
          engine.render({ delta: 0 });
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(water.coastal.connected, 0, read, 0, expected.byteLength);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);
          const actual = new Uint32Array(read.getMappedRange(), 0, expected.length);
          for (let i = 0; i < expected.length; i++)
            if (actual[i] !== expected[i])
              throw new Error(`Coastal connectivity mismatch: pattern ${pattern}, repeat ${repeat}, cell ${i}`);
          read.unmap();
        } finally {
          water.dispose();
        }
      }
    }
    for (const connected of [false, true]) {
      ground.fill(2);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) if (x < 2 || y < 2 || x >= 30 || y >= 30) ground[y * 32 + x] = -1;
      for (let y = 12; y < 20; y++) for (let x = 6; x < 13; x++) ground[y * 32 + x] = connected ? -0.2 : -3;
      if (connected) for (let y = 14; y < 18; y++) for (let x = 2; x < 6; x++) ground[y * 32 + x] = 0.1;
      device.queue.writeTexture({ texture }, ground, { bytesPerRow: 128 }, [32, 32]);
      const water = Water.attach(engine, {
        size: [32, 32],
        segments: 32,
        spray: true,
        terrain: { heightmap: () => texture, origin: [-16, -16], size: [32, 32] },
        waves: [{ direction: [1, 0], amplitude: 0.8, wavelength: 100, steepness: 0.1 }],
      });
      engine.render({ delta: 0 });
      const before = await capture(water);
      await advance(1200);
      const flooded = await capture(water);
      const sprayRead = device.createBuffer({
          size: water.spray.buffer.size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(water.spray.buffer, 0, sprayRead, 0, sprayRead.size);
      device.queue.submit([encoder.finish()]);
      await sprayRead.mapAsync(GPUMapMode.READ);
      const droplets = new Float32Array(sprayRead.getMappedRange());
      let liveSpray = 0,
        basinSpray = 0;
      for (let i = 0; i < droplets.length; i += 8)
        if (droplets[i + 3] > 0) {
          liveSpray++;
          if (droplets[i] >= -14 && droplets[i] < -3 && droplets[i + 2] >= -4 && droplets[i + 2] < 4) basinSpray++;
        }
      sprayRead.unmap();
      sprayRead.destroy();
      water.setWaveHeight(0);
      await advance(600);
      const drained = await capture(water);
      // stillVolume is what the basin holds at the still level (0): the connected basin's first frame already holds the
      // sea of the surf's 40 s spin-up (KB-WATER-SWASH1), so the channel's flooding and the sill's retention are measured
      // from still water, as they were when the flow started at rest.
      let initialVolume = 0,
        stillVolume = 0,
        floodedVolume = 0,
        retainedVolume = 0,
        maxDryDepth = 0,
        minimumDepth = Infinity;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const i = (y * 32 + x) * 4;
          minimumDepth = Math.min(minimumDepth, drained[i]);
          if (x >= 6 && x < 13 && y >= 12 && y < 20) {
            initialVolume += before[i];
            stillVolume += Math.max(0, -ground[y * 32 + x]);
            floodedVolume += flooded[i];
            retainedVolume += drained[i];
          }
          if (ground[y * 32 + x] === 2) maxDryDepth = Math.max(maxDryDepth, drained[i]);
        }
      results.push({
        connected,
        initialVolume,
        stillVolume,
        floodedVolume,
        retainedVolume,
        maxDryDepth,
        minimumDepth,
        liveSpray,
        basinSpray,
      });
      water.dispose();
    }
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) ground[z * 32 + x] = 2.5 - 0.36 * Math.hypot(x - 15.5, z - 15.5);
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: 128 }, [32, 32]);
    const island = Water.attach(engine, {
      size: [32, 32],
      segments: 64,
      terrain: { heightmap: () => texture, origin: [-16, -16], size: [32, 32] },
      waves: [{ direction: [1, 0.37], amplitude: 0.8, wavelength: 12, steepness: 0.1 }],
    });
    engine.render({ delta: 0 });
    const initial = await capture(island),
      beaches = [
        [22, 16],
        [9, 16],
        [16, 22],
        [16, 9],
      ],
      peakDepths = [0, 0, 0, 0],
      lowDepths = [Infinity, Infinity, Infinity, Infinity];
    // Each beach stands above the still level, so any water on it ran up. Since KB-WATER-SWASH1 the flow spins up over
    // the surf's last 40 s before its first frame, so the first frame already holds the swash and counts as a sample.
    for (let i = 0; i < beaches.length; i++) {
      const [x, z] = beaches[i],
        cell = (z * 32 + x) * 4;
      if (!(initial[cell + 1] > 0)) throw new Error('Shore regression beach must stand above the still level');
      peakDepths[i] = initial[cell];
      lowDepths[i] = initial[cell];
    }
    const maskRead = device.createBuffer({
        size: island.coastal.connected.size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      maskEncoder = device.createCommandEncoder();
    maskEncoder.copyBufferToBuffer(island.coastal.connected, 0, maskRead, 0, maskRead.size);
    device.queue.submit([maskEncoder.finish()]);
    await maskRead.mapAsync(GPUMapMode.READ);
    const mask = new Uint32Array(maskRead.getMappedRange());
    for (let i = 0; i < ground.length; i++)
      if (mask[i + 1] !== (ground[i] < 0 ? 0 : 0xffffffff))
        throw new Error('Ocean connectivity does not follow the island coast');
    maskRead.unmap();
    maskRead.destroy();
    for (let frame = 0; frame < 24; frame++) {
      await advance(15);
      const state = await capture(island);
      for (let i = 0; i < beaches.length; i++) {
        const [x, z] = beaches[i],
          depth = state[(z * 32 + x) * 4];
        peakDepths[i] = Math.max(peakDepths[i], depth);
        lowDepths[i] = Math.min(lowDepths[i], depth);
      }
    }
    results.push({ shoreDirections: ['east', 'west', 'south', 'north'], peakDepths, lowDepths });
    island.dispose();
    // Spray where swell hits a sea stack (2026-11-13: spray was born only on shallow breakers, so a wall in deep water
    // threw none): a 4 m square stack standing 6 m out of water 4 m deep, swell from the west. Crests throw clumps
    // (velocity.w 2 to 3) up and off the stack's faces; with the swell stilled, none.
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) ground[z * 32 + x] = x >= 14 && x < 18 && z >= 14 && z < 18 ? 6 : -4;
    device.queue.writeTexture({ texture }, ground, { bytesPerRow: 128 }, [32, 32]);
    const stack = Water.attach(engine, {
      size: [32, 32],
      segments: 32,
      spray: true,
      terrain: { heightmap: () => texture, origin: [-16, -16], size: [32, 32] },
      waves: [{ direction: [1, 0], amplitude: 0.8, wavelength: 20, steepness: 0.2 }],
    });
    const clumps = async () => {
      const copy = device.createBuffer({
          size: stack.spray.buffer.size,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(stack.spray.buffer, 0, copy, 0, copy.size);
      device.queue.submit([encoder.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const d = new Float32Array(copy.getMappedRange());
      let count = 0,
        near = 0,
        top = -Infinity,
        droplets = 0;
      for (let i = 0; i < d.length; i += 8)
        if (d[i + 3] > 0) {
          if (d[i + 7] < 2) {
            droplets++;
            continue;
          }
          count++;
          if (Math.max(Math.abs(d[i]), Math.abs(d[i + 2])) < 6) near++;
          top = Math.max(top, d[i + 1]);
        }
      copy.unmap();
      copy.destroy();
      return { count, near, top, droplets };
    };
    engine.render({ delta: 0 });
    let hits = { count: 0, near: 0, top: -Infinity, droplets: 0 };
    // Snapshots every 5 frames over 4 s, so a clump is seen near the top of its arc.
    for (let k = 0; k < 48; k++) {
      await advance(5);
      const now = await clumps();
      hits = {
        count: Math.max(hits.count, now.count),
        near: Math.max(hits.near, now.near),
        top: Math.max(hits.top, now.top),
        droplets: Math.max(hits.droplets, now.droplets),
      };
    }
    stack.setWaveHeight(0);
    await advance(240);
    const calm = await clumps();
    results.push({ stackSpray: hits, calmSpray: calm });
    stack.dispose();
    const standalone = Water.attach(engine, { size: [32, 32], segments: 8 });
    engine.render({ delta: 0.1 });
    await device.queue.onSubmittedWorkDone();
    standalone.dispose();
    const validation = await device.popErrorScope();
    read.destroy();
    texture.destroy();
    engine.dispose();
    if (validation) throw new Error(validation.message);
    return results;
  });
  const [isolated, connected] = basins;
  // The surf's spin-up leaves an enclosed pond at the still level: its sea drive once pushed water up over the 2 m bank
  // while the sea beside it stood at 0.74 m, 120 m^3 into this pond before the first frame (KB-WATER-SWASH1).
  assert.ok(Math.abs(isolated.initialVolume - isolated.stillVolume) < 0.001, 'The spin-up flooded an enclosed basin');
  assert.ok(Math.abs(isolated.retainedVolume - isolated.initialVolume) < 0.001, 'Enclosed basin gained or lost water');
  assert.ok(
    Math.abs(isolated.floodedVolume - isolated.initialVolume) < 0.001,
    'Offshore waves independently animated an enclosed pond',
  );
  assert.ok(connected.floodedVolume > connected.stillVolume + 0.1, 'Ocean did not flow through the channel');
  assert.ok(
    connected.retainedVolume > connected.stillVolume + 0.1,
    'Basin did not retain water behind its outlet sill',
  );
  assert.ok(connected.retainedVolume < connected.floodedVolume - 0.1, 'Basin did not drain back towards the sea');
  assert.equal(isolated.basinSpray, 0, 'A calm enclosed basin generated breaking spray');
  assert.ok(connected.basinSpray > 0, 'Breaking channel flow did not generate GPU spray');
  for (const result of basins.slice(0, 2)) {
    assert.equal(result.maxDryDepth, 0, 'Water crossed high ground');
    assert.ok(result.minimumDepth >= 0, 'Negative water depth');
  }
  // Spray at a sea stack in deep water: crests throw clumps that rise metres up its faces; a still sea throws none.
  const { stackSpray, calmSpray } = basins[3];
  assert.ok(
    stackSpray.count > 20 && stackSpray.near > stackSpray.count * 0.9,
    `No impact spray at the stack: ${JSON.stringify(basins[3])}`,
  );
  assert.ok(stackSpray.top > 1.5, `Impact spray did not rise up the stack: ${JSON.stringify(basins[3])}`);
  assert.equal(stackSpray.droplets, 0, `Deep water threw breaker droplets: ${JSON.stringify(basins[3])}`);
  assert.equal(calmSpray.count, 0, `A still sea threw impact spray: ${JSON.stringify(basins[3])}`);
  for (let i = 0; i < 4; i++) {
    assert.ok(basins[2].peakDepths[i] > 0.015, `Surf never washed onto the ${basins[2].shoreDirections[i]} beach`);
    assert.ok(
      basins[2].peakDepths[i] - basins[2].lowDepths[i] > 0.01,
      `Surf on the ${basins[2].shoreDirections[i]} beach did not advance and recede`,
    );
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/water-flow-${hardware.webgpu.vendor}.json`,
    JSON.stringify({ hardware, basins, errors }, null, 2),
  );
  console.log(JSON.stringify({ hardware, basins, errors }, null, 2));
} finally {
  await browser.close();
}
