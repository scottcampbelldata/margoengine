// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/far.browser.mjs            (native WebGPU)
//   node packages/terrain/test/far.browser.mjs --compat   (the WebGL2 compatibility layer)
// The far ring of `TerrainStream` (`@margoengine/terrain/far`): near tiles of 64 m (32 samples, 4 x 4) and far tiles
// four times as wide whose heights lie 40 m lower, so the blend between them shows. Drawn heights are read back from the
// terrain's own surface capture (`captureSurfaceHeight`, cells on the samples), which runs the vertex shader every pass
// draws with, and compared with `far.heightAt` at every sample:
// 1. settled: near the camera the near heights exactly, past the blend the far ones, between them a mix;
// 2. a near tile with no data and one that failed show the far ground, and a late tile fades in over `fade`;
// 3. a flight of 1 m steps across window moves, with loads arriving late: no world point's drawn height changes by more
//    in a frame than the blend and the fade allow (a hard switch between the levels would jump 40 m), the picture still
//    matches `heightAt` after the moves, and ground past the near window is always drawn;
// 4. the same under a floating origin 100 km out;
// 5. pictures: weights and tint blend to the far tiles' own, ground past the near window is drawn and nothing past
//    `reach`, streamed far normals change the far shading only, and the terrain still compiles and draws with shadows
//    and screen-space reflections, whose passes read the same shader.
// 6. disposing the stream frees the ring for another; a ring serves one stream at a time.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const context = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' }),
  { page, hardware } = context;
