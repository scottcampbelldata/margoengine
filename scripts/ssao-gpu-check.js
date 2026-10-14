// Real-adapter check of post's SSAO under an orthographic camera and on image-based lighting (environment IBL).
// Run from the repository root after building packages, with the GPU lock held: node scripts/ssao-gpu-check.js
// `--baseline` only saves the perspective frames (run it on the previous build); a normal run compares them pixel for
// pixel when test-results/ssao-baseline/ exists, then checks orthographic and IBL occlusion.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';

const baseline = process.argv.includes('--baseline'), folder = 'test-results/ssao-baseline';
const browser = await openBrowser({startPath: '/tests/modern-game.html', port: 5233}), {page, hardware} = browser, errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => {if (m.type() === 'error') errors.push(m.text());});
try {
  await page.evaluate(async () => {
    const {Engine, PbrMaterial, box} = await import('/packages/core/dist/index.js'), {engineRuntime} = await import('/packages/core/dist/extension.js');
    const {CameraProjection} = await import('/packages/cameras/dist/index.js'), {SSAO} = await import('/packages/post/dist/index.js');
    const {Environment, EnvironmentLighting} = await import('/packages/environment/dist/index.js'), {parseGLTF} = await import('/packages/gltf-pro/dist/index.js');
    const {animatedTriangle} = await import('/tests/support/gltf-pro-fixture.js');
    // Sky-like environment: bright blue-white above, warm dark ground below.
    const sky = () => {const width = 64, height = 32, data = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {const up = Math.cos(Math.PI * (y + 0.5) / height), t = up * 0.5 + 0.5; data.set([0.25 + 1.1 * t, 0.22 + 1.2 * t, 0.2 + 1.5 * t, 1], (y * width + x) * 4);}
      return {width, height, data};};
    const gpuErrors = [];
    // A CAD-like part: floor slab, a 1 m block and a 0.5 m step against it (inner corners on the floor and between the blocks).
    window.ao = {gpuErrors, async scene({ortho, eye = [3.2, 3.4, 4.6], target = [0.4, 0.3, 0], ssao = true, enabled = true, ibl = false, model = false, light = true, ambient = 1}) {
      window.ao.current?.dispose(); document.querySelector('#ao')?.remove();
      const canvas = document.createElement('canvas'); canvas.id = 'ao'; canvas.style.cssText = 'display:block;width:400px;height:300px'; document.body.prepend(canvas);
      const engine = await Engine.create(canvas, {backend: 'webgpu', camera: {position: eye, target, fov: 45, near: 0.1, far: 100}}), runtime = engineRuntime(engine), device = runtime.gpu;
      device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
      if (ortho) engine.use(new CameraProjection({height: 5}));
      const material = new PbrMaterial({color: '#c8c8c8', roughness: 0.8});
      engine.createMesh().setGeometry(box(8, 0.2, 8)).setPosition([0, -0.1, 0]).setMaterial(material);
      engine.createMesh().setGeometry(box(1, 1, 1)).setPosition([0, 0.5, 0]).setMaterial(material);
      engine.createMesh().setGeometry(box(1, 0.5, 1)).setPosition([1, 0.25, 0]).setMaterial(material);
      if (!light) runtime.lighting.radiance.set([0, 0, 0, ambient]); else runtime.lighting.radiance[3] = ambient;
      let gltf;
      if (model) {
        const fixture = animatedTriangle();
        fixture.doc.materials = [{pbrMetallicRoughness: {baseColorFactor: [0.9, 0.5, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6}}];
        fixture.doc.nodes = [{mesh: 0, translation: [-0.8, 0.6, 0.4]}]; delete fixture.doc.skins; delete fixture.doc.animations;
        delete fixture.doc.meshes[0].primitives[0].attributes.JOINTS_0; delete fixture.doc.meshes[0].primitives[0].attributes.WEIGHTS_0;
        gltf = parseGLTF(engine, fixture.doc, fixture.buffers);
      }
      let effect;
      if (ibl) {const environment = await Environment.create(engine, sky(), {size: 32}), lighting = new EnvironmentLighting(environment); engine.use(environment).use(lighting); if (gltf) lighting.applyTo(gltf);}
      if (ssao) {effect = SSAO.attach(engine, {radius: 0.5, bias: 0.02, samples: 32}); effect.enabled = enabled; if (gltf) effect.add(gltf);}
      device.pushErrorScope('validation');
      for (let i = 0; i < 3; i++) {engine.render({culling: false}); await device.queue.onSubmittedWorkDone();}
      const error = await device.popErrorScope(); if (error) gpuErrors.push(error.message);
      window.ao.current = {dispose() {gltf?.dispose(); engine.dispose();}};
      // Pixel of a world point (canvas is 400x300 CSS px at device scale 1).
      const m = engine.camera.matrix, pixel = p => {const c = [0, 1, 3].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]); return [Math.round((c[0] / c[2] * 0.5 + 0.5) * 400), Math.round((0.5 - c[1] / c[2] * 0.5) * 300)];};
      return {matrix: [...m], points: {
        crease: pixel([-0.2, 0.02, 0.56]),        // floor just in front of the 1 m block's base
        step: pixel([0.62, 0.53, 0.1]),           // top of the step, against the 1 m block's side
        open: pixel([-2.4, 0, 2.6]),              // open floor, far from both blocks
        top: pixel([-0.1, 1, 0.1]),               // top face of the 1 m block
        face: pixel([-0.2, 0.75, 0.5]),           // upper front face of the 1 m block
      }};
    }};
  });
  const shot = async () => decodePNG(await page.locator('#ao').screenshot());
  const scene = options => page.evaluate(o => window.ao.scene(o), options);
  const at = (image, [x, y]) => {let sum = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {const i = ((y + dy) * image.width + x + dx) * 4; sum += image.data[i] + image.data[i + 1] + image.data[i + 2];} return sum / 27;};
  const result = {hardware, baseline};

  // 1. Perspective frames must not change: SSAO on core meshes plus a glTF-pro source, IBL alone (core + glTF-pro), plain.
  const perspective = {ssao: {model: true}, ibl: {ssao: false, ibl: true, model: true}, plain: {ssao: false, model: true}};
  await mkdir(folder, {recursive: true});
  result.perspective = {};
  for (const [name, options] of Object.entries(perspective)) {
    await scene(options);
    const bytes = await page.locator('#ao').screenshot(), file = `${folder}/${name}.png`;
    if (baseline) {await writeFile(file, bytes); continue;}
    await writeFile(`test-results/ssao-perspective-${name}.png`, bytes);
    if (!existsSync(file)) {result.perspective[name] = 'no baseline'; continue;}
    const before = await decodePNG(await readFile(file)), after = await decodePNG(bytes);
    let differing = 0, worst = 0; for (let i = 0; i < after.data.length; i++) {const d = Math.abs(after.data[i] - before.data[i]); if (d) differing++; worst = Math.max(worst, d);}
    result.perspective[name] = {differing, worst};
    assert.equal(differing, 0, `perspective ${name} changed: ${differing} bytes, worst ${worst}`);
  }
  console.log('perspective', JSON.stringify(result.perspective));

  // 2. Orthographic (cameras' default depth range is centred on the target, so near is negative): ambient-only light so
  //    the frame is view-independent; occlusion in the creases, none on open faces, and the same with the eye moved
  //    inside the part (geometry behind the eye, negative view depth).
  const darkening = async options => {
    const p = (await scene({...options, enabled: false})).points, off = await shot(), on = (await scene(options), await shot());
    return {points: p, on, off, delta: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, +(at(off, v) - at(on, v)).toFixed(1)]))};
  };
  const far = await darkening({ortho: true, light: false}), near = await darkening({ortho: true, light: false, eye: [0.68, 0.61, 0.46], target: [0.4, 0.3, 0]});
  await writeFile('test-results/ssao-ortho-on.png', await page.locator('#ao').screenshot());
  result.orthographic = {far: far.delta, eyeInside: near.delta};
  console.log('orthographic', JSON.stringify(result.orthographic));
  if (!baseline) {
    for (const [label, d] of [['far eye', far.delta], ['eye inside the part', near.delta]]) {
      assert.ok(d.crease > 8 && d.step > 8, `${label}: creases not occluded ${JSON.stringify(d)}`);
      assert.ok(Math.abs(d.open) <= 1 && Math.abs(d.top) <= 1.5, `${label}: open faces darkened (halo) ${JSON.stringify(d)}`);
    }
    // Moving the eye along the view direction does not change an orthographic image.
    let worst = 0, over = 0; const where = [];
    for (let i = 0; i < near.on.data.length; i++) {const d = Math.abs(near.on.data[i] - far.on.data[i]); worst = Math.max(worst, d); if (d > 2) {over++; if (where.length < 12) where.push([(i >> 2) % 400, Math.floor((i >> 2) / 400), d]);}}
    result.orthographic.eyeMove = {worst, over, where};
    console.log('eye move', JSON.stringify(result.orthographic.eyeMove));
    // A handful of silhouette pixels differ: the gbuffer's half-float view depth quantizes differently at 6 m than at 0.6 m.
    assert.ok(over <= 90 && worst <= 16, `orthographic SSAO depends on the eye position along the view: ${over} bytes over 2, worst ${worst}`);
  }

  // 3. IBL + SSAO: occlusion darkens the creases relative to IBL alone, and open faces keep the IBL value.
  //    Constant ambient off, so any darkening comes from the IBL term.
  //    'close' looks down at open floor from 2 m: small pixel footprints there once made the depth-derived normal fall
  //    back to camera-facing (an absolute degeneracy threshold), so flat floor nearer than a fixed depth self-occluded
  //    behind a straight screen-wide edge. Only IBL's large ambient term made it visible.
  for (const [label, options] of [['perspective', {}], ['orthographic', {ortho: true}], ['close', {eye: [-2.4, 1.2, 4.2], target: [-2.4, 0, 2.6]}]]) {
    const d = await darkening({...options, ibl: true, model: true, ambient: 0});
    await writeFile(`test-results/ssao-ibl-${label}-on.png`, await page.locator('#ao').screenshot());
    (result.ibl ??= {})[label] = d.delta;
    console.log('ibl', label, JSON.stringify(d.delta));
    if (baseline) continue;
    if (label === 'close') assert.ok(Math.abs(d.delta.open) <= 1, `IBL close: open floor darkened ${JSON.stringify(d.delta)}`);
    else {
      assert.ok(d.delta.crease > 4 && d.delta.step > 2,`IBL ${label}: creases not occluded ${JSON.stringify(d.delta)}`);
      assert.ok(Math.abs(d.delta.open) <= 1 && Math.abs(d.delta.top) <= 1.5, `IBL ${label}: open faces changed ${JSON.stringify(d.delta)}`);
    }
  }

  const gpuErrors = await page.evaluate(() => window.ao.gpuErrors);
  assert.deepEqual(gpuErrors, []); assert.deepEqual(errors, []);
  await writeFile(`test-results/ssao-gpu${baseline ? '-baseline' : ''}.json`, JSON.stringify(result, null, 2));
  console.log(baseline ? 'baseline saved' : 'SSAO GPU check passed');
} finally {await browser.close();}
