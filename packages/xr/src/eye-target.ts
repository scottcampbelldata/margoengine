import type { XRSubImage, XRView } from './types.js';
/** One eye after scene rendering, before submission to the XR compositor. */
export interface XREyeTarget {
  /** Stable index of the view within this frame. */
  readonly index: number;
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly image: XRSubImage;
  readonly view: XRView;
}
