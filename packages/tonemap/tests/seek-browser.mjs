// Real-GPU bound of GAP-FILM-TIME for Tonemap (built packages; node scripts/run-with-timeout.mjs -- node
// packages/tonemap/tests/seek-browser.mjs). Grain is a clock (class A): a seek from @margoengine/cutscene/seek replays
// it, so the effects uniform after the seek equals a continuous run's. Auto exposure is view history (class C): a cut
// snaps it to the metered scene on its first frame, then it follows the same filter as the continuous run, so after a
// prewarm of P frames it keeps e^(-speed P / fps) of the gap it started with (speed 1.5, P = 120: e^-3, 5 %).
// Fixture: a flat HDR source whose luminance film code sets per step, 0.05 x 2^(2.2 sin(step / 40)). A runs n + 1
// frames; B is fresh, seeks (n - P) / fps and draws P + 1 frames; B's first frame must snap to log2(0.18 / L).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from '../../post/test/post-browser.mjs';

const P = 120;
await postBrowser(
  'tonemap-seek',
  5419,
  () => launchBrowser({ headless: true }),
  async (page) => {
    for (const n of [600, 1800]) {
      const r = await page.evaluate(
        async ([n, P]) => {
          const { Engine } = await import('/packages/core/dist/index.js'),
            { Tonemap } = await import('/packages/tonemap/dist/index.js'),
            { seek } = await import('/packages/cutscene/dist/seek.js');
          const FPS = 60,
            errors = [],
            luminance = (step) => 0.05 * 2 ** (2.2 * Math.sin(step / 40));
          async function world() {
            const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 });
            document.body.append(canvas);
            const engine = await Engine.create(canvas, { backend: 'webgpu' }),
              device = engine.gpu;
            engine.stop();
            device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
            // The source is viewport-sized, as Tonemap requires: made at the canvas size the engine drew last.
            let source,
              data,
              now = 0;
            const sized = () => {
              const W = canvas.width,
                H = canvas.height;
              if (source?.width !== W || source?.height !== H) {
                source?.destroy();
                source = device.createTexture({
                  size: [W, H],
                  format: 'rgba32float',
                  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                });
                data = new Float32Array(W * H * 4);
                fill();
              }
              return source;
            };
            // A canvas resized inside the render gets a new source holding the same step's luminance.
            const fill = () => {
              data.fill(luminance(now));
              device.queue.writeTexture({ texture: source }, data, { bytesPerRow: source.width * 16 }, [
                source.width,
                source.height,
              ]);
            };
            const tonemap = Tonemap.attach(engine, {
              curve: 'linear',
              source: sized,
              grain: 0.2,
              autoExposure: { min: -16, max: 16, speed: 1.5 },
            });
            return {
              engine,
              tonemap,
              async frame(step) {
                now = step;
                sized();
                fill();
                engine.render({ delta: 1 / FPS });
                await device.queue.onSubmittedWorkDone();
              },
              async exposure() {
                const read = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
                  e = device.createCommandEncoder();
                e.copyBufferToBuffer(tonemap.aeBuffer, 0, read, 0, 8);
                device.queue.submit([e.finish()]);
                await read.mapAsync(GPUMapMode.READ);
                const v = new Float32Array(read.getMappedRange())[0];
                read.unmap();
                read.destroy();
                return v;
              },
            };
          }
          const a = await world();
          let aStart = 0;
          for (let step = 0; step <= n; step++) {
            await a.frame(step);
            if (step === n - P) aStart = await a.exposure();
          }
          const b = await world(),
            zero = b.tonemap.time,
            result = await seek(b.engine, (n - P) / FPS, { fps: FPS });
          let bFirst = 0;
          for (let step = n - P; step <= n; step++) {
            await b.frame(step);
            if (step === n - P) bFirst = await b.exposure();
          }
          return {
            errors,
            zero,
            steps: result.steps,
            replayed: result.clocks.includes(b.tonemap.name),
            unseekable: result.unseekable,
            timeA: a.tonemap.time,
            timeB: b.tonemap.time,
            fxA: Array.from(a.tonemap.fxValues),
            fxB: Array.from(b.tonemap.fxValues),
            want: Math.log2(0.18 / luminance(n - P)),
            aStart,
            bFirst,
            aEnd: await a.exposure(),
            bEnd: await b.exposure(),
          };
        },
        [n, P],
      );
      assert.deepEqual(r.errors, [], `GPU errors at n = ${n}`);
      assert.equal(r.zero, 0);
      assert.equal(r.steps, n - P);
      assert.ok(r.replayed && r.unseekable.length === 0, `Tonemap is replayed: ${JSON.stringify(r.unseekable)}`);
      assert.ok(Object.is(r.timeB, r.timeA), 'the grain clocks agree');
      assert.deepEqual(r.fxB, r.fxA, 'the effects uniform (grain frame included) is equal after the seek');
      assert.ok(Math.abs(r.bFirst - r.want) < 0.002, `the first metered frame snaps: ${r.bFirst} against ${r.want}`);
      const gap = Math.abs(r.aStart - r.bFirst),
        left = Math.abs(r.aEnd - r.bEnd),
        bound = gap * Math.exp((-1.5 * P) / 60);
      assert.ok(gap > 0.05, `the fixture starts the prewarm with a gap: ${gap}`);
      assert.ok(left <= bound * 1.01 + 1e-4, `exposure gap ${left} stops after the prewarm; bound ${bound}`);
      console.log(
        `ok tonemap seek n = ${n}: grain equal; exposure gap ${gap.toFixed(4)} stops at the cut, ${left.toFixed(5)} after ${P} frames (bound ${bound.toFixed(5)})`,
      );
    }
  },
);
