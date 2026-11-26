// Real-GPU check of HeatHaze (@margoengine/post/heat-haze), built packages (KB-FLAME-HEATHAZE1): a wall of white bars
// 30 m behind the plume of a 3 m flame 25 m from a narrow (20 degree) lens, with a dark box in front of the
// plume. With the haze on, the bars behind the plume move: pixels change in the plume's column and nowhere else, the box
// in front of the plume keeps every pixel, the picture ripples as the eddies rise (two times differ), and the strength
// row scales the bend (strength 0 draws exactly the frame with the effect off). MARGO_COMPAT=1 runs it on the WebGL2
// compatibility layer.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-heat-haze',
  5467,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { HeatHaze } = await import('/packages/post/dist/heat-haze.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 3, 25], target: [0, 3, -30], fov: 20 },
      });
      engine.stop();
      const white = new PbrMaterial({ color: '#ffffff', roughness: 1 }),
        dark = new PbrMaterial({ color: '#202020', roughness: 1 });
      engine
        .createMesh()
        .setGeometry(box(60, 30, 0.2))
        .setPosition([0, 5, -30.3])
        .setMaterial(dark);
      for (let i = -40; i <= 40; i++)
        engine
          .createMesh()
          .setGeometry(box(0.25, 30, 0.2))
          .setPosition([i * 0.5, 5, -30])
          .setMaterial(white);
      // The box in front of the plume, low on its left side.
      engine
        .createMesh()
        .setGeometry(box(0.6, 0.6, 0.6))
        .setPosition([-0.4, 1.5, 6])
        .setMaterial(dark);
      const plume = { position: [0, 0, 0], length: 3, footprint: [1, 1], time: 0 },
        haze = HeatHaze.attach(engine, { sources: () => [plume] });
      window.t = {
        engine,
        haze,
        plume,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
        // The plume's screen column: its footprint plus 2.5 half-widths at the box top, projected at the plume's distance.
        project: (p) => {
          const m = engine.camera.matrix,
            c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
          return [((c[0] / c[3]) * 0.5 + 0.5) * 320, (0.5 - (c[1] / c[3]) * 0.5) * 240];
        },
      };
    });
    const t = (fn, arg) => page.evaluate(fn, arg);
    const frame = async (options) => {
      await t((o) => {
        Object.assign(window.t.haze.options, o.haze);
        window.t.plume.time = o.time;
        return window.t.frame();
      }, options);
      return shot();
    };
    const off = await frame({ haze: { enabled: false }, time: 0 }),
      zero = await frame({ haze: { enabled: true, strength: 0 }, time: 0 }),
      real = await frame({ haze: { strength: 1 }, time: 0 }),
      strong = await frame({ haze: { strength: 20 }, time: 0 }),
      later = await frame({ haze: { strength: 20 }, time: 0.5 });
    // The plume's box reaches 0.5 m (the footprint) plus 2.5 of its widest half-widths (1.1 m) either side of its axis;
    // its near corners spread widest on screen.
    const [left] = await t(() => window.t.project([-3.3, 0, 3.3])),
      [right] = await t(() => window.t.project([3.3, 0, 3.3])),
      boxA = await t(() => window.t.project([-0.7, 1.8, 6.3])),
      boxB = await t(() => window.t.project([-0.1, 1.2, 6.3]));
    const diff = (a, b, inside = () => true, levels = 0) => {
      let n = 0;
      for (let y = 0; y < a.height; y++)
        for (let x = 0; x < a.width; x++) {
          if (!inside(x, y)) continue;
          const i = 4 * (y * a.width + x);
          if (Math.max(...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c]))) > levels) n++;
        }
      return n;
    };
    const outside = (x) => x < left - 1 || x > right + 1,
      onBox = (x, y) => x > boxA[0] + 1 && x < boxB[0] - 1 && y > boxA[1] + 1 && y < boxB[1] - 1;
    const result = {
      compat: compatRun(),
      column: [left, right],
      zeroDiffers: diff(off, zero),
      real: diff(off, real, undefined, 4),
      strong: diff(off, strong, undefined, 4),
      strongOutside: diff(off, strong, outside),
      boxPixels: diff(off, off, onBox) === 0 ? (boxB[0] - boxA[0] - 2) * (boxB[1] - boxA[1] - 2) : -1,
      boxChanged: diff(off, strong, onBox),
      ripple: diff(strong, later),
    };
    console.log(JSON.stringify(result));

    assert.equal(result.zeroDiffers, 0, 'strength 0 draws the frame of the effect off');
    assert.ok(result.real > 50, `real hot air moves the bars behind the plume: ${result.real} pixels`);
    assert.ok(result.strong > 2 * result.real, `a stronger bend moves more of them: ${result.strong}`);
    assert.equal(result.strongOutside, 0, 'nothing outside the plume moves');
    assert.ok(result.boxPixels > 4, `the box in front of the plume is in view: ${result.boxPixels} pixels`);
    assert.equal(result.boxChanged, 0, 'the box in front of the plume keeps every pixel');
    assert.ok(result.ripple > 50, `the eddies rise and the picture ripples: ${result.ripple} pixels`);

    // THE-KILN-SHIFT-3: the former plume-only path had no way to read the simulated air temperature.
    const bounds = await t(async () => {
      const { HeatConduction } = await import('/packages/physics/dist/thermal.js');
      const { PhysicsWorld } = await import('/packages/physics/dist/world.js');
      const heat = await HeatConduction.load();
      const world = new PhysicsWorld({ rate: { num: 24, den: 1 } });
      const origin = [-1.2, 0, -1.6],
        dimensions = [8, 8, 8],
        cellSize = [0.3, 0.5, 0.4];
      world.add(heat, {
        dimensions,
        cellSize,
        materials: { conductivity: 0.026, heatCapacity: 1206 },
        initialTemperature: 293.15,
        boundaries: { xMin: { kind: 'flux', wattsPerSquareMetre: 100000 } },
      });
      window.t.haze.options.sources = [];
      window.t.haze.options.temperatureVolume = () => ({
        origin,
        dimensions,
        cellSize,
        kelvin: heat.readTemperature(),
      });
      window.t.world = world;
      const near = origin[2] + (dimensions[2] + 0.5) * cellSize[2];
      const left = window.t.project([origin[0] - 0.5 * cellSize[0], 0, near])[0];
      const right = window.t.project([origin[0] + (dimensions[0] + 0.5) * cellSize[0], 0, near])[0];
      return [left, right];
    });
    const ambient = await frame({ haze: { strength: 20 }, time: 0 });
    await t(() => window.t.world.advance(24 * 4));
    const heated = await frame({ haze: {}, time: 0 });
    const heatedOff = await frame({ haze: { enabled: false }, time: 0 });
    const volume = {
      compat: compatRun(),
      ambient: diff(off, ambient),
      heated: diff(ambient, heated, undefined, 4),
      disabled: diff(off, heatedOff),
      outside: diff(ambient, heated, (x) => x < bounds[0] - 1 || x > bounds[1] + 1),
      foreground: diff(ambient, heated, onBox),
    };
    console.log(JSON.stringify({ temperatureVolume: volume }));
    assert.equal(volume.ambient, 0, 'a uniform ambient field has zero optical displacement');
    assert.ok(volume.heated > 25, 'the evolved temperature field moves the background pattern');
    assert.equal(volume.disabled, 0, 'disabling the haze removes the temperature volume');
    assert.equal(volume.outside, 0, 'no bend outside the field');
    assert.equal(volume.foreground, 0, 'foreground surfaces are in front of the heated air');
    await t(() => window.t.engine.dispose());
  },
);
