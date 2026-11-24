// Owner/lifetime fixture for @margoengine/xr: what an app attaches to an engine for WebXR. The XR plugin (create and
// attach), an XR with a running inline session, and XRModels drawing the session's controller and hand. No runtime
// gives a page a headset, so every entry runs on a recording XR system (navigator.xr, in place for the fixture's
// life) in both runtimes, as mixer's recording audio context: after disposal each session must be ended, its frame
// callback cancelled and its listeners gone. XR draws on a GPU device of its own (the shared route needs an engine from
// createXREngine, not the harness's); the browser's own WebGPU makes it, and only where a runtime has no WebGPU (the
// CPU model) does the fixture hand out an inert device. On the WebGL2 compatibility layer XR needs the layer's
// installXR route, put in place for the same span. Not entries: the immersive helpers (layers, pointer, locomotion,
// hands, hit test, AR, performance) need an immersive session with XRGPUBinding layers no headless browser has; their
// own tests drive them on recording sessions.
import { lifetimeFault } from '../../../tests/support/owner-shell.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const pose = (z) => ({
  transform: { matrix: identity(), inverse: { matrix: identity() }, position: { x: 0, y: 1, z, w: 1 },
    orientation: { x: 0, y: 0, z: 0, w: 1 } },
  emulatedPosition: false,
});
const JOINTS = 25;
// One controller and one tracked hand, so XRModels builds both kinds of model.
const sources = () => [
  { handedness: 'right', targetRayMode: 'tracked-pointer', targetRaySpace: { ray: true }, gripSpace: { grip: true },
    profiles: ['generic-trigger'], gamepad: { mapping: 'xr-standard', buttons: [{ value: 1, pressed: true, touched: true }], axes: [] } },
  { handedness: 'left', targetRayMode: 'tracked-pointer', targetRaySpace: { ray: true },
    hand: new Map(Array.from({ length: JOINTS }, (_, i) => [`joint-${i}`, { joint: i }])), profiles: [] },
];
class Session extends EventTarget {
  inputSources = sources();
  frames = new Map();
  next = 0;
  ended = false;
  async requestReferenceSpace() { return { space: true }; }
  updateRenderState() {}
  requestAnimationFrame(fn) {
    this.frames.set(++this.next, fn);
    return this.next;
  }
  cancelAnimationFrame(id) { this.frames.delete(id); }
  async end() {
    if (this.ended) return;
    this.ended = true;
    this.dispatchEvent(new Event('end'));
  }
  tick(time) {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    const frame = { session: this, getViewerPose: () => ({ ...pose(3), views: [] }), getPose: () => pose(-0.5),
      getJointPose: (joint) => ({ ...pose(-0.4 - joint.joint * 0.01), radius: 0.01 }) };
    for (const fn of callbacks) fn(time, frame);
  }
}
// The recording system and, where needed, the inert XR device, in place while any entry lives.
let users = 0, undo = [];
// Synchronous: XR.create captures the scene it was called for before its first await.
function enter(host, { compatTier, installXR }) {
  if (users++) return;
  const xr = { sessions: [], isSessionSupported: async (mode) => mode === 'inline',
    async requestSession() { const s = new Session(); xr.sessions.push(s); return s; } };
  const nav = globalThis.navigator, own = Object.getOwnPropertyDescriptor(nav, 'xr');
  Object.defineProperty(nav, 'xr', { configurable: true, value: xr });
  undo.push(() => { if (own) Object.defineProperty(nav, 'xr', own); else delete nav.xr; });
  if (!nav.gpu) {
    const device = () => Object.assign(new EventTarget(), { features: new Set(), limits: {}, queue: {},
      lost: new Promise(() => {}), destroyed: false, destroy() { this.destroyed = true; } });
    Object.defineProperty(nav, 'gpu', { configurable: true, value: { requestAdapter: async () =>
      ({ features: new Set(), info: { vendor: 'inert' }, requestDevice: async () => device() }) } });
    undo.push(() => delete nav.gpu);
  }
  if (compatTier(host.engine.gpu) === 'webgl2') {
    const route = installXR();
    undo.push(() => route.dispose());
  }
}
function leave() {
  if (--users) return;
  for (const step of undo.reverse()) step();
  undo = [];
}

export async function fixtures(load = (entry) => import(entry)) {
  const { XR } = await load('../dist/index.js');
  const { XRModels } = await load('../dist/models.js');
  const { compatTier } = await load('../../shared/compat.js');
  const { installXR } = await load('../../webgl2-compat/dist/xr.js');
  const entry = (name, make) => ({
    name,
    async create({ engine, host }) {
      enter(host, { compatTier, installXR });
      let left = false;
      const cleanup = () => { if (!left) { left = true; leave(); } };
      try {
        const made = await make(engine);
        const { xr, session } = made;
        return {
          plugin: xr,
          dispose: () => { made.release?.(); xr.dispose(); },
          cleanup,
          check({ phase }) {
            if (phase !== 'disposed') return;
            if (xr.session) lifetimeFault(`${name} keeps its session after disposal`);
            if (session && !session.ended) lifetimeFault(`${name} leaves its session running`);
            if (session?.frames.size) lifetimeFault(`${name} leaves ${session.frames.size} XR frame callback(s) queued`);
            made.check?.();
          },
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  });
  const inline = async (engine) => {
    const xr = await XR.create(engine);
    const session = await xr.requestSession('inline');
    session.tick(16);
    return { xr, session };
  };
  return [
    entry('XR.create', async (engine) => ({ xr: await XR.create(engine) })),
    entry('XR.attach', async (engine) => ({ xr: await XR.attach(engine) })),
    entry('XR inline session', inline),
    entry('XRModels', async (engine) => {
      const made = await inline(engine);
      const models = XRModels.attach(made.xr, engine);
      made.session.tick(32);
      const meshes = [...(models.controllerMeshes(made.session.inputSources[0]) ?? []),
        ...(models.handMeshes(made.session.inputSources[1])?.joints ?? [])];
      if (!meshes.length) throw new Error('OWNER_FIXTURE: XRModels made no model');
      return { ...made, release: () => models.dispose(),
        check() {
          const left = meshes.filter((m) => m.scene.meshes.get(m.id) === m);
          if (left.length) lifetimeFault(`XRModels leaves ${left.length} mesh(es) after disposal`);
        } };
    }),
  ];
}