await runSuite(
  async () => {
    const result = await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { TerrainStream } = await import('/packages/terrain/dist/stream.js'),
        { terrainFar } = await import('/packages/terrain/dist/far.js'),
        { Shadows } = await import('/packages/shadows/dist/index.js'),
        { SSR } = await import('/packages/post/dist/ssr.js'),
        { TerrainVirtualTexture } = await import('/packages/terrain/dist/rvt.js');
      const tileSize = 64,
        T = 32,
        spacing = tileSize / T,
        farScale = 4,
        farSpacing = spacing * farScale,
        drop = 40,
        N = 4 * T;
      const ground = (x, z) => 10 * Math.sin(x / 45) * Math.cos(z / 35) + 5 * Math.sin((x + z) / 19);
      const heights = (x0, z0, step, height) => {
        const a = new Float32Array(T * T);
        for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) a[j * T + i] = height(x0 + i * step, z0 + j * step);
        return a;
      };
      const nearTile = (x, z) => ({ heights: heights(x * tileSize, z * tileSize, spacing, ground) }),
        farTile = (x, z) => ({
          heights: heights(x * tileSize * farScale, z * tileSize * farScale, farSpacing, (a, b) => ground(a, b) - drop),
        });
      const colors = (device) => {
        const texture = device.createTexture({
          size: [1, 1, 4],
          format: 'rgba8unorm-srgb',
          usage: 6,
          textureBindingViewDimension: '2d-array',
        });
        device.queue.writeTexture(
          { texture },
          new Uint8Array([220, 30, 30, 255, 30, 220, 30, 255, 120, 110, 105, 255, 235, 240, 245, 255]),
          { bytesPerRow: 4, rowsPerImage: 1 },
          [1, 1, 4],
        );
        return texture;
      };
      const layers = [0, 1, 2, 3].map((i) => ({ height: [-1e5, 1e5], slope: [0, 1], scale: 0.05, tint: i === 1 })),
        common = {
          layers,
          colors,
          tileSize,
          tileTexels: T,
          heightScale: 1,
          cellSize: spacing,
          resolution: 256,
          captureSurfaceHeight: true,
          budget: 1 << 20,
          concurrency: 32,
        };
      const make = async (camera, size = 128) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        document.body.append(canvas);
        const engine = await Engine.create(canvas, { backend: 'webgpu', camera });
        engine.gpu.pushErrorScope('validation');
        return { canvas, engine, size };
      };
      const errors = [];
      const close = async ({ canvas, engine }) => {
        await engine.gpu.queue.onSubmittedWorkDone();
        const error = await engine.gpu.popErrorScope();
        if (error) errors.push(error.message);
        engine.dispose();
        canvas.remove();
      };
      const tick = () => new Promise((r) => setTimeout(r, 1));
      const frame = (engine, delta = 1 / 60) => engine.render({ delta });
      const settle = async (engine, stream, frames = 40) => {
        let state = null;
        frame(engine);
        stream.ready().then(
          () => (state = 'ready'),
          (e) => (state = String(e.message ?? e)),
        );
        for (let i = 0; i < 3000 && !state; i++) {
          await tick();
          frame(engine);
        }
        for (let i = 0; i < frames; i++) frame(engine);
        return state;
      };
      // The drawn surface at every near sample against heightAt: the worst difference and the samples compared.
      const compare = async (engine, stream, ring, shift = [0, 0, 0]) => {
        frame(engine, 0);
        const device = engine.gpu,
          texture = stream.terrain.surfaceHeightTexture,
          row = Math.ceil((N * 4) / 256) * 256,
          buffer = device.createBuffer({ size: row * N, usage: 9 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [N, N]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const data = new Float32Array(buffer.getMappedRange().slice(0));
        buffer.destroy();
        let worst = 0,
          where = null,
          count = 0;
        for (let v = 0; v < N; v++)
          for (let u = 0; u < N; u++) {
            const x = stream.origin[0] + u * spacing,
              z = stream.origin[1] + v * spacing,
              want = ring.heightAt(x, z);
            if (want === undefined) continue;
            count++;
            const got = data[(v * row) / 4 + u],
              d = Math.abs(got - want);
            if (!(d <= worst)) (worst = d), (where = { x, z, got, want });
          }
        return { worst, where, count };
      };
      const out = {};

      // 1 and 2: settled, holes, a late tile.
      {
        const view = await make({ position: [10, 150, 10], target: [10, 0, 60], near: 1, far: 2000 }),
          ring = terrainFar({ scale: farScale, load: async (x, z) => farTile(x, z) });
        let release;
        const late = new Promise((r) => (release = r));
        const stream = TerrainStream.attach(view.engine, {
          ...common,
          far: ring,
          retries: 0,
          async load(x, z) {
            if (x === -1 && z === -1) return null;
            if (x === -1 && z === 0) throw new Error('tile -1,0 is gone');
            if (x === 0 && z === 0) await late;
            return nearTile(x, z);
          },
        });
        let state = null;
        stream.ready().catch((e) => (state = e.message));
        for (let i = 0; i < 60; i++) {
          await tick();
          frame(view.engine);
        }
        const probes = { late: [30, 30], empty: [-34, -34], failed: [-34, 30], loaded: [30, -34] },
          read = () =>
            Object.fromEntries(
              Object.entries(probes).map(([k, [x, z]]) => [k, { drawn: ring.heightAt(x, z), near: ground(x, z) }]),
            );
        const before = read(),
          beforeGPU = await compare(view.engine, stream, ring);
        release();
        await tick();
        // One frame uploads the tile and starts its fade; 15 more of 1/60 s pass about half of the 0.5 s.
        for (let i = 0; i < 15; i++) frame(view.engine);
        const half = read(),
          halfGPU = await compare(view.engine, stream, ring);
        for (let i = 0; i < 40; i++) frame(view.engine);
        const full = read(),
          fullGPU = await compare(view.engine, stream, ring);
        // Past the near window: only the far heights, up to reach.
        const beyond = {
          inside: ring.heightAt(10 + ring.reach - 6, 10),
          outside: ring.heightAt(10 + ring.reach + 6, 10) ?? null,
          far: ground(10 + ring.reach - 6, 10) - drop,
        };
        // Along +X from the camera, the share of far data in the drawn height, clear of the missing tiles' ramps.
        const shares = [];
        for (let d = 30; d <= 130; d += 4) {
          const x = 10 + d,
            z = 10;
          shares.push([d, (ground(x, z) - ring.heightAt(x, z)) / drop]);
        }
        out.settled = {
          state,
          detail: ring.detail,
          reach: ring.reach,
          levels: stream.terrain.options.levels,
          farTile: [...ring.tiles.tile],
          farResident: ring.tiles.resident(0, 0),
          before,
          half,
          full,
          beforeGPU,
          halfGPU,
          fullGPU,
          beyond,
          shares,
          retried: stream.retry(),
        };
        // A ring serves one stream at a time; disposing frees it.
        let second = null;
        try {
          TerrainStream.attach(view.engine, { ...common, far: ring, load: async () => null });
        } catch (error) {
          second = error.code;
        }
        stream.dispose();
        const reused = TerrainStream.attach(view.engine, {
          ...common,
          far: ring,
          load: async (x, z) => nearTile(x, z),
        });
        const reusedState = await settle(view.engine, reused);
        out.reuse = { second, reusedState, gpu: await compare(view.engine, reused, ring) };
        reused.dispose();
        out.disposed = { tiles: ring.tiles === undefined, height: ring.heightAt(0, 0) ?? null };
        await close(view);
      }

      // 3 and 4: a flight across window moves, and the same under a floating origin.
      for (const [name, offset] of [
        ['flight', [0, 0, 0]],
        ['origin', [100032, 0, -99968]],
      ]) {
        const view = await make({ position: [10, 150, 10], target: [10, 0, 60], near: 1, far: 2000 }),
          ring = terrainFar({
            scale: farScale,
            load: async (x, z) => {
              await new Promise((r) => setTimeout(r, (x * 5 + z * 3) & 3));
              return farTile(x, z);
            },
          });
        const floating = offset[0] ? { origin: offset, onRebase: () => () => {} } : undefined;
        let late = 0;
        if (floating) {
          view.engine.camera.position = [10, 150, 10];
          view.engine.camera.target = [10, 0, 60];
        }
        const stream = TerrainStream.attach(view.engine, {
          ...common,
          far: ring,
          ...(floating ? { floatingOrigin: floating } : {}),
          async load(x, z) {
            // Some tiles take a while: they arrive after the window has moved on to show them.
            const wait = (x * 7 + z * 5) & 15;
            for (let i = 0; i < wait; i++) await tick();
            late = Math.max(late, wait);
            return nearTile(x, z);
          },
        });
        const first = await settle(view.engine, stream);
        const steps = floating ? 270 : 360,
          step = 1,
          grid = 12;
        let worst = 0,
          worstAt = null,
          missing = 0,
          moves = 0,
          faded = 0,
          previous = new Map(),
          tile = [...stream.tile];
        const checks = [];
        for (let s = 0; s <= steps; s++) {
          // East, then a diagonal back and north: windows move along both axes and both ways.
          const third = steps / 3,
            x = 10 + step * (s < third ? s : s < 2 * third ? third - (s - third) : 0),
            z = 10 + step * (s < third ? 0 : s < 2 * third ? s - third : third + (s - 2 * third));
          view.engine.camera.position = [x, 150, z];
          view.engine.camera.target = [x, 0, z + 50];
          frame(view.engine);
          await tick();
          if (stream.tile[0] !== tile[0] || stream.tile[1] !== tile[1]) {
            moves++;
            tile = [...stream.tile];
          }
          const cx = x + offset[0],
            cz = z + offset[2],
            now = new Map();
          for (let j = -22; j <= 22; j++)
            for (let i = -22; i <= 22; i++) {
              const wx = (Math.round(cx / grid) + i) * grid,
                wz = (Math.round(cz / grid) + j) * grid,
                h = ring.heightAt(wx, wz),
                key = wx + ',' + wz;
              if (h === undefined) continue;
              now.set(key, h);
              // Ground well inside reach is the near or the far height or between them, never the unloaded fill.
              if (h < ground(wx, wz) - drop - 3 || h > ground(wx, wz) + 3) missing++;
              if (previous.has(key)) {
                const d = Math.abs(h - previous.get(key));
                if (d > 0.01) faded++;
                if (d > worst) (worst = d), (worstAt = { s, wx, wz, was: previous.get(key), h });
              }
            }
          previous = now;
          if (s % (steps / 6) === steps / 6 - 1) checks.push(await compare(view.engine, stream, ring));
        }
        // What a frame may change: the blend moves by the camera's step (and its quantum) over its width, a fading tile
        // by delta / fade, each of the 40 m between the levels (plus the far surface's own sampling error).
        const width = 32,
          allowed = (drop + 3) * ((step + width / 256) / width + 1 / 60 / 0.5);
        out[name] = { first, worst, worstAt, allowed, missing, moves, faded, late, checks };
        stream.dispose();
        await close(view);
      }

      // 5: pictures from above. Near tiles paint layer 0 (red), far tiles layer 1 (green) tinted blue.
      {
        const bytes = (rgba) => new Uint8Array(T * T * 4).map((_, k) => rgba[k % 4]);
        const picture = async ({ normals = false, tilt = false, effects = false, virtual = false, ring = true }) => {
          const size = 256,
            view = await make({ position: [0, 800, 0.5], target: [0, 0, 0], near: 10, far: 3000 }, size),
            far = terrainFar({
              scale: farScale,
              load: async () => ({
                heights: new Float32Array(T * T),
                weights: [bytes([0, 255, 0, 0])],
                tint: bytes([0, 0, 255, 255]),
                ...(normals ? { normals: bytes(tilt ? [230, 200, 128, 255] : [128, 255, 128, 255]) } : {}),
              }),
            }),
            shadows = effects ? Shadows.attach(view.engine, { distance: 1500, cascades: 1 }) : undefined,
            reflections = effects ? SSR.attach(view.engine, {}) : undefined,
            stream = TerrainStream.attach(view.engine, {
              ...common,
              captureSurfaceHeight: false,
              weights: 1,
              tint: true,
              normals,
              ...(ring ? { far } : {}),
              load: async () => ({
                heights: new Float32Array(T * T),
                weights: [bytes([255, 0, 0, 0])],
                ...(normals ? { normals: bytes([128, 255, 128, 255]) } : {}),
              }),
            });
          shadows?.add(stream.terrain, { static: true });
          reflections?.add(stream.terrain);
          view.engine.lighting.direction.set([0.5, 0.7, 0.2]);
          const state = await settle(view.engine, stream);
          // A virtual texture bakes through the same shader, once both windows are in: past the near window too.
          const cache = virtual
            ? TerrainVirtualTexture.attach(view.engine, stream.terrain, { texel: 1, size: 1024, levels: 3 })
            : undefined;
          let baked = 0;
          for (let i = 0; cache && i < 60; i++) {
            frame(view.engine);
            baked += cache.baked;
          }
          await view.engine.gpu.queue.onSubmittedWorkDone();
          frame(view.engine);
          const c = new OffscreenCanvas(size, size).getContext('2d');
          c.drawImage(view.canvas, 0, 0);
          const rgba = c.getImageData(0, 0, size, size).data,
            m = view.engine.camera.matrix,
            at = (x, z) => {
              const w = m[3] * x + m[11] * z + m[15],
                px = Math.floor((((m[0] * x + m[8] * z + m[12]) / w) * 0.5 + 0.5) * size),
                py = Math.floor((0.5 - ((m[1] * x + m[9] * z + m[13]) / w) * 0.5) * size);
              return [...rgba.subarray((py * size + px) * 4, (py * size + px) * 4 + 3)];
            };
          const reach = far.reach ?? 0,
            result = {
              state,
              baked,
              reach,
              sky: [...rgba.subarray(0, 3)],
              centre: at(5, 5),
              blend: at(60, 5),
              far: at(180, 5),
              edge: at(reach ? reach - 12 : 292, 5),
              past: at(reach ? reach + 20 : 330, 5),
            };
          stream.dispose();
          shadows?.dispose();
          reflections?.dispose();
          await close(view);
          return result;
        };
        out.plain = await picture({ ring: false });
        out.painted = await picture({});
        out.normals = await picture({ normals: true });
        out.tilted = await picture({ normals: true, tilt: true });
        out.effects = await picture({ effects: true });
        out.virtual = await picture({ virtual: true, normals: true, tilt: true });
      }
      return { out, errors };
    });
    await writeFile('test-results/terrain-far.json', JSON.stringify({ hardware, result }, null, 1));
    assert.deepEqual(result.errors, []);
    const { settled, reuse, disposed, flight, origin, plain, painted, normals, tilted, effects, virtual } = result.out;
    assert.ok(virtual.baked > 0, 'the virtual texture baked');
    // The cache bakes the colour alone, so it draws what the layers draw: far normals tilted as in `tilted`.
    for (const place of ['centre', 'far', 'edge'])
      assert.ok(
        Math.max(...virtual[place].map((v, i) => Math.abs(v - tilted[place][i]))) <= 4,
        `virtual texture ${place}: ${virtual[place]} against ${tilted[place]}`,
      );
    const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} against ${b}`);
    const drawn = (c, message) => {
      assert.ok(c.count > 10000, `${message}: compared ${c.count} samples`);
      assert.ok(c.worst < 0.01, `${message}: drawn against heightAt ${JSON.stringify(c)}`);
    };
    assert.equal(settled.detail, 44, 'fine detail reaches (4 / 2 - 0.75) * 64 - 4 - 32 m');
    assert.equal(settled.reach, 304);
    assert.equal(settled.levels, 6);
    assert.equal(settled.farResident, true);
    assert.equal(settled.state, 'tile -1,0 is gone', 'ready rejects with the failed near tile');
    assert.equal(settled.retried, 1);
    const far40 = (probe, message) => near(probe.near - probe.drawn, 40, 2.5, message);
    far40(settled.before.late, 'a tile not loaded yet shows the far ground');
    far40(settled.before.empty, 'a tile without data shows the far ground');
    far40(settled.before.failed, 'a failed tile shows the far ground');
    near(settled.before.loaded.drawn, settled.before.loaded.near, 0.02, 'a loaded tile near the camera is exact');
    const share =
      (settled.half.late.near - settled.half.late.drawn) / (settled.before.late.near - settled.before.late.drawn);
    assert.ok(share > 0.35 && share < 0.65, `the late tile is about half faded in after 0.25 s: ${share}`);
    near(settled.full.late.drawn, settled.full.late.near, 0.02, 'and exact after its fade');
    far40(settled.full.empty, 'the empty tile stays far');
    drawn(settled.beforeGPU, 'before the late tile');
    drawn(settled.halfGPU, 'mid fade');
    drawn(settled.fullGPU, 'settled');
    near(settled.beyond.inside, settled.beyond.far, 2.5, 'past the near window the far heights');
    assert.equal(settled.beyond.outside, null, 'nothing past reach');
    for (let i = 0; i < settled.shares.length; i++) {
      const [d, s] = settled.shares[i];
      if (d <= 44) near(s, 0, 0.001, `no far share ${d} m out`);
      if (d >= 76) near(s, 1, 0.06, `all far ${d} m out`);
      if (i) assert.ok(s >= settled.shares[i - 1][1] - 0.05, `the share rises with distance at ${d} m: ${s}`);
    }
    assert.equal(reuse.second, 'attached', 'a ring in use refuses a second stream');
    assert.equal(reuse.reusedState, 'ready');
    drawn(reuse.gpu, 'a ring reused after dispose');
    assert.deepEqual(disposed, { tiles: true, height: null });
    for (const [name, f] of [
      ['flight', flight],
      ['floating origin', origin],
    ]) {
      assert.equal(f.first, 'ready', name);
      assert.ok(f.moves >= 3, `${name}: the window moved ${f.moves} times`);
      assert.ok(f.faded > 100, `${name}: heights changed as the camera moved (${f.faded})`);
      assert.equal(f.missing, 0, `${name}: no ground fell outside the two levels`);
      assert.ok(f.worst <= f.allowed, `${name}: no pop: ${JSON.stringify(f.worstAt)} ${f.worst} > ${f.allowed}`);
      for (const c of f.checks) drawn(c, `${name} after moves`);
    }
    const dominant = (pixel, channel, message) =>
      assert.ok(
        pixel[channel] > 40 && pixel.every((v, i) => i === channel || v < pixel[channel] * 0.6),
        `${message}: ${pixel}`,
      );
    dominant(plain.centre, 0, 'without a ring the near window is red');
    assert.deepEqual(plain.far, plain.sky, 'and nothing is drawn past it');
    for (const [name, p] of [
      ['painted', painted],
      ['with normals', normals],
      ['with shadows and reflections', effects],
    ]) {
      assert.equal(p.state, 'ready', name);
      dominant(p.centre, 0, `${name}: near weights`);
      dominant(p.far, 2, `${name}: far weights and tint`);
      dominant(p.edge, 2, `${name}: drawn up to reach`);
      assert.deepEqual(p.past, p.sky, `${name}: nothing past reach`);
      assert.ok(p.blend[0] > 20 && p.blend[2] > 20, `${name}: both levels in the blend: ${p.blend}`);
    }
    assert.deepEqual(tilted.centre, normals.centre, 'far normals leave the near shading');
    assert.ok(
      Math.max(...tilted.far.map((v, i) => Math.abs(v - normals.far[i]))) > 8,
      `far normals shade the far ground: ${tilted.far} against ${normals.far}`,
    );
    console.log(
      `ok terrain far: drawn = heightAt within ${settled.fullGPU.worst.toExponential(1)} m; flight ${flight.moves} moves, ` +
        `worst change ${flight.worst.toFixed(2)} m of ${flight.allowed.toFixed(2)} allowed; origin ${origin.worst.toFixed(2)} m`,
    );
  },
  () => context.close(),
);
watchExit();
