// Real-GPU check of @margoengine/humans/fit (WebGPU, or the WebGL2 compatibility layer with MARGO_COMPAT=1): the rigged
// test body of rigged-body.js (bright magenta skin) loads through gltf/pbr, addPerson poses it by its clip, and
// dressPerson puts the 1910 townsman's outfit on it in one call. In the rest pose and in the clip's pose (arms lowered,
// elbows bent) the dressed body is drawn, then the outfit's outside alone (its outer faces, hem bands and trim, back
// faces culled, skinned to the same skeleton; the body hidden): inside that outside's silhouette (shrunk by 2 pixels)
// no magenta body pixel may show, so no part of the body pokes through the clothes while it moves. The inside of the
// clothes is left out of the silhouette because the body rightly hides it where it shows through an opening (the hat
// band behind the head). The outfit's silhouette must change with the pose (the clothes follow the skeleton). The frames go
// to test-results/fit-still/ for review. From the repository root after building packages:
//   node packages/humans/test/fit-still.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/humans/test/person-still.html', port: 'free' }),
  { page } = browser,
  pageErrors = [],
  device = browser.hardware?.compat ? 'compat' : 'webgpu';
page.on('pageerror', (e) => pageErrors.push(e.message));
console.log('device', device === 'compat' ? 'webgl2-compat layer' : 'webgpu');
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 180000 });
  const frames = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { parseGLTFAsync } = await import('/packages/gltf/dist/pbr.js');
    const { Shadows } = await import('/packages/shadows/dist/index.js');
    const { addPerson } = await import('/packages/humans/dist/index.js');
    const { dressPerson, fittedOutfitGLB, FACE } = await import('/packages/humans/dist/fit.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { dualQuaternionSkinning } = await import('/packages/animation/dist/dqs.js');
    const { riggedTestGLB } = await import('/packages/humans/test/rigged-body.js');
    const canvas = document.querySelector('canvas');
    const engine = await Engine.create(canvas, {
      camera: { position: [0.6, 1.35, 3.9], target: [0, 0.88, 0], fov: 36, near: 0.05, far: 100 },
    });
    engine.stop();
    const errors = [];
    engine.gpu?.addEventListener?.('uncapturederror', (e) => errors.push(e.error.message));
    // A green no period cloth wears: the outfit's mask is every pixel that differs from it, and a dark suit is
    // within the mask's threshold of a dark grey (the dark worsted townsman covered 10,218 pixels against #30333a).
    engine.scene.background = '#2a8c3c';
    engine.lighting.direction.set([0.5, 0.6, 0.62, 3]);
    engine.lighting.radiance.set([1, 0.95, 0.88, 0.45]);
    Shadows.attach(engine, { resolution: 1024 });
    const model = await parseGLTFAsync(engine, riggedTestGLB('T'));
    const person = await addPerson(engine, model);
    person.playing = false;
    const dressed = await dressPerson(engine, person, 'townsman-1910');
    // The outside of the same fit: inner faces dropped, back faces culled, skinned to the same skeleton.
    const fit = dressed.fit,
      outside = {
        ...fit,
        garments: fit.garments.map((g) => {
          const keep = [];
          for (let t = 0; t < g.faces.length; t++) if (g.faces[t] !== FACE.inner) keep.push(t);
          return {
            ...g,
            indices: Uint32Array.from(
              keep.flatMap((t) => [g.indices[t * 3], g.indices[t * 3 + 1], g.indices[t * 3 + 2]]),
            ),
            faces: Uint8Array.from(keep.map((t) => g.faces[t])),
          };
        }),
      };
    let glb = fittedOutfitGLB(model, outside);
    {
      const view = new DataView(glb.buffer, glb.byteOffset),
        length = view.getUint32(12, true),
        doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
      for (const m of doc.materials) delete m.doubleSided; // glTF's default: back faces culled
      const text = new TextEncoder().encode(JSON.stringify(doc));
      glb = glb.slice();
      glb.fill(0x20, 20, 20 + length);
      glb.set(text, 20);
    }
    const shell = await parseGLTFAsync(engine, glb);
    shell.root.setParent(model.root);
    const shellSkin = new Animation(shell, { skeleton: model, skinning: dualQuaternionSkinning });
    engine.use(shellSkin, engine.sceneOf(model) ?? model.root.scene);
    const show = (m, on) => {
      for (const p of m.primitives) p.node.visible = on;
    };
    const shot = async () => {
      for (let i = 0; i < 4; i++) {
        engine.render({ delta: 1 / 30 });
        await engine.gpu?.queue?.onSubmittedWorkDone?.();
      }
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      return [...new Uint8Array(await blob.arrayBuffer())];
    };
    const out = { garments: dressed.model.primitives.map((p) => p.material?.name), pose: dressed.fit.pose };
    for (const [name, time] of [
      ['rest', 0],
      ['posed', 0.99],
    ]) {
      person.time = time;
      show(model, true);
      show(dressed.model, true);
      show(shell, false);
      const on = await shot();
      show(model, false);
      show(dressed.model, false);
      show(shell, true);
      out[name] = { on, off: await shot() };
    }
    dressed.dispose();
    dressed.dispose();
    out.after = engine.plugins.has(dressed.animation.name);
    engine.dispose();
    out.errors = errors;
    return out;
  });
  assert.deepEqual(frames.errors, []);
  assert.equal(frames.pose, 'T');
  assert.deepEqual([...frames.garments].sort(), ['boots', 'coat', 'hat', 'shirt', 'tie', 'trousers', 'vest']);
  const dir = 'test-results/fit-still';
  await mkdir(dir, { recursive: true });
  const back = [0x2a, 0x8c, 0x3c],
    masks = {};
  for (const name of ['rest', 'posed']) {
    await writeFile(`${dir}/townsman-${name}-${device}.png`, new Uint8Array(frames[name].on));
    await writeFile(`${dir}/townsman-${name}-outfit-${device}.png`, new Uint8Array(frames[name].off));
    const on = await decodePNG(new Uint8Array(frames[name].on)),
      off = await decodePNG(new Uint8Array(frames[name].off)),
      { width, height } = on,
      channels = on.data.length / (width * height),
      cloth = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * channels;
      cloth[i] =
        Math.abs(off.data[o] - back[0]) + Math.abs(off.data[o + 1] - back[1]) + Math.abs(off.data[o + 2] - back[2]) > 24
          ? 1
          : 0;
    }
    // The outfit's silhouette shrunk by 2 pixels: its edge pixels may blend with the body beyond.
    const inner = new Uint8Array(width * height);
    for (let y = 2; y < height - 2; y++)
      for (let x = 2; x < width - 2; x++) {
        let all = 1;
        for (let dy = -2; dy <= 2 && all; dy++)
          for (let dx = -2; dx <= 2 && all; dx++) all = cloth[(y + dy) * width + x + dx];
        inner[y * width + x] = all;
      }
    let covered = 0,
      body = 0,
      through = 0;
    for (let i = 0; i < width * height; i++) {
      const o = i * channels,
        r = on.data[o],
        g = on.data[o + 1],
        b = on.data[o + 2],
        magenta = r > g + 40 && b > g + 25 && r > 60;
      if (inner[i]) covered++;
      if (magenta) body++;
      if (magenta && inner[i]) through++;
    }
    masks[name] = cloth;
    console.log(
      name,
      'outfit covers',
      covered,
      'pixels; body shows',
      body,
      'pixels; body through the outfit',
      through,
      'pixels',
    );
    assert.ok(covered > width * height * 0.06, `${name}: the outfit fills the frame`);
    assert.ok(body > 300, `${name}: the head and hands show`);
    assert.equal(through, 0, `${name}: no body pixel inside the outfit`);
  }
  let moved = 0;
  for (let i = 0; i < masks.rest.length; i++) if (masks.rest[i] !== masks.posed[i]) moved++;
  console.log('the outfit silhouette changes over', moved, 'pixels between rest and pose');
  assert.ok(moved > masks.rest.length * 0.01, 'the outfit follows the skeleton into the pose');
  assert.equal(frames.after, false, 'dispose takes the outfit off and stops its skinning');
  assert.deepEqual(pageErrors, []);
  console.log('fit still check passed');
} finally {
  await browser.close();
}
