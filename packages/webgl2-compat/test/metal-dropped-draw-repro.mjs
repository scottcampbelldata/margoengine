// Raw WebGL2 repro, no compatibility layer (docs/known-bugs.md "Batch 132 audit: animation"): Chrome on ANGLE Metal
// drops the first draw through a framebuffer after the context's OffscreenCanvas was shown with transferToImageBitmap,
// when its texture was uploaded to since its last draw. Not a gate: it prints what this browser does, one line per
// order (mode), with `second` 9 where the draw landed and 0 where it was dropped.
// Run: node packages/webgl2-compat/test/metal-dropped-draw-repro.mjs
import { openBrowser } from '../../../scripts/browser.js';
const b = await openBrowser({ compat: false, startPath: '/packages/webgl2-compat/test/compute.html', port: 'free' });
try {
  const r = await b.page.evaluate(() => {
    const run = (present, pbo, mode = '') => {
      const c = new OffscreenCanvas(64, 64),
        gl = c.getContext('webgl2');
      const sh = (t, s) => {
        const x = gl.createShader(t);
        gl.shaderSource(x, s);
        gl.compileShader(x);
        return x;
      };
      const p = gl.createProgram();
      gl.attachShader(
        p,
        sh(
          gl.VERTEX_SHADER,
          '#version 300 es\nuniform highp uint v; flat out highp uint o; void main(){ o = v; gl_PointSize = 1.0; gl_Position = vec4((float(gl_VertexID) + 0.5) / 4096.0 * 2.0 - 1.0, 0.0, 0.0, 1.0); }',
        ),
      );
      gl.attachShader(
        p,
        sh(
          gl.FRAGMENT_SHADER,
          '#version 300 es\nflat in highp uint o; layout(location=0) out highp uvec4 c; void main(){ c = uvec4(o); }',
        ),
      );
      gl.linkProgram(p);
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, 4096, 1);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 2048, gl.DYNAMIC_DRAW);
      const upload = () => {
        gl.bindTexture(gl.TEXTURE_2D, t);
        if (pbo) {
          gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buf);
          gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, 0, new Uint32Array(512));
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, 0);
          gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(512));
      };
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      upload();
      const f = gl.createFramebuffer();
      const draw = (v) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.viewport(0, 0, 4096, 1);
        gl.useProgram(p);
        gl.uniform1ui(gl.getUniformLocation(p, 'v'), v);
        gl.drawArrays(gl.POINTS, 0, 4);
        const out = new Uint32Array(16);
        gl.readPixels(0, 0, 4, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return out[0];
      };
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const first = draw(7);
      if (mode === 'before') upload();
      if (present) {
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        c.transferToImageBitmap().close();
      }
      if (mode === 'reattach-first') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      }
      if (mode === 'draw-first') draw(5);
      if (mode !== 'none' && mode !== 'before') upload();
      if (mode === 'reattach') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      }
      const second = draw(9);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        mode,
        present,
        pbo,
        first,
        second,
        error: gl.getError(),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        ua: navigator.userAgent,
      };
    };
    return [
      run(true, true, 'reattach-first'),
      run(true, true, 'draw-first'),
      run(false, true),
      run(true, true),
      run(true, false),
      run(true, true, 'none'),
      run(true, true, 'before'),
      run(true, true, 'reattach'),
    ].map((x) => JSON.stringify(x));
  });
  console.log(r.join('\n'));
} finally {
  await b.close();
}
