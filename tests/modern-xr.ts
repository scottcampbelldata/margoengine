import { Engine, box, PbrMaterial } from '@margoengine/core';
import { XR } from '@margoengine/xr';
import type {
  XRBinding,
  XRMode,
  XRNativeFrame,
  XRNativeSession,
  XRProjectionLayer,
  XRSpace,
  XRSubImage,
  XRSystem,
  XRView,
} from '@margoengine/xr';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
let device: GPUDevice, color: GPUTexture, depth: GPUTexture;
const gpuErrors: string[] = [];
class SimulatedSession extends EventTarget implements XRNativeSession {
  inputSources = [];
  enabledFeatures = ['webgpu', 'local'];
  ended = false;
  async requestReferenceSpace(): Promise<XRSpace> {
    return {};
  }
  updateRenderState(): void {}
  requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void): number {
    return requestAnimationFrame((time) => {
      if (this.ended) return;
      const views: XRView[] = ([-0.1, 0.1] as const).map((x, index) => {
        const matrix = identity(),
          inverse = identity();
        matrix[12] = x;
        matrix[14] = 3;
        inverse[12] = -x;
        inverse[14] = -3;
        const near = 0.1,
          far = 100,
          f = 1 / Math.tan(Math.PI / 6),
          projection = new Float32Array([
            f,
            0,
            0,
            0,
            0,
            f,
            0,
            0,
            0,
            0,
            far / (near - far),
            -1,
            0,
            0,
            (near * far) / (near - far),
            0,
          ]);
        return {
          eye: index ? 'right' : 'left',
          projectionMatrix: projection,
          transform: {
            matrix,
            inverse: { matrix: inverse },
            position: { x, y: 0, z: 3, w: 1 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        };
      });
      callback(time, {
        session: this,
        getPose: () => null,
        getViewerPose: () => ({ transform: views[0].transform, emulatedPosition: false, views }),
      });
    });
  }
  cancelAnimationFrame(id: number): void {
    cancelAnimationFrame(id);
  }
  async end(): Promise<void> {
    this.ended = true;
    this.dispatchEvent(new Event('end'));
  }
}
class SimulatedBinding implements XRBinding {
  constructor(_session: XRNativeSession, gpu: GPUDevice) {
    device = gpu;
    device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    color = device.createTexture({ size: [128, 128, 2], format: 'rgba8unorm', usage: 0x10 | 1 });
    depth = device.createTexture({ size: [128, 128, 2], format: 'depth24plus', usage: 0x10 });
  }
  getPreferredColorFormat(): GPUTextureFormat {
    return 'rgba8unorm';
  }
  createProjectionLayer(): XRProjectionLayer {
    return {
      destroy() {
        color.destroy();
        depth.destroy();
      },
    };
  }
  getViewSubImage(_layer: XRProjectionLayer, view: XRView): XRSubImage {
    return {
      colorTexture: color,
      depthStencilTexture: depth,
      viewport: { x: 0, y: 0, width: 128, height: 128 },
      getViewDescriptor: () => ({ dimension: '2d', baseArrayLayer: view.eye === 'left' ? 0 : 1, arrayLayerCount: 1 }),
    };
  }
}
const previousBinding = Object.getOwnPropertyDescriptor(globalThis, 'XRGPUBinding'),
  previousXR = Object.getOwnPropertyDescriptor(navigator, 'xr');
Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: SimulatedBinding });
const simulated: XRSystem = {
  isSessionSupported: async (_mode: XRMode) => true,
  requestSession: async () => new SimulatedSession(),
};
Object.defineProperty(navigator, 'xr', { configurable: true, value: simulated });
async function pixels(): Promise<number[]> {
  const buffer = device.createBuffer({ size: 128 * 512 * 2, usage: 1 | 8 }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: color }, { buffer, bytesPerRow: 512, rowsPerImage: 128 }, [128, 128, 2]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const bytes = new Uint8Array(buffer.getMappedRange()),
    centers: number[] = [];
  for (let eye = 0; eye < 2; eye++) {
    let count = 0,
      sum = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const offset = eye * 128 * 512 + y * 512 + x * 4;
        if (bytes[offset] > 30 && bytes[offset] > bytes[offset + 1] * 1.5) {
          sum += x;
          count++;
        }
      }
    if (!count) throw new Error(`Eye ${eye} has no rendered mesh pixels`);
    centers.push(sum / count);
  }
  buffer.unmap();
  buffer.destroy();
  return centers;
}
async function run() {
  const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu', capacity: 4 }),
    errors: string[] = [];
  engine.onError = (error) => errors.push(String(error));
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: '#ff0000' }));
  const xr = await XR.create(engine);
  try {
    let frames = 0;
    await xr.requestSession('immersive-vr', {
      onFrame: () => {
        frames++;
      },
    });
    while (frames < 3) await new Promise(requestAnimationFrame);
    const centers = await pixels();
    await device.queue.onSubmittedWorkDone();
    if (Math.abs(centers[0] - centers[1]) < 2) throw new Error('Stereo projections did not separate the eye images');
    await xr.end();
    xr.dispose();
    engine.dispose();
    if (errors.length || gpuErrors.length) throw new Error([...errors, ...gpuErrors].join('\n'));
    return { frames, centers, gpuErrors, headset: 'simulated session; real WebGPU rendering' };
  } finally {
    engine.dispose();
    previousBinding
      ? Object.defineProperty(globalThis, 'XRGPUBinding', previousBinding)
      : delete (globalThis as { XRGPUBinding?: unknown }).XRGPUBinding;
    previousXR ? Object.defineProperty(navigator, 'xr', previousXR) : delete (navigator as { xr?: unknown }).xr;
  }
}
(globalThis as typeof globalThis & { xrVerification: Promise<unknown> }).xrVerification = run().then(
  (result) => ({ result }),
  (error) => ({ error: String(error) }),
);
