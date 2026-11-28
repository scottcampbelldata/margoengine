// Temporal raster jitter is not camera movement. Keep the source on the transient camera wrapper,
// using a shared symbol because optional package bundles have independent module instances.
export const temporalCameraSource = Symbol.for('margoengine.temporal-camera-source');
export const unjitteredCamera = (camera) => camera[temporalCameraSource] ?? camera;
// A capture drawn from the frame's own camera: a patched clip transform of core's vertex (TAA's or the upscaler's jittered
// `taaCamera`) gives way to `frame.camera`, and the patch's uniform stays statically used so its binding stays bound.
export const unjitteredClip = (code) =>
  code.replace(/o\.clip=(?!frame\.camera\*)([A-Za-z_]\w*)\*p;/, 'o.clip=frame.camera*p;_=$1;');
