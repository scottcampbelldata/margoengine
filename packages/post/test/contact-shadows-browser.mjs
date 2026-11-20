// Real-GPU check of ContactShadows, built packages.
// A box floats just above a floor. Contact shadows darken the floor under the box's sunward side and nothing far away;
// disabled, a far pixel keeps its value. Then the box leaves and the light grazes the bare floor: no pixel may darken.
// The march once took the 1x depth's own error inside a pixel for a contact (dithered acne on every lit slope), and
// which sample the 1x depth holds differs on the WebGL2 layer (MARGO_COMPAT=1 runs this page there), so the acne
// differed between the two (the Orrery's `visual:compat` row).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const timer = setTimeout(() => {
  console.error('contact-shadows-browser: timed out after 120 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 120_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/post-contact-shadows/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5349, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5349 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 }),
    errors = [];
  if (compatRun()) await page.addInitScript(compatShim);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5349/packages/post/test/contact-shadows-browser.html');
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { PostStack } = await import('/packages/post/dist/stack.js'),
      { ContactShadows } = await import('/packages/post/dist/contact-shadows.js');
    const canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 3, 5], target: [0, 0, 0] } });
    engine.stop();
    const white = new PbrMaterial({ color: '#c0c0c0', roughness: 1 });
    engine
      .createMesh()
      .setGeometry(box(20, 0.1, 20))
      .setPosition([0, -0.05, 0])
      .setMaterial(white);
    const cube = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([0, 0.55, 0])
      .setMaterial(white);
    const effect = new ContactShadows({ distance: 1.5, thickness: 2, strength: 1, steps: 32 }),
      stack = PostStack.attach(engine, [effect]);
    window.t = {
      engine,
      effect,
      stack,
      cube,
      frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
    };
  });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  await page.evaluate(() => window.t.frame());
  const on = await shot();
  await page.evaluate(() => {
    window.t.effect.options.enabled = false;
    return window.t.frame();
  });
  const off = await shot();
  let darker = 0,
    brighter = 0;
  for (let i = 0; i < on.data.length; i += 4) {
    const d = on.data[i] - off.data[i];
    if (d < -8) darker++;
    if (d > 8) brighter++;
  }
  const corner = 4 * (on.width * 8 + 8);
  console.log(JSON.stringify({ darker, brighter, corner: [on.data[corner], off.data[corner]] }));
  // The bare floor under a grazing light (about 7 degrees up), seen at a slant: nothing occludes it, so nothing darkens.
  await page.evaluate(() => {
    const t = window.t;
    t.cube.setPosition([0, -50, 0]);
    t.engine.lighting.direction.set([0.9, 0.12, 0.42]);
    t.effect.options.enabled = false;
    return t.frame();
  });
  const bare = await shot();
  await page.evaluate(() => {
    window.t.effect.options.enabled = true;
    return window.t.frame();
  });
  const grazed = await shot();
  let acne = 0;
  for (let i = 0; i < bare.data.length; i += 4)
    if (Math.max(...[0, 1, 2].map((c) => bare.data[i + c] - grazed.data[i + c])) > 2) acne++;
  console.log(JSON.stringify({ compat: compatRun(), acne }));
  await page.evaluate(() => window.t.engine.dispose());
  assert.deepEqual(errors, []);
  assert.ok(darker > 200, `contacts darken pixels: ${darker}`);
  assert.equal(brighter, 0, 'contact shadows only darken');
  assert.ok(Math.abs(on.data[corner] - off.data[corner]) <= 2, 'a far pixel with no occluder is unchanged');
  assert.equal(acne, 0, `a bare floor under a grazing light keeps every pixel: ${acne} darkened`);
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}
