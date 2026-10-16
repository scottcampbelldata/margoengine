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
  XRInputSource,
  XRPose,
} from '@margoengine/xr';
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function pose(x: number, y: number, z: number): XRPose {
  const matrix = identity(),
    inverse = identity();
  matrix.set([x, y, z], 12);
  inverse.set([-x, -y, -z], 12);
  return {
    transform: {
      matrix,
      inverse: { matrix: inverse },
      position: { x, y, z, w: 1 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    emulatedPosition: false,
  };
}
/** Native-session fixture; the real XR manager, controller updates and stereo GPU renderer run unchanged. */
export function simulatedXR(errors: string[]) {
  let device: GPUDevice | undefined,
    color: GPUTexture | undefined,
    depth: GPUTexture | undefined,
    requests = 0,
    frames = 0,
    ends = 0;
  const source: XRInputSource = {
    handedness: 'right',
    targetRayMode: 'tracked-pointer',
    targetRaySpace: {},
    gripSpace: {},
    profiles: [],
  };
  class Session extends EventTarget implements XRNativeSession {
    readonly inputSources = [source];
    readonly enabledFeatures = ['webgpu', 'local'];
    ended = false;
    async requestReferenceSpace(): Promise<XRSpace> {
      return {};
    }
    updateRenderState(): void {}
    requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void): number {
      return requestAnimationFrame((time) => {
        if (this.ended) return;
        frames++;
        const views: XRView[] = ([-0.15, 0.15] as const).map((x, index) => {
          const near = 0.1,
            far = 100,
            f = 1 / Math.tan(Math.PI / 6),
            projectionMatrix = new Float32Array([
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
          return { eye: index ? 'right' : 'left', projectionMatrix, transform: pose(x, 0.5, 4).transform };
        });
        callback(time, {
          session: this,
          getPose: () => pose(0.8, 0.7, 0),
          getViewerPose: () => ({ ...pose(0, 0.5, 4), views }),
        });
      });
    }
    cancelAnimationFrame(id: number): void {
      cancelAnimationFrame(id);
    }
    async end(): Promise<void> {
      if (this.ended) return;
      this.ended = true;
      ends++;
      this.dispatchEvent(new Event('end'));
    }
  }
  class Binding implements XRBinding {
    constructor(_session: XRNativeSession, gpu: GPUDevice) {
      device = gpu;
      device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
      color = device.createTexture({
        size: [128, 128, 2],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      depth = device.createTexture({
        size: [128, 128, 2],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    getPreferredColorFormat(): GPUTextureFormat {
      return 'rgba8unorm';
    }
    createProjectionLayer(): XRProjectionLayer {
      return {
        destroy() {
          color?.destroy();
          depth?.destroy();
        },
      };
    }
    getViewSubImage(_layer: XRProjectionLayer, view: XRView): XRSubImage {
      return {
        colorTexture: color!,
        depthStencilTexture: depth!,
        viewport: { x: 0, y: 0, width: 128, height: 128 },
        getViewDescriptor: () => ({ dimension: '2d', baseArrayLayer: view.eye === 'left' ? 0 : 1, arrayLayerCount: 1 }),
      };
    }
  }
  const previousBinding = Object.getOwnPropertyDescriptor(globalThis, 'XRGPUBinding'),
    previousXR = Object.getOwnPropertyDescriptor(navigator, 'xr');
  Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: Binding });
  const system: XRSystem = {
    isSessionSupported: async (_mode: XRMode) => true,
    requestSession: async () => {
      requests++;
      return new Session();
    },
  };
  Object.defineProperty(navigator, 'xr', { configurable: true, value: system });
  return {
    get requests() {
      return requests;
    },
    get frames() {
      return frames;
    },
    get ends() {
      return ends;
    },
    async pixels() {
      await device!.queue.onSubmittedWorkDone();
      const buffer = device!.createBuffer({
          size: 128 * 512 * 2,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        encoder = device!.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: color! }, { buffer, bytesPerRow: 512, rowsPerImage: 128 }, [128, 128, 2]);
      device!.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange()),
        eyes: number[] = [],
        centers: number[] = [];
      for (let eye = 0; eye < 2; eye++) {
        let count = 0,
          sum = 0;
        for (let y = 0; y < 128; y++)
          for (let x = 0; x < 128; x++) {
            const at = eye * 128 * 512 + y * 512 + x * 4;
            if (bytes[at] > 50 && bytes[at] > bytes[at + 1] * 1.5) {
              count++;
              sum += x;
            }
          }
        eyes.push(count);
        centers.push(sum / count);
      }
      buffer.unmap();
      buffer.destroy();
      return { eyes, centers };
    },
    restore() {
      if (previousBinding) Object.defineProperty(globalThis, 'XRGPUBinding', previousBinding);
      else delete (globalThis as { XRGPUBinding?: unknown }).XRGPUBinding;
      if (previousXR) Object.defineProperty(navigator, 'xr', previousXR);
      else delete (navigator as { xr?: unknown }).xr;
    },
  };
}
