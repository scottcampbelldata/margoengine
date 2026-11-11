import { createStage } from '@margoengine/stage';
import { engineRuntime } from '@margoengine/core/extension';
import { waitForPipelines } from '../scripts/support/gpu-ready.js';
import { addScene } from '@margoengine/stage/scene';
import { addViewer, type Viewer, type ViewerOptions } from '@margoengine/stage/viewer';

// Real WebGPU check of addViewer (scripts/stage-viewer-gpu-check.js): each mode loads a real model, and the page hands
// the frames to the script as screenshots. Everything here runs on the page's real frame loop.
type Page = {
  open(options: ViewerOptions): Promise<{ plugins: string[]; position: number[]; target: number[] }>;
  frames(count: number): Promise<void>;
  ready(): Promise<void>;
  camera(): { position: number[]; target: number[] };
  look(position: [number, number, number]): Promise<void>;
  dropShadow(): Promise<void>;
  restore(): Promise<boolean>;
  restored(): boolean;
  close(): Promise<{ plugins: string[]; meshes: number; gpuErrors: string[] }>;
  scene(): Promise<{ bounds: number[]; meshes: number; left: number; gpuErrors: string[] }>;
  scenery(): Promise<void>;
  state(): Record<string, unknown>;
  fail(options: ViewerOptions): Promise<string>;
  end(): string[];
};
const gpuErrors: string[] = [],
  url = '/examples/assets/flight-helmet-mobile.glb';
let app: Awaited<ReturnType<typeof createStage>>, viewer: Viewer;

const plugins = () =>
  ['environment', 'environment:lighting', 'background', 'contact-shadows', 'shadows', 'tonemap'].filter((name) =>
    app.engine.hasPlugin(name),
  );
const page: Page = {
  async open(options) {
    app = await createStage('#scene', { backend: 'webgpu', onError: (error) => gpuErrors.push(String(error)) });
    (app.engine as unknown as { gpu: GPUDevice }).gpu.addEventListener('uncapturederror', (event) =>
      gpuErrors.push(event.error.message),
    );
    viewer = await addViewer(app, url, options);
    await page.ready();
    return { plugins: plugins(), ...page.camera() };
  },
  async ready() {
    await waitForPipelines(
      async () => {
        app.engine.render();
        await app.engine.gpu!.queue.onSubmittedWorkDone();
        await new Promise(requestAnimationFrame);
      },
      { ready: () => !viewer.environment || viewer.environment.environment.device === app.engine.gpu },
    );
  },
  async frames(count) {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
  },
  camera() {
    const { position, target } = app.engine.camera;
    return { position: [...position], target: [...target] };
  },
  async look(position) {
    app.engine.camera.position = position;
    await page.ready();
  },
  async dropShadow() {
    viewer.shadows!.dispose();
    await page.ready();
  },
  async restore() {
    const before = app.engine.gpu!;
    app.engine.stop();
    before.destroy();
    await before.lost;
    await engineRuntime(app.engine).rebootDevice();
    app.engine.gpu!.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    app.engine.start();
    return app.engine.gpu !== before;
  },
  restored() {
    return viewer.environment!.environment.device === app.engine.gpu;
  },
  // A saved scene with a real model under a moved parent: addScene's parenting on a real gltf-pro model.
  async scene() {
    app = await createStage('#scene', { backend: 'webgpu', onError: (error) => gpuErrors.push(String(error)) });
    const level = await addScene(
        app,
        {
          format: 'margo-save',
          version: 1,
          entities: [
            {
              id: 'plinth',
              transform: { position: [5, 0, 0] },
              components: { mesh: { shape: 'box', size: [1, 0.1, 1] } },
            },
            { id: 'helmet', parent: 'plinth', transform: { position: [0, 1, 0] }, components: { mesh: url } },
          ],
        },
        { base: location.href },
      ),
      model = level.models.get('helmet')!;
    await page.frames(10);
    const bounds = [...model.bounds],
      meshes = app.engine.scene.meshes.size;
    level.dispose();
    await page.frames(3);
    const left = app.engine.scene.meshes.size;
    app.dispose();
    return { bounds, meshes, left, gpuErrors: [...gpuErrors] };
  },
  // A stage with a scene of the page's own, for a failed addViewer to leave as it was.
  async scenery() {
    app = await createStage('#scene', {
      backend: 'webgpu',
      controls: false,
      onError: (error) => gpuErrors.push(String(error)),
    });
    (app.engine as unknown as { gpu: GPUDevice }).gpu.addEventListener('uncapturederror', (event) =>
      gpuErrors.push(event.error.message),
    );
    app.box({ size: [1, 2, 1], color: '#b04020' });
    const { camera } = app.engine;
    camera.position = [3, 2, 4];
    camera.target = [0, 0.5, 0];
    camera.near = 0.5;
    camera.far = 40;
    await page.frames(10);
  },
  state() {
    const { position, target, near, far, fov, up } = app.engine.camera;
    return { position, target, near, far, fov, up, plugins: plugins(), meshes: app.engine.scene.meshes.size };
  },
  async fail(options) {
    const message = await addViewer(app, url, options).then(
      () => 'addViewer resolved',
      (error: Error) => error.message,
    );
    await page.frames(10);
    return message;
  },
  end() {
    app.dispose();
    return [...gpuErrors];
  },
  async close() {
    viewer.dispose();
    await page.frames(3);
    const left = { plugins: plugins(), meshes: app.engine.scene.meshes.size, gpuErrors: [...gpuErrors] };
    app.dispose();
    return left;
  },
};
(globalThis as typeof globalThis & { viewerPage: Page }).viewerPage = page;
