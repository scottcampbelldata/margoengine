// VRM 1.0 first person on the GPU (WebGPU, and the WebGL2 layer with MARGO_COMPAT=1), on Seed-san (explicit
// annotations) and the Twist sample (auto, split by loadVRM). Every comparison is exact, against an oracle drawn
// another way: the first-person view equals the frame with the thirdPersonOnly nodes hidden; the third-person view
// equals the unmasked one; the shadow on the floor is the whole avatar's in the first-person view; a mirror given the
// third-person mask shows the head the first-person camera does not; the split model draws as the unsplit one.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const compat = process.env.MARGO_COMPAT === '1';
const context = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  const results = {};
  for (const name of ['Seed-san.vrm', 'VRM1_Constraint_Twist_Sample.vrm']) {
    results[name] = await context.page.evaluate(async (name) => {
      const { EngineKernel, box } = await import('/packages/core/dist/index.js');
      const { Camera } = await import('/packages/core/dist/extension.js');
      const { Shadows } = await import('/packages/shadows/dist/index.js');
      const { Reflector } = await import('/packages/environment/dist/reflector.js');
      const { loadGLTF } = await import('/packages/gltf/dist/pbr.js');
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      const { addVRMFirstPerson, loadVRM } = await import('/packages/rigging/dist/vrm-first-person.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:256px;height:256px';
      document.body.replaceChildren(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 1024,
        camera: { position: [0, 1.4, 3], target: [0, 1.2, 0], near: 0.05, far: 50 },
      });
      const d = engine.gpu;
      d.pushErrorScope('validation');
      engine.lighting.direction.set([0, 1, 1, 1]);
      engine.lighting.radiance.set([1, 1, 1, 0.3]);
      const floor = engine.createMesh().setGeometry(box()).setScale([8, 0.02, 8]).setPosition([0, -0.01, 0]);
      floor.material.color = [0.8, 0.8, 0.8];
      const shadows = Shadows.attach(engine, { resolution: 2048, distance: 8, filter: 'hard', cascades: 1 });
      const url = `/examples/assets/vrm/${name}`,
        signal = AbortSignal.timeout(120000);
      const model = await loadVRM(engine, url, { signal });
      const unshadow = shadows.add(model);
      engine.render({ delta: 0 });
      await d.queue.onSubmittedWorkDone();
      const fp = addVRMFirstPerson(model);
      const eye = fp.viewpoint();
      const size = 192,
        target = engine.renderTarget;
      const textures = [];
      const view = (id, position, look, layers) => {
        const camera = new Camera();
        camera.position = position;
        camera.target = look;
        camera.near = 0.02;
        camera.far = 50;
        camera.fov = 60;
        const color = d.createTexture({ size: [size, size], format: target.format, usage: 16 | 4 | 1 }),
          depth = d.createTexture({
            size: [size, size],
            format: target.depthFormat,
            sampleCount: target.samples,
            usage: 16 | 4,
          });
        textures.push(color, depth);
        return { id, camera, viewport: [0, 0, 1, 1], layers, target: { color, depth } };
      };
      const add = (a, b) => a.map((v, i) => v + b[i]);
      // A: through the eyes, from just behind and above them, looking down the front: the head is in the way.
      const behind = add(eye, [0, 0.12, -0.45]),
        chest = add(eye, [0, -0.45, 0.35]),
        face = add(eye, [0, 0, 1.1]),
        // S: the floor where the head's shadow falls (light from +Y+Z: behind the avatar), with no avatar in view.
        over = [0, 0.7, -eye[1] - 0.05],
        spot = [0, 0, -eye[1]];
      const A = view('a', behind, chest, fp.firstPersonLayers),
        A0 = view('a0', behind, chest, undefined),
        B = view('b', face, eye, fp.thirdPersonLayers),
        B0 = view('b0', face, eye, undefined),
        S = view('s', over, spot, fp.firstPersonLayers),
        S0 = view('s0', over, spot, undefined);
      for (const v of [S, S0]) v.camera.up = [0, 0, 1];
      const module = d.createShaderModule({
        code: `@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(image);if(id.x<s.x&&id.y<s.y){out[id.y*s.x+id.x]=textureLoad(image,vec2i(id.xy),0);}}`,
      });
      const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
        bytes = size * size * 16,
        output = d.createBuffer({ size: bytes, usage: 132 }),
        staging = d.createBuffer({ size: bytes, usage: 9 });
      const read = async (v) => {
        const group = d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: v.target.color.createView() },
            { binding: 1, resource: { buffer: output } },
          ],
        });
        const e = d.createCommandEncoder(),
          p = e.beginComputePass();
        p.setPipeline(pipeline);
        p.setBindGroup(0, group);
        p.dispatchWorkgroups(size / 8, size / 8);
        p.end();
        e.copyBufferToBuffer(output, 0, staging, 0, bytes);
        d.queue.submit([e.finish()]);
        await staging.mapAsync(1);
        const out = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        return out;
      };
      const frame = async (views) => {
        await waitForPipelines(async () => {
          engine.render({ delta: 0, views });
          await d.queue.onSubmittedWorkDone();
        });
        const out = [];
        for (const v of views) out.push(await read(v));
        return out;
      };
      const differ = (a, b) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
          if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
        return n;
      };
      const drawn = (a) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4) if (a[i] + a[i + 1] + a[i + 2] > 0) n++;
        return n;
      };
      const [a, a0, b, b0, s, s0] = await frame([A, A0, B, B0, S, S0]);
      // Oracle: the same cameras with every thirdPersonOnly node hidden and no masks. A hidden node casts no shadow, so
      // the view through the eyes is compared with the avatar casting nothing (the floor view checks the shadow).
      const third = fp.meshAnnotations.filter((x) => x.type === 'thirdPersonOnly').map((x) => model.nodes[x.node]);
      for (const node of third) node.visible = false;
      const [hiddenS] = await frame([S0]);
      unshadow();
      const [hiddenA] = await frame([A0]);
      for (const node of third) node.visible = true;
      const [maskedA] = await frame([A]);
      shadows.add(model);
      // Mirror: the engine camera looks through the eyes; a mirror before the avatar, given the third-person mask,
      // shows the head; given the first-person mask, it does not.
      fp.dispose();
      const fp2 = addVRMFirstPerson(model, { firstPersonCameras: [engine.camera] });
      // Through the eyes, straight at the mirror: the head is not drawn, its reflection is.
      engine.camera.position = behind;
      engine.camera.target = add(eye, [0, -0.1, 1]);
      engine.camera.fov = 60;
      const mirror = Reflector.attach(engine, { width: 3, height: 3, color: '#ffffff', layers: fp2.thirdPersonLayers });
      mirror.node.setPosition([0, eye[1], eye[2] + 1]).setRotation([0, Math.PI, 0]);
      const M = view('m', behind, engine.camera.target, undefined);
      M.camera = engine.camera;
      // engine.render does not run the frame loop's onFrame hooks, so each capture is taken by hand.
      const mirrored = async () => {
        check(mirror.update(), 'the mirror captures');
        return (await frame([M]))[0];
      };
      const check = (ok, message) => {
        if (!ok) throw new Error(message);
      };
      const withHead = await mirrored();
      mirror.layers = fp2.firstPersonLayers;
      const withoutHead = await mirrored();
      mirror.layers = 0xffffffff;
      const allLayers = await mirrored();
      mirror.node.visible = false;
      const [noMirror] = await frame([M]);
      mirror.node.visible = true;
      engine.render({ delta: 0 });
      await d.queue.onSubmittedWorkDone();
      fp2.dispose();
      mirror.dispose?.();
      // The split model draws as the file as it was: compare the outside view with an unsplit load.
      let unsplitDiff = null;
      if (name.includes('Twist')) {
        const plain = await loadGLTF(engine, url, { signal });
        model.root.visible = false;
        const [p] = await frame([B0]);
        plain.dispose();
        model.root.visible = true;
        const [q] = await frame([B0]);
        unsplitDiff = differ(p, q);
      }
      const validation = await d.popErrorScope();
      const result = {
        eye,
        thirdPersonNodes: third.length,
        aDrawn: drawn(a),
        aVsUnmasked: differ(a, a0),
        aVsHidden: differ(maskedA, hiddenA),
        bVsUnmasked: differ(b, b0),
        bDrawn: drawn(b),
        shadowVsUnmasked: differ(s, s0),
        shadowVsHeadless: differ(s, hiddenS),
        mirrorHead: differ(withHead, withoutHead),
        mirrorVsAll: differ(withHead, allLayers),
        mirrorDrawn: differ(allLayers, noMirror),
        unsplitDiff,
        layer: !!globalThis.__margoCompat,
        validation: validation?.message,
      };
      model.dispose();
      engine.dispose();
      for (const t of textures) t.destroy();
      output.destroy();
      staging.destroy();
      return result;
    }, name);
  }
  console.log(JSON.stringify(results, null, 1));
  assert.deepEqual(errors, []);
  for (const [name, r] of Object.entries(results)) {
    const at = `${name}${compat ? ' (compat)' : ''}: ${JSON.stringify(r)}`;
    assert.equal(r.validation, undefined, at);
    assert.equal(r.layer, compat, `ran on ${compat ? 'the WebGL2 layer' : 'native WebGPU'}: ${at}`);
    assert.ok(r.thirdPersonNodes >= 3, at);
    assert.ok(r.aDrawn > 500, at);
    assert.ok(r.aVsUnmasked > 200, `the head is hidden through the eyes: ${at}`);
    assert.equal(r.aVsHidden, 0, `masked equals hidden: ${at}`);
    assert.ok(r.bDrawn > 500, at);
    assert.equal(r.bVsUnmasked, 0, `the third-person view is unchanged: ${at}`);
    assert.equal(r.shadowVsUnmasked, 0, `the first-person shadow is the whole avatar's: ${at}`);
    assert.ok(r.shadowVsHeadless > 20, `the floor view holds the head's shadow: ${at}`);
    assert.ok(r.mirrorHead > 200, `the mirror shows the head: ${at}`);
    assert.equal(r.mirrorVsAll, 0, at);
    if (r.unsplitDiff !== null) assert.equal(r.unsplitDiff, 0, `the split draws as the unsplit file: ${at}`);
  }
  await mkdir('test-results/rigging', { recursive: true });
  await writeFile(
    `test-results/rigging/vrm-first-person${compat ? '-compat' : ''}.json`,
    JSON.stringify(results, null, 2),
  );
} finally {
  await context.close();
}
