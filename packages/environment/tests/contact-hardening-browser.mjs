// Real-GPU frames of roughness-driven planar reflections with contact hardening, built packages. Three thin white
// posts stand on a mirror floor over a dark background. Each frame is measured on the screenshot: the spread (in
// pixels) of a post's reflection just below its foot and below its top. A sharp mirror keeps both narrow; a rough floor
// with `contactHardening` keeps the foot narrow and spreads the top (the cone widens with distance from the floor);
// the same roughness without it spreads both alike. PBRReflector takes the same cone. Run from the repository root,
// with --compat for the WebGL2 compatibility layer; the frames land in test-results/contact-hardening-*.png.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../../../tests/support/png.js';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  backend = hardware?.compat ? 'compat' : 'webgpu',
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  const points = await page.evaluate(async () => {
    const { EngineKernel, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { Reflector } = await import('/packages/environment/dist/reflector.js');
    const { PBRReflector } = await import('/packages/environment/dist/reflector-pbr.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:240px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 8,
      camera: { position: [0, 2.5, 9], target: [0, -0.4, 0], near: 0.1, far: 100 },
    });
    engine.stop();
    engine.gpu.pushErrorScope('validation');
    for (const x of [-1.5, 0, 1.5])
      engine
        .createMesh()
        .setGeometry(box(0.15, 2, 0.15))
        .setMaterial(new PbrMaterial({ color: '#ffffff', emissive: [4, 4, 4], roughness: 1 }))
        .setPosition([x, 1, 0]);
    let floor;
    window.frame = (kind, options) => {
      floor?.dispose();
      const Kind = kind === 'pbr' ? PBRReflector : Reflector;
      floor = Kind.attach(engine, { width: 20, height: 20, autoUpdate: false, ...options });
      floor.node.setRotation([-Math.PI / 2, 0, 0]);
      engine.render({ delta: 0 });
      floor.update();
      engine.render({ delta: 0 });
    };
    window.finish = async () => {
      await engine.gpu.queue.onSubmittedWorkDone();
      const error = await engine.gpu.popErrorScope();
      floor?.dispose();
      engine.dispose();
      return error?.message;
    };
    engine.render({ delta: 0 });
    const m = engine.camera.matrix,
      project = (p) => {
        const c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
        return [((c[0] / c[2]) * 0.5 + 0.5) * canvas.width, (0.5 - (c[1] / c[2]) * 0.5) * canvas.height];
      };
    // Mirrored points of each post: just below the foot (0.08 under the floor) and near the top (1.8).
    return [-1.5, 0, 1.5].map((x) => ({ foot: project([x, -0.08, 0]), top: project([x, -1.8, 0]) }));
  });
  /** Spread of a reflected post: area over peak of the luma profile across it, pixels. */
  const spread = (image, [cx, cy]) => {
    const y = Math.round(cy),
      row = [];
    for (let x = Math.round(cx) - 24; x <= Math.round(cx) + 24; x++) {
      const i = (y * image.width + x) * 4;
      row.push(0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]);
    }
    const low = Math.min(...row),
      high = Math.max(...row);
    assert.ok(high - low > 8, `a post's reflection shows at ${cx}, ${cy}: contrast ${high - low}`);
    return row.reduce((sum, v) => sum + v - low, 0) / (high - low);
  };
  const frame = async (name, kind, options) => {
    await page.evaluate(([kind, options]) => window.frame(kind, options), [kind, options]);
    const image = await decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/contact-hardening-${name}-${backend}.png` }),
    );
    const at = (key) => points.reduce((sum, p) => sum + spread(image, p[key]), 0) / points.length;
    return { foot: at('foot'), top: at('top') };
  };
  const mirror = await frame('mirror', 'reflector', {}),
    cone = await frame('rough', 'reflector', { roughness: 0.3, contactHardening: true }),
    uniform = await frame('uniform', 'reflector', { roughness: 0.3 }),
    pbr = await frame('pbr', 'pbr', {
      roughness: 0.3,
      contactHardening: true,
      baseColor: '#ffffff',
      metalness: 1,
    }),
    validation = await page.evaluate(() => window.finish());
  const report = { hardware, backend, mirror, cone, uniform, pbr, validation };
  console.log(JSON.stringify(report));
  await writeFile(`test-results/contact-hardening-${backend}.json`, JSON.stringify(report, null, 2));
  assert.equal(validation, undefined);
  assert.deepEqual(errors, []);
  assert.ok(mirror.top < mirror.foot * 1.5, 'a mirror keeps the whole post sharp');
  for (const [name, r] of [
    ['Reflector', cone],
    ['PBRReflector', pbr],
  ]) {
    assert.ok(r.foot < mirror.foot * 1.6, `${name}: the contact stays sharp: ${r.foot} vs mirror ${mirror.foot}`);
    assert.ok(r.top > mirror.top * 1.6, `${name}: the far end blurs: ${r.top} vs mirror ${mirror.top}`);
    assert.ok(r.top > r.foot * 1.3, `${name}: blur grows with distance from the floor: ${r.foot} to ${r.top}`);
  }
  assert.ok(uniform.foot > cone.foot * 1.3, 'without contactHardening the contact blurs like the rest');
} finally {
  await browser.close();
}
