// Browser side of lens-check.mjs: bright boxes on a dark background, one engine per case.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { DOF } from '../../dist/index.js';
import { DOFLens } from '../../dist/lens.js';
import { Autofocus } from '../../dist/autofocus.js';
import { TAA } from '../../../taa/dist/index.js';

// ?mode=compat draws on the WebGL2 compatibility layer (compat-check.mjs).
if (new URLSearchParams(location.search).get('mode') === 'compat')
  await (await import('../../../webgl2-compat/dist/index.js')).install({ force: true });
const errors = [],
  white = new PbrMaterial({ color: '#ffffff', emissive: [6, 6, 6], roughness: 1, metalness: 0 }),
  card = new PbrMaterial({ color: '#ffffff', emissive: [0.5, 0.5, 0.5], roughness: 1, metalness: 0 });
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

const canvas = document.querySelector('canvas');
let engine, dof, focus;
const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) {
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
// exact: one sample (exactSize), so the depth DOF reads is not a multisample resolve.
const start = async (boxes, exact = false) => {
  engine?.dispose?.();
  engine = await Engine.create(canvas, { backend: 'webgpu', ...(exact && { exactSize: true }) });
  engine.camera.fov = 50;
  engine.camera.near = 0.1;
  engine.camera.far = 100;
  engine.camera.position = [0, 0, 10];
  engine.camera.target = [0, 0, 0];
  for (const [x, y, z, s] of boxes)
    engine
      .createMesh()
      .setGeometry(box(s, s, s))
      .setMaterial(white)
      .setPosition([x, y, z]);
};
window.check = {
  errors,
  vendor: () => engine?.gpu?.adapterInfo?.vendor ?? null,
  // A near box in the middle and a far one to the side: the focus follows the pixel, then a world point.
  async autofocus() {
    await start([
      [0, 0, 4, 1],
      [2, 0, -5, 1],
    ]);
    dof = DOF.attach(engine, { focalDistance: 5, focalLength: 0.05, aperture: 1.4 });
    focus = Autofocus.attach(engine, dof, { smoothing: 0 });
    await settle();
    const middle = dof.options.focalDistance;
    focus.options.point = [256 + 256 / (7.5 * Math.tan((25 * Math.PI) / 180)), 256];
    await settle();
    const side = dof.options.focalDistance;
    focus.options.target = [0, 0, 7];
    await settle(3);
    const target = dof.options.focalDistance;
    return { middle, side, target };
  },
  // A small box in the near field, whose bokeh spreads over the background.
  async blades(blades) {
    await start([[0, 0, 7, 0.1]]);
    DOF.attach(engine, {
      focalDistance: 20,
      focalLength: 0.1,
      aperture: 0.5,
      maxRadius: 16,
      lens: blades ? new DOFLens({ blades, bladeRotation: Math.PI / 2 }) : undefined,
    });
    await settle(4);
  },
  // The near box through an aperture image, all open or only its left half: the half's bokeh spreads left only.
  async aperture(half) {
    await start([[0, 0, 7, 0.1]]);
    const size = 64,
      data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < (half ? size / 2 : size); x++) data.fill(255, (y * size + x) * 4, (y * size + x) * 4 + 4);
    DOF.attach(engine, {
      focalDistance: 20,
      focalLength: 0.1,
      aperture: 0.5,
      maxRadius: 16,
      lens: new DOFLens({ aperture: { width: size, height: size, data } }),
    });
    await settle(4);
  },
  // A box in focus, one in the near field and one far behind: full or temporal (half) gather, alone or under TAA.
  async temporal(temporal, taa, frames) {
    await start([
      [0, 0, 0, 1],
      [-1.2, 0.4, 6, 0.3],
      [1.5, -0.5, -20, 3],
    ]);
    const dof = DOF.attach(engine, { focalDistance: 10, focalLength: 0.1, aperture: 0.7, maxRadius: 16, temporal });
    if (taa) TAA.attach(engine, { depth: () => dof.depthTexture });
    await settle(frames);
  },
  // A near box at [x, y], through a lens with cat's eye and anamorphic squeeze (and blades, for the shape lookup).
  async optics(x, y, catEye, anamorphic, blades, size = 0.1) {
    await start([[x, y, 7, size]]);
    DOF.attach(engine, {
      focalDistance: 20,
      focalLength: 0.1,
      aperture: 0.5,
      maxRadius: 16,
      lens: new DOFLens({ catEye, anamorphic, blades }),
    });
    await settle(4);
  },
  // The near box with DOF off: the scene the gathers start from.
  async sharp() {
    await start([[0, 0, 7, 0.1]]);
    DOF.attach(engine, { focalDistance: 20, focalLength: 0.1, aperture: 0.5, maxRadius: 16, enabled: false });
    await settle(4);
  },
  // KB1843: a grey card over the left half of the frame, its right edge on the middle column, on the empty background:
  // far behind the focus (near false) or in front of it (near true); enabled false draws the sharp scene. A blurred edge
  // must spread to both sides of the outline.
  async edge(near, enabled = true) {
    await start([]);
    engine
      .createMesh()
      .setGeometry(box(40, 40, 0.01))
      .setMaterial(card)
      .setPosition([-20, 0, near ? 6 : -10]);
    DOF.attach(engine, {
      focalDistance: near ? 30 : 2,
      focalLength: near ? 0.2 : 0.1,
      aperture: 1,
      maxRadius: 16,
      enabled,
    });
    await settle(4);
  },
  // More frames of the current case.
  more: (frames) => settle(frames),
  // Two boxes at one depth, above and below the middle; tilt null: no lens.
  async tilt(tilt, focalDistance, maxRadius = 32, exact = false) {
    await start(
      [
        [0, 2.8, 0, 0.3],
        [0, -2.8, 0, 0.3],
      ],
      exact,
    );
    DOF.attach(engine, {
      focalDistance,
      focalLength: 0.1,
      aperture: 0.05,
      maxRadius,
      lens: tilt === null ? undefined : new DOFLens({ tilt, tiltDirection: [0, -1] }),
    });
    await settle(4);
  },
};
window.ready = true;
