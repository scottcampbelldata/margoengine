import { createStage } from '@margoengine/stage';
import { addViewer, type Viewer, type ViewerOptions } from '@margoengine/stage/viewer';

// Real WebGPU check of addViewer (scripts/stage-viewer-gpu-check.js): each mode loads a real model, and the page hands
// the frames to the script as screenshots. Everything here runs on the page's real frame loop.
type Page = {
  open(options: ViewerOptions): Promise<{ plugins: string[]; position: number[]; target: number[] }>;
  frames(count: number): Promise<void>;
  camera(): { position: number[]; target: number[] };
  look(position: [number, number, number]): Promise<void>;
  dropShadow(): Promise<void>;
  close(): Promise<{ plugins: string[]; meshes: number; gpuErrors: string[] }>;
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
    await page.frames(10);
    return { plugins: plugins(), ...page.camera() };
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
    await page.frames(5);
  },
  async dropShadow() {
    viewer.shadows!.dispose();
    await page.frames(30);
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
