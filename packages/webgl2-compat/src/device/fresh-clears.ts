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

/**
 * The colour a clear by draw writes for `value` into a target of `format` (drawClears): the value rounded on the CPU to
 * the step the target's clear stores. A draw goes through the colour export, which narrows the shader's float its own
 * way: the Radeon 680M under ANGLE D3D11 truncates it to binary16 before the 8 or 10-bit UNORM conversion, so a clear
 * by draw of 0.1 into rgba8unorm stored 25 where native WebGPU's clear stores round(0.1 x 255) = 26, and sRGB targets
 * one step off too (features-browser.mjs clearByDraw: 16 of 60 clears differed before). A value on the format's own
 * grid survives any narrowing to 11 or more significant bits, so every GPU then stores the nearest step, as a clear
 * does. An sRGB target gets the linear value of its nearest encoded step; float formats keep the value.
 */
export function drawnClear(format: string, value: ArrayLike<number>): number[] {
  const v = Array.from(value, (x) => Math.fround(x));
  const step = (x: number, steps: number) => Math.round(Math.min(1, Math.max(0, x)) * steps) / steps;
  if (format === 'rgb10a2unorm') return [step(v[0], 1023), step(v[1], 1023), step(v[2], 1023), step(v[3], 3)];
  const unorm8 = /^(r|rg|rgba|bgra)8unorm(-srgb)?$/.exec(format);
  if (!unorm8) return v;
  if (!unorm8[2]) return v.map((x) => step(x, 255));
  // sRGB (IEC 61966-2-1): encode, round to the 255 steps, and decode that step back to the linear value the export
  // encodes; alpha is linear.
  const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return v.map((x, i) => (i === 3 ? step(x, 255) : decode(step(encode(Math.min(1, Math.max(0, x))), 255))));
}
