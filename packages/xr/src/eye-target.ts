import type { XRBinding, XRSubImage, XRView } from './types.js';
/** The scene depth of one eye, as the eye's renderer left it, for passes that compare against it. */
export interface XREyeSceneDepth {
  /** Depth-only texture, multisampled where the eye renders with MSAA; read it with `textureLoad`. */
  readonly texture: GPUTexture;
  /** The column-major projection that wrote it: clip w is the view-space distance (-z), clip z / w the stored depth. */
  readonly projection: ArrayLike<number>;
  /** The texel of the eye's top-left pixel in `texture`. */
  readonly origin: readonly [number, number];
  /** The value an empty sample holds: 1 for forward depth, 0 for reversed. */
  readonly clear: number;
}
/** One eye after scene rendering, before submission to the XR compositor. */
export interface XREyeTarget {
  /** Stable index of the view within this frame. */
  readonly index: number;
  readonly device: GPUDevice;
  readonly encoder: GPUCommandEncoder;
  readonly image: XRSubImage;
  readonly view: XRView;
  /** The eye's scene depth, valid until the encoder is submitted. */
  readonly scene?: XREyeSceneDepth;
  /** The session's XR binding, for per-view resources such as GPU depth information. */
  readonly binding?: XRBinding;
}
