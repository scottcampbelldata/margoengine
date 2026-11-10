import type {
  XRBinding,
  XRNativeFrame,
  XRNativeSession,
  XRProjectionLayer,
  XRSpace,
  XRSubImage,
  XRView,
  XRSystem,
} from '@margoengine/xr';

const SIZE = 96;
function eyes(): XRView[] {
  const near = 0.1,
    far = 50,
    f = 1 / Math.tan(Math.PI / 8);
  return [-0.03, 0.03].map((x, i) => ({
    eye: i ? 'right' : 'left',
    projectionMatrix: new Float32Array([
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
    ]),
    transform: {
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 5, 1]),
      inverse: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, -5, 1]) },
      position: { x, y: 0, z: 5, w: 1 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
  }));
}
class Session extends EventTarget implements XRNativeSession {
  inputSources = [];
  enabledFeatures = ['webgpu', 'local'];
  callback?: (time: number, frame: XRNativeFrame) => void;
  async requestReferenceSpace(): Promise<XRSpace> {
    return {};
  }
  updateRenderState(): void {}
  requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void) {
    this.callback = callback;
    return 1;
  }
  cancelAnimationFrame() {
    this.callback = undefined;
  }
  step() {
    const views = eyes();
    this.callback?.(0, {
      session: this,
      getPose: () => null,
      getViewerPose: () => ({ transform: views[0].transform, emulatedPosition: false, views }),
    });
  }
  async end() {
    this.callback = undefined;
    this.dispatchEvent(new Event('end'));
  }
}

/** The real XR engine route and real GPU eye textures; only headset/session delivery is simulated. */
export function installXRProbe() {
  const session = new Session();
  let color: GPUTexture;
  const savedSystem = Object.getOwnPropertyDescriptor(navigator, 'xr'),
    savedBinding = Object.getOwnPropertyDescriptor(globalThis, 'XRGPUBinding');
  class Binding implements XRBinding {
    static readonly webgl = !!(globalThis as { __margoCompat?: boolean }).__margoCompat;
    private depth: GPUTexture;
    constructor(_session: XRNativeSession, gpu: GPUDevice) {
      color = gpu.createTexture({ size: [SIZE, SIZE, 2], format: 'rgba8unorm', usage: 16 | 1 });
      this.depth = gpu.createTexture({ size: [SIZE, SIZE, 2], format: 'depth24plus', usage: 16 | 4 });
    }
    getPreferredColorFormat(): GPUTextureFormat {
      return 'rgba8unorm';
    }
    createProjectionLayer(): XRProjectionLayer {
      return {
        destroy: () => {
          color.destroy();
          this.depth.destroy();
        },
      };
    }
    getViewSubImage(_layer: XRProjectionLayer, view: XRView): XRSubImage {
      return {
        colorTexture: color,
        depthStencilTexture: this.depth,
        viewport: { x: 0, y: 0, width: SIZE, height: SIZE },
        getViewDescriptor: () => ({ dimension: '2d', baseArrayLayer: view.eye === 'left' ? 0 : 1, arrayLayerCount: 1 }),
      };
    }
  }
  const system: XRSystem = { isSessionSupported: async () => true, requestSession: async () => session };
  Object.defineProperty(navigator, 'xr', { configurable: true, value: system });
  Object.defineProperty(globalThis, 'XRGPUBinding', { configurable: true, value: Binding });
  return {
    session,
    get color() {
      return color;
    },
    restore() {
      if (savedSystem) Object.defineProperty(navigator, 'xr', savedSystem);
      else Reflect.deleteProperty(navigator, 'xr');
      if (savedBinding) Object.defineProperty(globalThis, 'XRGPUBinding', savedBinding);
      else Reflect.deleteProperty(globalThis, 'XRGPUBinding');
    },
  };
}
