// Browser side of reference-check.mjs: the batch 168 five-pane scene (scripts/oit-scene.mjs) through one transparency
// route, read back as the rival comparison reads it (scripts/rival-oit-page.js): canvas bytes, one common IEC sRGB
// encoding after readback (the palette is binary, so the display encoding of each source channel is invariant).
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { OIT } from '../../dist/index.js';
import { ExactOIT } from '../../dist/exact.js';
import { PeelOIT } from '../../dist/peel.js';
import { OIT_SCENE, pictureError, srgbByte } from '../../scripts/oit-scene.mjs';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const scene = OIT_SCENE;
let engine, canvas, pass;
window.check = {
  errors,
  // mode: 'weighted' (OIT, the package default), 'peel' (PeelOIT), 'exact' (ExactOIT) or 'sorted' (no OIT: core sorts
  // the panes back to front per mesh). Returns pictureError against the sorted pane reference, on the bytes sRGB encoded
  // after readback, and the centre pixel.
  async render(mode) {
    pass?.dispose();
    pass = undefined;
    engine?.dispose();
    canvas?.remove();
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.width = scene.width;
    canvas.height = scene.height;
    canvas.style.cssText = `width:${scene.width}px;height:${scene.height}px;display:block`;
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      preserveDrawingBuffer: true,
      exactSize: [scene.width, scene.height],
      camera: { position: scene.eye, target: scene.target, fov: scene.fov, near: scene.near, far: scene.far },
    });
    engine.stop();
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    engine.scene.background = '#000000';
    pass =
      mode === 'weighted'
        ? OIT.attach(engine)
        : mode === 'peel'
          ? PeelOIT.attach(engine)
          : mode === 'exact'
            ? ExactOIT.attach(engine)
            : undefined;
    const geometry = planeGeometry(scene.half * 2, scene.half * 2);
    for (const pane of scene.panes) {
      const mesh = createMesh(
        engine,
        geometry,
        new Material({ shading: 'basic', color: pane.color, opacity: pane.alpha, transparent: true }),
      );
      mesh.root.setPosition([0, 0, pane.z]);
      pass?.add(mesh);
    }
    const frame = async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(frame, { timeoutMs: 120_000, describe: () => `oit reference ${mode}` });
    await frame();
    const blob = await (await fetch(canvas.toDataURL('image/png'))).blob(),
      bitmap = await createImageBitmap(blob),
      out = new OffscreenCanvas(bitmap.width, bitmap.height),
      g = out.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = g.getImageData(0, 0, out.width, out.height).data;
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = srgbByte(data[i + c] / 255);
    const at = ((scene.height >> 1) * scene.width + (scene.width >> 1)) * 4;
    return {
      size: [out.width, out.height],
      error: pictureError(data, scene),
      center: Array.from(data.subarray(at, at + 3)),
    };
  },
};
window.ready = true;
