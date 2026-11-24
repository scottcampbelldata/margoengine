// Structural browser types keep consumers independent of ambient WebXR declaration packages.
/** Session kind: a windowed tracking-only session, or an immersive headset session. */
export type XRMode = 'inline' | 'immersive-vr' | 'immersive-ar';
/** An opaque WebXR reference or pose space. */
export type XRSpace = object;
/** A tracked pose: a matrix, its inverse, and position and orientation. */
export interface XRPose {
  transform: {
    matrix: Float32Array;
    inverse: { matrix: Float32Array };
    position: { x: number; y: number; z: number; w: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
  emulatedPosition: boolean;
}
/** One eye of a viewer pose. */
export interface XRView {
  eye: 'left' | 'right' | 'none';
  projectionMatrix: Float32Array;
  transform: XRPose['transform'];
}
/** The viewer pose, with one view per eye. */
export interface XRViewerPose extends XRPose {
  views: readonly XRView[];
}
/** A controller, hand, gaze or screen input. */
export interface XRInputSource {
  handedness: 'left' | 'right' | 'none';
  targetRayMode: 'gaze' | 'tracked-pointer' | 'screen' | 'transient-pointer';
  targetRaySpace: XRSpace;
  gripSpace?: XRSpace;
  gamepad?: Gamepad;
  profiles: readonly string[];
  hand?: ReadonlyMap<string, XRSpace>;
}
/** One XR animation frame, as the browser provides it. */
export interface XRNativeFrame {
  session: XRNativeSession;
  getViewerPose(space: XRSpace): XRViewerPose | null;
  getPose(space: XRSpace, relativeTo: XRSpace): XRPose | null;
  getJointPose?(space: XRSpace, relativeTo: XRSpace): XRPose | null;
  /** WebXR Hit Test Module: this frame's results for a hit test source, nearest first. */
  getHitTestResults?(source: XRHitTestSource): readonly XRHitTestResult[];
  /** WebXR Hit Test Module: this frame's results for a transient-input source, one entry per input source. */
  getHitTestResultsForTransientInput?(source: XRTransientInputHitTestSource): readonly XRTransientInputHitTestResult[];
}
/** WebXR Hit Test Module: what the real world a ray is tested against. */
export type XRHitTestTrackableType = 'point' | 'plane' | 'mesh';
/** A ray offset from its space's origin, as the browser's `XRRay` (origin and direction in that space). */
export interface XRRayLike {
  origin: { x: number; y: number; z: number; w: number };
  direction: { x: number; y: number; z: number; w: number };
}
/** A subscription to hit tests along a space's ray; `cancel()` ends it. */
export interface XRHitTestSource {
  cancel(): void;
}
/** A subscription to hit tests along the rays of transient inputs (screen taps) of one profile. */
export interface XRTransientInputHitTestSource {
  cancel(): void;
}
/** One intersection of a hit-test ray with the real world. */
export interface XRHitTestResult {
  getPose(baseSpace: XRSpace): XRPose | null;
  /** WebXR Anchors Module, where supported. */
  createAnchor?(): Promise<XRAnchor>;
}
/** The results of one transient input source. */
export interface XRTransientInputHitTestResult {
  readonly inputSource: XRInputSource;
  readonly results: readonly XRHitTestResult[];
}
/** WebXR Anchors Module: a pose the device keeps tracking as its understanding of the world improves. */
export interface XRAnchor {
  readonly anchorSpace: XRSpace;
  delete(): void;
}
/** The browser XRSession, as far as Margo uses it. */
export interface XRNativeSession extends EventTarget {
  inputSources: readonly XRInputSource[];
  enabledFeatures?: readonly string[];
  /** WebXR Hit Test Module (session feature 'hit-test'). */
  requestHitTestSource?(options: {
    space: XRSpace;
    entityTypes?: XRHitTestTrackableType[];
    offsetRay?: XRRayLike;
  }): Promise<XRHitTestSource>;
  /** WebXR Hit Test Module (session feature 'hit-test'). */
  requestHitTestSourceForTransientInput?(options: {
    profile: string;
    entityTypes?: XRHitTestTrackableType[];
    offsetRay?: XRRayLike;
  }): Promise<XRTransientInputHitTestSource>;
  requestReferenceSpace(type: string): Promise<XRSpace>;
  updateRenderState(state: {
    /** The projection layer, and with the WebXR Layers module any composition layers around it. */
    layers?: readonly object[];
    baseLayer?: unknown;
  /** Runtime foveation, from zero to one; null or absent when unsupported. */
  fixedFoveation?: number | null;
    depthNear?: number;
    depthFar?: number;
  }): void;
  requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void): number;
  cancelAnimationFrame(handle: number): void;
  end(): Promise<void>;
}
/** The browser `navigator.xr`, as far as Margo uses it. */
export interface XRSystem {
  isSessionSupported(mode: XRMode): Promise<boolean>;
  requestSession(
    mode: XRMode,
    init: { requiredFeatures: string[]; optionalFeatures: string[] },
  ): Promise<XRNativeSession>;
}
/** A WebGPU projection layer; destroy it when the session ends. */
export interface XRProjectionLayer {
  /** The XRWebGLLayer to show instead of this layer, on a binding that draws through one. */
  baseLayer?: unknown;
  /** Runtime foveation, from zero to one; null or absent when unsupported. */
  fixedFoveation?: number | null;
  destroy(): void;
}
/** The texture and viewport of one eye in a projection layer. */
export interface XRSubImage {
  colorTexture: GPUTexture;
  depthStencilTexture: GPUTexture | null;
  viewport: { x: number; y: number; width: number; height: number };
  getViewDescriptor(): GPUTextureViewDescriptor;
}
/** The WebGPU XR binding (`XRGPUBinding`) that creates layers and sub-images. */
export interface XRBinding {
  getPreferredColorFormat(): GPUTextureFormat;
  createProjectionLayer(init: {
    colorFormat: GPUTextureFormat;
    depthStencilFormat: GPUTextureFormat;
    /** Projection scale, defaults to the runtime recommendation. */
    scaleFactor?: number;
  }): XRProjectionLayer;
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRSubImage;
  /** The view's projection, where the session's differs from clip space with z in [0, 1]. */
  projection?(view: XRView): ArrayLike<number>;
  /** Shows the frame's sub-images, on a binding that does not draw straight into the session's layer. */
  present?(layer: XRProjectionLayer): void;
}
/** One input source with its target-ray and grip poses. */
export interface XRInputPose {
  source: XRInputSource;
  targetRay: XRPose | null;
  grip: XRPose | null;
}
/** State passed to `onFrame`; the object is reused, so copy what you keep. */
export interface XRFrameState {
  time: number;
  delta: number;
  frame: XRNativeFrame;
  viewer: XRViewerPose | null;
  inputs: XRInputPose[];
}
