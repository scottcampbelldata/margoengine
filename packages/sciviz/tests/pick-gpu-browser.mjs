import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
for (const fallback of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' }),
    errors = [];
  browser.page.setDefaultTimeout(120000);
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    const report = await browser.page.evaluate(async (fallback) => {
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const { createFallbackFigure } = await import('/packages/sciviz/dist/fallback.js');
      const compat = fallback ? await import('/packages/webgl2-compat/dist/index.js') : undefined;
      const create = fallback ? (canvas, options) => createFallbackFigure(canvas, { ...options, compat }) : Figure.create;
      const { GpuPicking } = await import('/packages/sciviz/dist/pick-gpu.js');
      const { projectPoint, multiplyMatrices } = await import('/packages/math/dist/mat4.js');
      const { screenRay } = await import('/packages/sciviz/dist/maths.js');
      const { meshLayer } = await import('/packages/sciviz/dist/grids.js');
      const { SelectionStore, bindSelection } = await import('/packages/sciviz/dist/link.js');
      const dataToClip = (a, b) => multiplyMatrices(a, b, new Float64Array(16));
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 192;
      canvas.style.cssText = 'width:256px;height:192px';
      document.body.append(canvas);
      const fig = await create(canvas, {
        axes: false,
        controls: false,
        mode: '2d',
        margin: { top: 0, left: 0, right: 0, bottom: 0 },
        limits: [-1, 1, -1, 1],
      });
      fig.engine.stop();
      const pick = new GpuPicking(fig),
        gpuErrors = [];
      const watch = () =>
        fig.renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      watch();
      const check = (x, message) => {
        if (!x) throw new Error(message);
      };
      const render = async () => {
        await fig.ready();
        fig.render();
        await fig.renderer.device.queue.onSubmittedWorkDone();
      };
      const project = (position) =>
        projectPoint(dataToClip(fig.engine.camera.matrix, fig.model), ...position, 256, 192, 'webgpu');
      const choose = async (point, radius = 8) => {
        const p = project(point);
        return pick.pick(p.x, p.y, { radius });
      };
      try {
        let layer = await fig.scatter({ positions: new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0, 0]) });
        await render();
        for (const index of [0, 1, 2]) {
          const p = project([...layer.positions.subarray(index * 3, index * 3 + 3)]),
            cpu = fig.pick(p.x, p.y),
            gpu = await pick.pick(p.x, p.y);
          check(cpu.index === index && gpu?.index === cpu.index, 'point CPU/GPU match');
        }
        check((await pick.pick(10, 10)) === null, 'empty pixel');
        check((await pick.pick(-1, 0)) === null, 'outside');
        const first = pick.pick(64, 96),
          second = pick.pick(192, 96);
        const pair = await Promise.all([first, second]);
        check(pair[0]?.index === 0 && pair[1]?.index === 1, 'serialized picks');
        layer.cloud.visible = false;
        check((await choose([-0.5, 0, 0])) === null, 'hidden point cloud');
        layer.cloud.visible = true;
        layer.cloud.positions[0] = -0.25;
        pick.invalidate(layer);
        await render();
        check((await choose([-0.25, 0, 0]))?.index === 0, 'invalidated point upload');
        const old = fig.pick;
        fig.pick = () => {
          throw new Error('CPU hover was called');
        };
        const stop = pick.attachHover();
        const hover = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('hover event missing')), 5000);
          fig.addEventListener(
            'hover',
            (e) => {
              clearTimeout(timeout);
              resolve(e.detail);
            },
            { once: true },
          );
        });
        const rect = canvas.getBoundingClientRect(),
          hoverAt = project([0.5, 0, 0]);
        canvas.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: rect.left + hoverAt.x,
            clientY: rect.top + hoverAt.y,
            bubbles: true,
          }),
        );
        check((await hover)?.index === 1, 'GPU hover');
        stop();
        fig.pick = old;
        const store=new SelectionStore([0,1,2]),binding=bindSelection(fig,layer,store,{rowIds:[0,1,2]});
        check(layer.cloud.visible && layer.cloud.mask !== null && (await choose([0.5,0,0]))?.index===1,'a bound cloud draws its own masked points and stays GPU pickable');
        binding.visible=false;check(await choose([0.5,0,0])===null,'a hidden bound cloud is not pickable');binding.visible=true;
        binding.dispose();store.dispose();
        fig.remove(layer);
        const cells = await fig.heatmap(new Float32Array([10, 20, 30, 40]), { nx: 2, ny: 2, x: [-1, 1], y: [-1, 1] });
        await render();
        for (const point of [
          [-0.5, -0.5, 0],
          [0.5, -0.5, 0],
          [-0.5, 0.5, 0],
          [0.5, 0.5, 0],
        ]) {
          const p = project(point),
            cpu = fig.pick(p.x, p.y),
            gpu = await pick.pick(p.x, p.y);
          check(gpu?.index === cpu?.index && gpu?.value === cpu?.value, 'chart cell CPU/GPU match');
        }
        fig.remove(cells);
        pick.dispose();
        fig.dispose();
        const sf = await create(canvas, {
          axes: false,
          controls: false,
          limits: [-1, 1, -1, 1, -1, 1],
        });
        sf.engine.stop();
        sf.engine.camera.position = [0, 4, 0];
        sf.engine.camera.target = [0, 0, 0];
        sf.engine.camera.up = [0, 0, -1];
        const sp = new GpuPicking(sf);
        const surface = sf.surface(new Float32Array([0, 0, 0, 0]), { nx: 2, ny: 2, x: [-1, 1], y: [-1, 1] });
        const surfacePick = async (point) => {
          await sf.ready();
          sf.render();
          const p = projectPoint(dataToClip(sf.engine.camera.matrix, sf.model), ...point, 256, 192, 'webgpu');
          return sp.pick(p.x, p.y);
        };
        let hit = await surfacePick([0.25, 0.25, 0]);
        check(hit?.kind === 'cell' && hit.index === 0 && Math.abs(hit.z) < 1e-4, 'surface cell hit');
        surface.setHeights(new Float32Array(4).fill(0.2));
        hit = await surfacePick([0.25, 0.25, 0.2]);
        check(Math.abs(hit?.z - 0.2) < 1e-4, 'live surface buffer');
        surface.setHeights(new Float32Array([NaN, NaN, NaN, NaN]));
        check((await surfacePick([0, 0, 0])) === null, 'NaN surface hole');
        sp.dispose();
        sf.dispose();
        fig.dispose();
        pick.dispose();
        canvas.remove();

        // Existing openly licensed 2MASS positions, repeated only when testing the u32 ID boundary.
        const stars = new Float32Array(
          await new Response(
            new Blob([await (await fetch('/examples/assets/sciviz/stars.bin')).arrayBuffer()])
              .stream()
              .pipeThrough(new DecompressionStream('gzip')),
          ).arrayBuffer(),
        );
        const canvas2 = document.createElement('canvas');
        canvas2.width = 256;
        canvas2.height = 192;
        canvas2.style.cssText = canvas.style.cssText;
        document.body.append(canvas2);
        let f = await create(canvas2, {
          axes: false,
          controls: false,
          mode: '2d',
          margin: { top: 0, left: 0, right: 0, bottom: 0 },
          limits: [0, 360, -90, 90],
        });
        f.engine.stop();
        const count = stars.length / 4,
          positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          positions[i * 3] = stars[i];
          positions[i * 3 + 1] = stars[count + i];
        }
        const cloud = await f.scatter({ positions });
        let picker = new GpuPicking(f);
        await f.ready();
        f.render();
        let matches = 0;
        for (const index of [100, 1000, 10000]) {
          const p = projectPoint(
            dataToClip(f.engine.camera.matrix, f.model),
            positions[index * 3],
            positions[index * 3 + 1],
            0,
            256,
            192,
            'webgpu',
          );
          const cpu = f.pick(p.x, p.y, { radius: 0.01 }),
            gpu = await picker.pick(p.x, p.y, { radius: 0.01 });
          check(cpu?.index === gpu?.index && gpu !== null, '2MASS CPU/GPU exact-centre match');
          matches++;
        }
        f.remove(cloud);
        const ct = await (await fetch('/examples/assets/sciviz/clip/source.json')).json();
        const samples = new Int16Array(
          await (await fetch('/examples/assets/sciviz/clip/ct-org-0-samples.bin')).arrayBuffer(),
        );
        const ctData = Float32Array.from(samples, (v) => v * ct.slope + ct.intercept);
        // The volume's own source metadata specifies the downsampled dimensions.
        const dims = ct.dims ?? ct.dimensions;
        check(Array.isArray(dims), 'CT source dimensions');
        picker.dispose();
        f.dispose();
        f = await create(canvas2, { axes: false, controls: false });
        f.engine.stop();
        f.engine.camera.position = [0, 0, 4];
        f.engine.camera.target = [0, 0, 0];
        picker = new GpuPicking(f);
        const mesh = meshLayer(f, {
          positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
          normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          values: new Float32Array([7, 7, 7]),
          cells: new Uint32Array([0x1000001]),
          bounds: [-1, 1, -1, 1, 0, 0],
        });
        f.engine.camera.position = [0, 4, 0];
        f.engine.camera.up = [0, 0, -1];
        await f.ready();
        f.render();
        const meshHit = await picker.pick(128, 96);
        check(
          meshHit?.index === 0x1000001 && Math.abs(meshHit.value - 7) < 1e-5,
          'unstructured source cell exceeds 24-bit ID',
        );
        mesh.update({positions:new Float32Array(),normals:new Float32Array(),values:new Float32Array(),cells:new Uint32Array(),bounds:[-1,1,-1,1,0,0]});
        check(await picker.pick(128,96)===null,'empty updated mesh misses');
        mesh.update({positions:new Float32Array([-1,-1,0,1,-1,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),values:new Float32Array([7,7,7]),cells:new Uint32Array([0x1000001]),bounds:[-1,1,-1,1,0,0]});
        check((await picker.pick(128,96))?.index===0x1000001,'empty mesh can grow and remain pickable');
        f.remove(mesh);
        f.engine.camera.position = [0, 0, 4];
        f.engine.camera.up = [0, 1, 0];
        const volume = f.volume(ctData, {
          dims,
          range: [-1000, 1000],
          opacity: (t) => (t > 0.1 ? 0.1 : 0),
          quality: 2,
          shading: false,
        });
        await f.ready();
        f.render();
        const qx = 127.25,
          qy = 95.25;
        let volumeHit = await picker.pick(qx, qy);
        check(
          volumeHit?.kind === 'volume' && volumeHit.index >= 0 && volumeHit.index < ctData.length,
          'TCIA first hit',
        );
        // Independent CPU trilinear reference over half-float normalized samples, following texture coordinates.
        const half = new Float16Array(Float32Array.from(ctData, (v) => (v + 1000) / 2000));
        const sample = (at) => {
          const ij = at.map((v, a) => v * dims[a] - 0.5),
            lo = ij.map(Math.floor),
            fraction = ij.map((v, a) => v - lo[a]);
          let out = 0;
          for (let z = 0; z < 2; z++)
            for (let y = 0; y < 2; y++)
              for (let x = 0; x < 2; x++) {
                const bit = [x, y, z],
                  p = lo.map((v, a) => Math.max(0, Math.min(dims[a] - 1, v + bit[a])));
                const weight = bit.reduce((v, b, a) => v * (b ? fraction[a] : 1 - fraction[a]), 1);
                out += half[(p[2] * dims[1] + p[1]) * dims[0] + p[0]] * weight;
              }
          return out;
        };
        const ray = screenRay(dataToClip(f.engine.camera.matrix, volume.model), 256, 192, qx, qy);
        let enter = 0,
          exit = Infinity;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(ray.direction[a]) < 1e-20) {
            check(ray.origin[a] >= 0 && ray.origin[a] <= 1, 'CPU parallel slab');
            continue;
          }
          const a0 = -ray.origin[a] / ray.direction[a],
            a1 = (1 - ray.origin[a]) / ray.direction[a];
          enter = Math.max(enter, Math.min(a0, a1));
          exit = Math.min(exit, Math.max(a0, a1));
        }
        const stride = Math.max(1 / Math.max(...dims) / 2, (exit - enter) / 2048),
          table = volume.classificationData().rgba;
        let reference;
        for (let k = 0; k < 2048; k++) {
          const t = enter + (k + 0.5) * stride;
          if (t >= exit) break;
          const at = ray.origin.map((v, a) => v + ray.direction[a] * t),
            v = sample(at),
            tf = v * 256 - 0.5,
            i = Math.floor(tf),
            mix = tf - i;
          const alpha =
            (table[Math.max(0, Math.min(255, i)) * 4 + 3] * (1 - mix) +
              table[Math.max(0, Math.min(255, i + 1)) * 4 + 3] * mix) /
            255;
          if (1 - (1 - Math.min(0.999, alpha)) ** (stride * Math.max(...dims)) < 0.002) continue;
          const ijk = at.map((v, a) => Math.min(dims[a] - 1, Math.floor(v * dims[a])));
          reference = { index: (ijk[2] * dims[1] + ijk[1]) * dims[0] + ijk[0], value: -1000 + 2000 * v };
          break;
        }
        check(
          reference && volumeHit.index === reference.index && Math.abs(volumeHit.value - reference.value) < 0.1,
          `independent TCIA CPU ray matches GPU ${JSON.stringify({ reference, volumeHit: { index: volumeHit.index, value: volumeHit.value, x: volumeHit.x, y: volumeHit.y, z: volumeHit.z }, ray })}`,
        );
        const before = volumeHit.index;
        await f.engine.rebootDevice();
        await f.renderer.ready();
        f.render();
        volumeHit = await picker.pick(qx, qy);
        check(volumeHit?.index === before, 'device restore');
        volume.visible = false;
        check((await picker.pick(128, 96)) === null, 'hidden volume');
        volume.visible = true;
        volume.density = 0;
        check((await picker.pick(128, 96)) === null, 'zero density');
        volume.density = 1;
        volume.clip = [{ normal: [0, 0, 0], offset: -1 }];
        check((await picker.pick(128, 96)) === null, 'fully clipped volume');
        volume.clip = [];
        // Opacity 1 is opaque over a step of any length, so the strictest threshold (1) still hits (KB5700a).
        f.remove(volume);
        const opaque = f.volume(ctData, { dims, range: [-1000, 1000], opacity: () => 1, quality: 2, shading: false });
        await f.ready();
        f.render();
        check((await picker.pick(128, 96, { opacityThreshold: 1 }))?.kind === 'volume', 'opacity 1 meets threshold 1');
        f.remove(opaque);
        picker.dispose();
        f.dispose();
        canvas2.remove();
        check(gpuErrors.length === 0, gpuErrors.join(';'));
        return {
          fallback,
          stars: count,
          matches,
          ctVoxels: ctData.length,
          firstVoxel: before,
          readbackBytes: 256,
          cpuProjectionsPerQuery: 0,
        };
      } finally {
        pick.dispose();
        fig.dispose();
        canvas.remove();
      }
    }, fallback);
    reports.push(report);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(report));
    await browser.page.goto(
      new URL(`/examples/sciviz-pick-gpu.html${fallback ? '?backend=webgl2' : ''}`, browser.page.url()).href,
    );
    await Promise.race([
      browser.page.waitForFunction(() => !document.querySelector('#status').textContent.startsWith('Loading')),
      new Promise((_, reject) => browser.page.once('pageerror', reject)),
    ]);
    assert.match(await browser.page.locator('#status').textContent(), /^Ready\./);
    const demo = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-pick-gpu.ts');
      d.stars.engine.stop();
      d.ct.engine.stop();
      const hit = await d.ctPicking.pick(d.ct.engine.canvas.clientWidth / 2, d.ct.engine.canvas.clientHeight / 2);
      if (hit?.layer !== d.volume) throw new Error('demo CT first hit');
      return { stars: d.cloud.count, ctFirstVoxel: hit.index };
    });
    assert.equal(demo.stars, 1000000);
    assert.deepEqual(errors, []);
    await browser.page.screenshot({ path: `test-results/batch181-j3-demo-${fallback ? 'compat' : 'native'}.png` });
    console.log(JSON.stringify({ fallback, demo }));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/batch181-j3-picking.json', JSON.stringify(reports, null, 2) + '\n');
