// The worker of browser-check.js: core, a control package and the stage class on the received canvas, unchanged.
import { box, Engine, PbrMaterial } from '/packages/core/dist/index.js';
import { OrbitControls } from '/packages/controls/dist/index.js';
import { Stage } from '/packages/stage/dist/index.js';
import { webglRenderer } from '/packages/webgl2-compat/dist/preview.js';
import { receiveCanvas } from '/packages/worker/dist/canvas.js';

// Requests wait here: a message with no listener at the moment it arrives is lost.
let commands;
const started = Promise.withResolvers();
globalThis.addEventListener('message', async ({ data: message }) => {
  if (!message.command) return;
  try {
    await started.promise;
    postMessage({ id: message.id, value: await commands[message.command](message.value) });
  } catch (error) {
    postMessage({ id: message.id, error: String(error) });
  }
});
// Awaited first on purpose: the page's first message arrives before receiveCanvas has a listener of its own.
await new Promise((resolve) => setTimeout(resolve, 100)); // fixed-wait: the late start this check is about
const received = await receiveCanvas(),
  { canvas, data } = received,
  engine = await Engine.create(canvas, {
    backend: data.backend,
    fallback: webglRenderer,
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
  }),
  mesh = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#ff2000', roughness: 0.5 })),
  controls = new OrbitControls(engine.camera, canvas);
received.attach(engine);
const stage = new Stage(engine);
let frames = 0,
  lastError;
engine.onError = (error) => {
  lastError = String(error);
};
engine.onFrame((_, delta) => {
  frames++;
  controls.update(delta);
});
engine.start();

commands = {
  frames: () => frames,
  state: () => ({
    backend: engine.backend,
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    ratio: globalThis.devicePixelRatio,
    frames,
    camera: [...engine.camera.position],
    touchAction: canvas.style.touchAction,
    error: lastError,
    hasDocument: typeof document !== 'undefined',
    stage: stage.engine === engine,
  }),
  pick: async ([x, y]) => (await engine.pick(x, y))?.id ?? null,
  block(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end);
    return ms;
  },
  async pixels() {
    engine.render({ delta: 0 });
    const bitmap = await createImageBitmap(await canvas.convertToBlob()),
      flat = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = flat.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const at = (x, y) => [...context.getImageData(x, y, 1, 1).data];
    return { centre: at(bitmap.width >> 1, bitmap.height >> 1), corner: at(1, 1) };
  },
  closed: () => received.signal.aborted && engine.disposed,
};
started.resolve();
void mesh;
