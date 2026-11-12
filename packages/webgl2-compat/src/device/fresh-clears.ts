/**
 * Lost clears of texture levels and layers (docs/known-bugs.md, "Radeon 680M, ANGLE Direct3D 11: a clear of a texture
 * level or layer whose last write was a clear is lost"). On the Radeon 680M under ANGLE D3D11 (driver 32.0.21030.2001),
 * raw WebGL2 keeps the clears of one subresource of a texture only, where the subresource's last write was a clear
 * (a fresh texture counts as cleared): a fresh 4 x 4 RGBA8 2D array or cube of 3 levels and 6 layers, each subresource
 * cleared to (0, 0, 0, 1) through one framebuffer, reads 17 of its 18 back as 0, 0, 0, 0, and after a draw or an upload
 * into every subresource the first round of clears lands but the second (to white) again keeps 1 of 18. 2D mips lose
 * levels 1 and 2 the same way. The adapter probes once; where clears are lost, the layer clears the colour
 * subresources of float and normalized textures with more than one level or layer by draws (zero() and render pass
 * loadOp clear), which always land.
 */

/**
 * True when this context drops the second clear of a fresh texture's level 1: a 4 x 4 RGBA8 texture with 2 levels,
 * both cleared to 0 and then to (0, 0, 0, 1). Level 0 must read (0, 0, 0, 255) for a verdict, so a context that reads
 * nothing (a test stand-in) is never flagged. Leaves the framebuffer and texture bindings as it found them (the
 * defaults before a device exists); false when the probe cannot run.
 */
export function clearsLost(gl: WebGL2RenderingContext): boolean {
  try {
    return probeFreshClears(gl);
  } catch {
    return false;
  }
}

function probeFreshClears(gl: WebGL2RenderingContext): boolean {
  const texture = gl.createTexture(),
    framebuffer = gl.createFramebuffer();
  for (let i = 0; i < 16 && gl.getError() !== 0; i++);
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 2, gl.RGBA8, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const at = (level: number) =>
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, level);
    for (const colour of [
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ])
      for (const level of [0, 1]) {
        at(level);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return false;
        gl.clearBufferfv(gl.COLOR, 0, colour);
      }
    const read = (level: number) => {
      at(level);
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px.join(',');
    };
    const first = read(0),
      second = read(1);
    return gl.getError() === 0 && first === '0,0,0,255' && second === '0,0,0,0';
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    // At most a few flags are set; the bound keeps a stand-in context whose getError never clears from spinning.
    for (let i = 0; i < 16 && gl.getError() !== 0; i++);
  }
}
