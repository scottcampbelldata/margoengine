// Browser side of blending-check.mjs: one plane per named kind in front of an opaque wall, through OIT or sorted.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { TransparentCanvas } from '../../../environment/dist/index.js';
import { Material, Texture, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { OIT } from '../../dist/index.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const kinds = {
  normal: { shading: 'basic', color: [0, 0, 1], opacity: 0.5, transparent: true },
  additive: { shading: 'basic', color: [0.5, 0, 0], opacity: 0.5, transparent: true, blending: 'additive' },
  multiply: { shading: 'basic', color: [0.5, 0.8, 0.5], transparent: true, blending: 'multiply' },
  glass: { color: [0.6, 0.9, 0.7], transmission: 0.9, roughness: 0.2 },
  'tinted-glass': {
    color: [1, 1, 1],
    transmission: 0.9,
    roughness: 0.2,
    thickness: 0.5,
    attenuationColor: [1, 0.4, 0.2],
    attenuationDistance: 0.5,
  },
  'mapped-glass': () => ({
    color: [0.6, 0.9, 0.7],
    transmission: 1,
    roughness: 0.2,
    transmissionMap: new Texture(
      { data: new Uint8Array([200, 200, 200, 255]), width: 1, height: 1 },
      { colorSpace: 'linear', mipmaps: false },
    ),
  }),
};
let engine, canvas, pass;
const draw = async () => {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  // {samples, layers:[kind...] near to far, mode:'sorted', off, addOrder:[...indices], transparent}
  async build(o) {
    pass?.dispose();
    pass = undefined;
    engine?.dispose();
    canvas?.remove();
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      preserveDrawingBuffer: true,
      camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
    });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    if (o.transparent) TransparentCanvas.attach(engine);
    else {
      const wall = createMesh(engine, planeGeometry(8, 8), new Material({ shading: 'basic', color: [0.4, 0.4, 0.4] }));
      wall.root.setPosition([0, 0, -1.5]);
    }
    let taken = 0;
    if (o.mode !== 'sorted') {
      pass = OIT.attach(engine, { blending: !o.off });
      const begin = pass.begin.bind(pass);
      pass.begin = () => {
        taken++;
        return begin();
      };
    }
    const meshes = o.layers.map((name, i) => {
      const kind = kinds[name],
        mesh = createMesh(
          engine,
          planeGeometry(1.6, 1.6),
          new Material(typeof kind === 'function' ? kind() : kind),
        );
      mesh.root.setPosition([0, 0, 0.6 - i * 0.3]);
      return mesh;
    });
    if (pass) for (const i of o.addOrder ?? meshes.keys()) pass.add(meshes[i]);
    taken = 0;
    await waitForPipelines(draw);
    return { taken };
  },
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
