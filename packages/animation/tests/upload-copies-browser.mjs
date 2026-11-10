// Batch 161 job 3 on a real WebGPU queue (the native writer, so the uploaded-palette cache is live): RobotExpressive
// playing Walking keeps its uploaded palettes without copying them (each upload swaps the live and uploaded views),
// its two palettes still read back from the GPU bone buffer equal to the CPU product, and a held pose uploads nothing.
// Run: npm run test:gpu:uploads -w @margoengine/animation.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 5241 });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { loadGLTF } = await import('/packages/gltf-pro/dist/index.js');
    const { Animation } = await import('/packages/animation/dist/index.js');
    const { invertMatrixStable, multiplyMatrices } = await import('/packages/math/dist/mat4.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:128px;height:128px';
    document.body.append(canvas);
    const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      capacity: 1024,
      camera: { position: [0, 1, 6], target: [0, 1, 0], near: 0.01, far: 50 },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    const model = await loadGLTF(engine, '/examples/assets/robot-expressive.glb'),
      animation = Animation.attach(model);
    animation.play('Walking');
    const records = animation.resources,
      skinned = records.filter((r) => r.joints.length),
      palettes = new Set();
    for (const r of skinned) palettes.add(r.slot.bones);
    // Every copy into an uploaded palette, wherever it comes from.
    let copies = 0;
    const set = Uint32Array.prototype.set;
    Uint32Array.prototype.set = function (...args) {
      if (records.some((r) => r.uploadedPalette === this || r.paletteBits === this || r.spareBits === this)) copies++;
      return set.apply(this, args);
    };
    const reference = (r) => {
      const inverse = new Float32Array(16),
        joint = new Float32Array(16),
        product = new Float32Array(16),
        out = new Float32Array(r.joints.length * 16);
      invertMatrixStable(r.primitive.node.matrix, inverse, new Float64Array(52));
      for (let i = 0; i < r.joints.length; i++) {
        multiplyMatrices(model.nodes[r.joints[i]].matrix, r.inverseBind[i], joint);
        multiplyMatrices(inverse, joint, product);
        out.set(product, i * 16);
      }
      return new Uint32Array(out.buffer);
    };
    const readBones = async (r) => {
      const size = r.joints.length * 64,
        readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
        encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(r.bones, r.slot.bones.offset * 64, readback, 0, size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(readback.getMappedRange().slice(0));
      readback.destroy();
      return words;
    };
    let mismatched = 0;
    try {
      for (let frame = 0; frame < 30; frame++) {
        engine.render({ culling: false, delta: 1 / 60 });
        await device.queue.onSubmittedWorkDone();
        if (frame % 10 === 9)
          for (const r of skinned) {
            const gpu = await readBones(r),
              cpu = reference(r);
            // record.palette is the palette that went up, as before (readers such as the reference shaders use it).
            const own = new Uint32Array(r.palette.buffer, r.palette.byteOffset, r.palette.length);
            for (let i = 0; i < cpu.length; i++) if (gpu[i] !== cpu[i] || own[i] !== cpu[i]) mismatched++;
          }
      }
      // A held pose: the comparison finds every palette unchanged, so nothing is written or copied.
      animation.playing = false;
      engine.render({ culling: false, delta: 0 });
      await device.queue.onSubmittedWorkDone();
      const held = skinned.every((r) => (r.leader ?? r).bonesUploaded);
      engine.render({ culling: false, delta: 0 });
      await device.queue.onSubmittedWorkDone();
      return {
        skinned: skinned.length,
        palettes: palettes.size,
        copies,
        mismatched,
        held,
        validation: (await device.popErrorScope())?.message ?? null,
      };
    } finally {
      Uint32Array.prototype.set = set;
      animation.dispose();
      model.dispose();
      engine.dispose();
    }
  });
  console.log(JSON.stringify(result));
  assert.equal(result.validation, null);
  assert.equal(result.skinned, 4, 'four skinned primitives');
  assert.equal(result.palettes, 2, 'two palettes');
  assert.equal(result.copies, 0, 'uploaded palettes copied per frame (the parent copied each changed one)');
  assert.equal(result.mismatched, 0, 'GPU bone words equal the CPU product');
  assert.ok(result.held, 'a held pose stays certified as uploaded');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
