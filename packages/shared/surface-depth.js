// A surface drawn after the opaque scene into its own copy of the scene depth (Water samples the opaque depth for its
// shoreline, so it cannot write the depth it reads) puts this frame's copy here, and a later pass that needs the depth
// with the surface in it (VolumetricFog) reads it. Kept on the pass context for the encoder and view it was drawn in,
// so a frame or view without the surface never reads a stale or destroyed texture.
const key = Symbol.for('margoengine.optional.surface-depth');
export function publishSurfaceDepth(c, texture) {
  c[key] = { encoder: c.encoder, view: c.view, texture };
}
export function surfaceDepth(c) {
  const entry = c[key];
  return entry && entry.encoder === c.encoder && entry.view === c.view ? entry.texture : undefined;
}
