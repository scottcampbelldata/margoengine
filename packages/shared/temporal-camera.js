// Temporal raster jitter is not camera movement. Keep the source on the transient camera wrapper,
// using a shared symbol because optional package bundles have independent module instances.
export const temporalCameraSource = Symbol.for('margoengine.temporal-camera-source');
export const unjitteredCamera = (camera) => camera[temporalCameraSource] ?? camera;
