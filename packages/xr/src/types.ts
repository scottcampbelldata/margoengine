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
}
export interface XRNativeSession extends EventTarget {
  inputSources: readonly XRInputSource[];
  enabledFeatures?: readonly string[];
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
