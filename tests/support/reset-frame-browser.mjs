// Real-GPU check of GAP-FILM-RESET for one effect (built packages; WebGPU, or the WebGL2 layer with MARGO_COMPAT=1):
// after a run, a seek and resetClocks, the next frame is bit-equal to the frame of a clock that never ran.
// Three alike worlds on one page, boxes moving on a closed-form path that film code sets from its step:
//   A seeks 7.5 s with @margoengine/cutscene/seek, draws `RUN` live frames, calls resetClocks, then draws step K;
//   B does the same without resetClocks (the control: its history and clock still show in its frame);
//   C has run no frame past its warm-up and draws step K after resetClocks.
// Every world first draws the same warm-up frames of delta 0 at step 0, until its pipelines are built
// (scripts/support/gpu-ready.js); C is reset after them, which leaves a fresh clock's state (the CPU check
// tests/support/clock-reset.js proves resetTime equals a fresh one), so C's frame is the fresh frame on a device whose
// pipelines are ready. A's canvas must equal C's byte for byte, and B's must differ from it, so the check sees history.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../scripts/lib/browser.mjs';
import { postBrowser } from '../../packages/post/test/post-browser.mjs';
import { decodePNG } from './png.js';

/**
 * Runs the reset check for `effect` ('taa', 'tonemap' or 'fog') as `owner` on `port`.
 * @param {string} owner
 * @param {number} port
 * @param {'taa' | 'tonemap' | 'fog'} effect
 */
export async function resetFrameCheck(owner, port, effect) {
  await postBrowser(
    owner,
    port,
    () => launchBrowser({ headless: true }),
    async (page) => {
      const r = await page.evaluate(async (effect) => {
        const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js'),
          { seek, resetClocks } = await import('/packages/cutscene/dist/seek.js'),
          { trackPipelines, waitForPipelines } = await import('/scripts/support/gpu-ready.js');
        trackPipelines();
        const FPS = 60,
          RUN = 240,
          K = 777,
          errors = [];
        document.querySelector('#view').remove();
        async function world(id) {
          const canvas = Object.assign(document.createElement('canvas'), {
            id,
            width: 96,
            height: 72,
          });
          canvas.style.cssText = 'display:inline-block;width:96px;height:72px';
          document.body.append(canvas);
          const engine = await Engine.create(canvas, {
              backend: 'webgpu',
              camera: {
                position: [0, 2, 7],
                target: [0, 0.5, 0],
                near: 0.1,
                far: 100,
              },
            }),
            device = engine.gpu;
          engine.stop();
          device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
          let clock;
          if (effect === 'taa') {
            const { TAA } = await import('/packages/taa/dist/index.js');
            clock = TAA.attach(engine, { historyWeight: 0.9 });
          } else if (effect === 'tonemap') {
            const { Tonemap } = await import('/packages/tonemap/dist/index.js');
            clock = Tonemap.attach(engine, {
              grain: 0.2,
              autoExposure: { min: -8, max: 8, speed: 1.5 },
            });
          } else {
            // The fog reads the scene depth of a post capture: a Tonemap with no grain or auto exposure, so nothing
            // in its frame depends on time or history.
            const { Tonemap } = await import('/packages/tonemap/dist/index.js'),
              { VolumetricFog } = await import('/packages/environment/dist/volumetric.js');
            Tonemap.attach(engine);
            clock = VolumetricFog.attach(engine, {
              density: 0.08,
              heightFalloff: 0.3,
              noise: 0.8,
              noiseScale: 2,
              wind: [0.7, 0, 0.4],
              temporal: 0.9,
              grid: [16, 12, 32],
              range: 40,
            });
          }
          engine
            .createMesh()
            .setGeometry(box(8, 0.05, 8))
            .setMaterial(new PbrMaterial({ color: '#404040', roughness: 1 }))
            .setPosition([0, -0.25, 0]);
          const boxes = [0, 1, 2].map((i) =>
            engine
              .createMesh()
              .setGeometry(box(0.6, 0.6 + 0.3 * i, 0.6))
              .setMaterial(
                new PbrMaterial({
                  color: ['#c04020', '#20c040', '#2040c0'][i],
                  roughness: 1,
                }),
              ),
          );
          const draw = async (step, delta = 1 / FPS) => {
            boxes.forEach((m, i) =>
              m.setPosition([2.2 * Math.sin(step / 37 + i * 2.1), 0.3 * i, 1.5 * Math.cos(step / 53 + i)]),
            );
            engine.render({ delta });
            await device.queue.onSubmittedWorkDone();
          };
          return { id, engine, clock, draw };
        }
        const worlds = [await world('a'), await world('b'), await world('c')];
        // Pipelines build on warm-up frames of delta 0 at step 0; every world draws as many of them.
        const counts = [];
        for (const w of worlds) {
          let n = 0;
          await waitForPipelines(async () => {
            n++;
            await w.draw(0, 0);
          });
          counts.push(n);
        }
        const most = Math.max(...counts);
        for (const [i, w] of worlds.entries()) for (let k = counts[i]; k < most; k++) await w.draw(0, 0);
        const [a, b, c] = worlds,
          out = { errors, name: a.clock.name, warm: most };
        for (const w of [a, b]) {
          const s = await seek(w.engine, 7.5, { fps: FPS });
          out[`${w.id}Seek`] = {
            steps: s.steps,
            replayed: s.clocks.includes(w.clock.name),
          };
          for (let step = 450; step < 450 + RUN; step++) await w.draw(step);
        }
        const resets = [a, c].map((w) => resetClocks(w.engine));
        out.reset = resets.map((x) => x.clocks.includes(a.clock.name));
        out.time = [a, b, c].map((w) => w.clock.time);
        for (const w of worlds) await w.draw(K);
        return out;
      }, effect);
      const pixels = async (id) => (await decodePNG(await page.locator(`#${id}`).screenshot())).data;
      const a = await pixels('a'),
        b = await pixels('b'),
        c = await pixels('c');
      const differ = (x, y) => x.length !== y.length || x.some((v, i) => v !== y[i]);
      assert.deepEqual(r.errors, [], `${effect}: GPU errors`);
      assert.deepEqual(r.aSeek, { steps: 450, replayed: true }, `${effect}: the seek replays it`);
      assert.deepEqual(r.reset, [true, true], `${effect}: resetClocks resets it`);
      assert.deepEqual([r.time[0], r.time[2]], [0, 0], `${effect}: A's clock restarts as C's: ${r.time}`);
      assert.ok(r.time[1] > 0, `${effect}: B's clock kept running: ${r.time}`);
      assert.ok(!differ(a, c), `${effect}: the frame after seek and reset is bit-equal to a fresh clock's`);
      assert.ok(differ(b, c), `${effect}: without the reset the frame differs (the check sees history and time)`);
      console.log(
        `ok ${effect} reset: after ${r.warm} warm-up frames, a 450-step seek and 240 frames, resetClocks gives a frame bit-equal to a fresh clock's; the unreset control differs`,
      );
    },
  );
}
