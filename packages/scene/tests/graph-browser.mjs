import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
try {
  const feature = process.argv.includes('--tags') ? 'tags' : process.argv.includes('--clone') ? 'clone' : 'graph';
  const result = await browser.page.evaluate(async (feature) => {
    const { Engine, box, PbrMaterial } = await import('/packages/core/dist/index.js');
    const { engineRuntime } = await import('/packages/core/dist/extension.js');
    const { attach, localToWorld, worldToLocal, rotateOnAxis, translateOnAxis } = await import('/packages/scene/dist/graph.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    document.body.append(canvas);
    const engine = await Engine.create(canvas, { backend: 'webgpu', antialias: false });
    const errors = [];
    engine.onError = (error) => errors.push(String(error));
    try {
      const root = engine.createMesh(), destination = engine.createMesh().setPosition([2, 0, 0]);
      const mesh = engine.createMesh(root).setGeometry(box()).setMaterial(new PbrMaterial({ color: '#e02010' }));
      const snap = async () => {
        engine.render();
        await engine.gpu.queue.onSubmittedWorkDone();
        if (globalThis.__margoPipelines?.pending) throw new Error('Pipeline did not settle');
        engine.render();
        await engine.gpu.queue.onSubmittedWorkDone();
        const target = document.createElement('canvas');
        target.width = target.height = 128;
        const ctx = target.getContext('2d');
        // Native canvas copies must be submitted in the same task as presentation.
        if (!globalThis.__margoCompat) engine.render();
        ctx.drawImage(canvas, 0, 0);
        return [...ctx.getImageData(0, 0, 128, 128).data];
      };
      const before = await snap();
      let drawing = mesh;
      if (feature === 'clone') {
        const { cloneSubtree } = await import('/packages/scene/dist/clone.js');
        const { children } = await import('/packages/scene/dist/index.js');
        const copied = cloneSubtree(root);
        drawing = children(copied)[0];
        if (drawing.geometry !== mesh.geometry || drawing.material !== mesh.material) throw new Error('clone did not share resources');
        mesh.dispose(); root.dispose();
      } else if (feature === 'tags') {
        const { tags, queryTags, SceneEvents } = await import('/packages/scene/dist/tags.js');
        const { cloneSubtree } = await import('/packages/scene/dist/clone.js');
        tags(mesh).add('renderable', 'red');
        if (queryTags(engine.scene, 'renderable && red')[0] !== mesh) throw new Error('tag query missed rendered mesh');
        const observer = new SceneEvents(engine);
        let added = 0, disposed = 0;
        observer.on('added', (event) => {
          if (event.mesh !== mesh) return;
          if (localToWorld(mesh, [0, 0, 0]).some((v) => Math.abs(v) > 1e-6)) throw new Error('listener saw unfinished attach');
          added++;
        });
        observer.on('disposed', () => disposed++);
        attach(destination, mesh);
        const copy = cloneSubtree(mesh);
        if (!tags(copy).has(['renderable', 'red'])) throw new Error('clone lost tags');
        copy.dispose();
        if (added !== 1 || disposed !== 1) throw new Error('lifecycle did not cover mutations');
        mesh.visible = queryTags(engine.scene, 'renderable && !hidden').includes(mesh);
        observer.dispose();
      } else attach(destination, mesh);
      const after = await snap();
      const p = [1, 2, 3], recovered = worldToLocal(drawing, localToWorld(drawing, p));
      rotateOnAxis(drawing, [0, 1, 0], Math.PI / 2);
      translateOnAxis(drawing, [0, 0, 1], 0.25);
      await snap();
      return { before, after, recovered, visible: engineRuntime(engine).stats.visible, errors,
        compat: !!globalThis.__margoCompat };
    } finally { engine.dispose(); canvas.remove(); }
  }, feature);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(result.after, result.before, `${feature} changes no rendered pixel`);
  assert.ok(result.before.some((v, i) => i % 4 === 0 && v > result.before[i+1] + 15), 'red geometry rendered');
  assert.deepEqual(result.recovered, [1, 2, 3]);
  assert.equal(result.visible, 1);
  delete result.before; delete result.after;
  await mkdir('test-results/batch226', { recursive: true });
  await writeFile(`test-results/batch226/${feature}-${result.compat ? 'compat' : 'webgpu'}.json`, JSON.stringify(result, null, 2));
  console.log(result);
} finally { await browser.close(); }
