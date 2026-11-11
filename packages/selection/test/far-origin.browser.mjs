// Colour and pick coverage agree at the edges of a mesh 100 km from the world origin when a FloatingOrigin
// (@margoengine/cameras/origin) keeps the camera and the placed root near local zero. Without it, the model and camera
// translations round to float32 in world space, and the colour and pick shaders, compiled from different code without
// @invariant, may round an edge pixel differently (docs/limits.md, "Raster coverage far from the origin").
// Each run draws a rotated box on a 64 x 64 canvas without MSAA (exactSize), takes the colour coverage (pixels that
// change when the box is shown) and picks every pixel centre with Picking.pickMany, with the forward-pass ID target and
// with the separate 3 x 3 pass (capture: false). A pick answers the centre's ID, else a neighbour's, so the picked set
// must equal the colour coverage grown by one pixel (8 neighbours). Near the origin and with the floating origin the two
// sets must be equal; at 1e5 without it the count of disagreeing pixels is printed for the limits row, not asserted.
// Run from the repository root after `npm run build:packages`: npm run test:browser:far-origin --workspace packages/selection
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

/** Colour and pick coverage of the box placed at `world`, seen from `world + [0, 0.6, 2.4]`. */
const run = (world, floating, capture) =>
  page.evaluate(
    async ({ world, floating, capture }) => {
      const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js'),
        { Picking } = await import('/packages/selection/dist/index.js'),
        { FloatingOrigin } = await import('/packages/cameras/dist/origin.js');
      const size = 64,
        canvas = document.createElement('canvas');
      canvas.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px`;
      canvas.width = canvas.height = size;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { backend: 'webgpu', exactSize: true }),
        gpuErrors = [];
      engine.gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
      const picking = Picking.attach(engine, { capture }),
        mesh = engine
          .createMesh()
          .setGeometry(box())
          .setMaterial(new PbrMaterial({ color: '#e0e0e0', roughness: 0.5 }))
          .setRotation([0.37, 0.71, 0.23]);
      const eye = [world[0], world[1] + 0.6, world[2] + 2.4];
      if (floating) {
        const origin = FloatingOrigin.attach(engine);
        origin.place(mesh, world);
        origin.lookAt(eye, world);
        origin.rebase();
      } else {
        mesh.setPosition(world);
        engine.camera.position = eye;
        engine.camera.target = world;
      }
      const shot = () => {
        engine.render({ culling: false });
        const copy = document.createElement('canvas');
        copy.width = copy.height = size;
        const context = copy.getContext('2d', { willReadFrequently: true });
        context.drawImage(engine.canvas, 0, 0);
        return context.getImageData(0, 0, size, size).data;
      };
      // Pipelines compile off the frame: draw until two frames agree.
      let lit = shot();
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await engine.gpu.queue.onSubmittedWorkDone();
        const next = shot(),
          same = next.every((v, k) => v === lit[k]);
        lit = next;
        if (same && i > 2) break;
      }
      mesh.visible = false;
      const empty = shot();
      mesh.visible = true;
      shot();
      const points = [];
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) points.push([x + 0.5, y + 0.5]);
      const hits = await picking.pickMany(points);
      const covered = (x, y) => {
        const i = (y * size + x) * 4;
        return (
          x >= 0 &&
          y >= 0 &&
          x < size &&
          y < size &&
          (lit[i] !== empty[i] || lit[i + 1] !== empty[i + 1] || lit[i + 2] !== empty[i + 2])
        );
      };
      let colour = 0,
        picked = 0,
        colourOnly = 0,
        pickOnly = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          let grown = false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) grown ||= covered(x + dx, y + dy);
          const p = hits[y * size + x]?.mesh === mesh;
          colour += +covered(x, y);
          picked += +p;
          if (grown && !p) colourOnly++;
          if (p && !grown) pickOnly++;
        }
      picking.dispose?.();
      engine.dispose();
      canvas.remove();
      return { colour, picked, colourOnly, pickOnly, gpuErrors };
    },
    { world, floating, capture },
  );

try {
  await page.waitForFunction(() => window.modern);
  const far = [100000.37, 20000.11, -100000.29],
    results = {};
  for (const capture of [true, false]) {
    const mode = capture ? 'forward' : 'pass';
    results[`near-${mode}`] = await run([0.37, 0.11, -0.29], false, capture);
    results[`floating-${mode}`] = await run(far, true, capture);
    results[`plain-${mode}`] = await run(far, false, capture);
  }
  console.log(JSON.stringify({ adapter: hardware?.webgpu, results }));
  assert.deepEqual(errors, []);
  for (const [name, r] of Object.entries(results)) assert.deepEqual(r.gpuErrors, [], name);
  // The box fills a good part of the view in every run.
  for (const [name, r] of Object.entries(results)) assert.ok(r.colour > 400, `${name} draws the box (${r.colour} px)`);
  for (const name of Object.keys(results).filter((n) => !n.startsWith('plain')))
    assert.deepEqual(
      [results[name].colourOnly, results[name].pickOnly],
      [0, 0],
      `${name}: the picked pixels are the colour coverage grown by one pixel`,
    );
  console.log(
    `far-origin.browser: colour and pick coverage agree near the origin and at 1e5 with FloatingOrigin; ` +
      `without it ${results['plain-forward'].colourOnly + results['plain-forward'].pickOnly} (forward IDs) and ` +
      `${results['plain-pass'].colourOnly + results['plain-pass'].pickOnly} (3 x 3 pass) pixels disagree`,
  );
} finally {
  await browser.close();
}
