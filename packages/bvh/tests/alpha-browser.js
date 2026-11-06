// A real file through @margoengine/bvh/alpha: AlphaBlendModeTest.glb from Khronos, whose three MASK cards differ only in
// their cutoff, against the GPU's own pick of the same pixels, which runs the same mask in a shader.
import { AlphaRaycaster, modelAlphaMasks } from '@margoengine/bvh/alpha';
import { Raycaster } from '@margoengine/bvh';
import { Engine } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf-pro';
import { Picking } from '@margoengine/selection';
import cards from '../../../examples/assets/khronos/AlphaBlendModeTest/AlphaBlendModeTest.glb?url';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

export async function alphaChecks(report) {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 240;
  Object.assign(canvas.style, { width: '480px', height: '240px', position: 'fixed' });
  document.body.append(canvas);
  const engine = await Engine.create(canvas, { backend: 'webgpu' }),
    model = await loadGLTF(engine, cards),
    source = await modelAlphaMasks(model);
  assert(source.skipped.length === 0, `nothing skipped: ${source.skipped.map(({ reason }) => reason)}`);
  engine.camera.position = [0, 1, 7];
  engine.camera.target = [0, 1, 0];
  const picking = Picking.attach(engine, { capture: false });
  engine.render({ culling: false });
  const alpha = new AlphaRaycaster(),
    plain = new Raycaster();
  alpha.alphaMask = source;
  alpha.firstHitOnly = plain.firstHitOnly = true;
  let compared = 0,
    agreed = 0,
    holes = 0;
  for (let y = 3; y < 240; y += 6)
    for (let x = 3; x < 480; x += 6) {
      const gpu = await engine.pick(x, y),
        cpu = alpha.setFromEngine(engine, x, y).intersectEngine(engine)[0],
        solid = plain.setFromEngine(engine, x, y).intersectEngine(engine)[0];
      compared++;
      if ((cpu?.mesh ?? null) === gpu) agreed++;
      if (solid && solid.mesh !== cpu?.mesh) holes++;
    }
  assert(holes > 50, `rays pass through the cut parts: ${holes}`);
  assert(agreed / compared >= 0.985, `the CPU pick agrees with the GPU pick: ${agreed} of ${compared}`);
  picking.dispose();
  model.dispose();
  engine.dispose();
  canvas.remove();
  report.checks.push(`alpha: AlphaBlendModeTest.glb, ${agreed} of ${compared} pixels agree with the GPU pick, ${holes} through holes`);
  return true;
}
