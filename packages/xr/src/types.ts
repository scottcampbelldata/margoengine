// Structural browser types keep consumers independent of ambient WebXR declaration packages.
export type XRMode = 'inline' | 'immersive-vr' | 'immersive-ar';
export type XRSpace = object;
export interface XRPose {
  transform: {
    matrix: Float32Array;
    inverse: { matrix: Float32Array };
    position: { x: number; y: number; z: number; w: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
  emulatedPosition: boolean;
}
export interface XRView {
  eye: 'left' | 'right' | 'none';
  projectionMatrix: Float32Array;
  transform: XRPose['transform'];
}
export interface XRViewerPose extends XRPose {
  views: readonly XRView[];
}
export interface XRInputSource {
  handedness: 'left' | 'right' | 'none';
  targetRayMode: 'gaze' | 'tracked-pointer' | 'screen' | 'transient-pointer';
  targetRaySpace: XRSpace;
  gripSpace?: XRSpace;
  gamepad?: Gamepad;
  profiles: readonly string[];
  hand?: ReadonlyMap<string, XRSpace>;
}
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
  updateRenderState(state: { layers?: XRProjectionLayer[]; depthNear?: number; depthFar?: number }): void;
  requestAnimationFrame(callback: (time: number, frame: XRNativeFrame) => void): number;
  cancelAnimationFrame(handle: number): void;
  end(): Promise<void>;
}
export interface XRSystem {
  isSessionSupported(mode: XRMode): Promise<boolean>;
  requestSession(
    mode: XRMode,
    init: { requiredFeatures: string[]; optionalFeatures: string[] },
  ): Promise<XRNativeSession>;
}
export interface XRProjectionLayer {
  destroy(): void;
}
export interface XRSubImage {
  colorTexture: GPUTexture;
  depthStencilTexture: GPUTexture | null;
  viewport: { x: number; y: number; width: number; height: number };
  getViewDescriptor(): GPUTextureViewDescriptor;
}
export interface XRBinding {
  getPreferredColorFormat(): GPUTextureFormat;
  createProjectionLayer(init: {
    colorFormat: GPUTextureFormat;
    depthStencilFormat: GPUTextureFormat;
  }): XRProjectionLayer;
  getViewSubImage(layer: XRProjectionLayer, view: XRView): XRSubImage;
}
export interface XRInputPose {
  source: XRInputSource;
  targetRay: XRPose | null;
  grip: XRPose | null;
}
export interface XRFrameState {
  time: number;
  delta: number;
  frame: XRNativeFrame;
  viewer: XRViewerPose | null;
  inputs: XRInputPose[];
}
