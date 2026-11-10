// EXT_color_buffer_float guarantees 16F targets too. Firefox need not expose
// the older half-float extension separately. Mask 32F while retaining that
// already-backed 16F capability for a forced half-float test, on either browser.
export function maskTier(gl, tier) {
  const get = gl.getExtension.bind(gl);
  const half = get('EXT_color_buffer_half_float') ?? (get('EXT_color_buffer_float') ? {} : null);
  gl.getExtension = (name) => {
    if (tier !== 'full' && name === 'EXT_color_buffer_float') return null;
    if (name === 'EXT_color_buffer_half_float') return tier === 'ldr' ? null : half;
    return get(name);
  };
  return gl;
}
