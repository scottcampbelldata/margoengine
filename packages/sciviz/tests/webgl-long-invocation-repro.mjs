// Raw WebGL2 repro, no compatibility layer (docs/known-bugs.md, "a small raster's default chunk read back all zeros
// on the WebGL2 layer"): Chrome on ANGLE Metal drops a draw whose single vertex invocation runs too long. The draw
// stores nothing, gl.getError() stays 0 and the context is not lost; more total work spread over many shorter
// invocations lands. Not a gate: it prints one line per case, `dropped` the count of points that kept the cleared 0.
// Each case uses a fresh context; the long case runs last, because after a dropped draw later draws can be dropped too.
// Run: node packages/sciviz/tests/webgl-long-invocation-repro.mjs
// CASES='[[points, loop iterations per point], ...]' changes the cases.
import { openBrowser } from '../../../scripts/browser.js';
const cases = JSON.parse(process.env.CASES || '[[65536,4000],[640,4000],[64,100000]]');
const b = await openBrowser({ compat: false, startPath: '/packages/webgl2-compat/test/compute.html', port: 'free' });
try {
  const rows = await b.page.evaluate((cases) => {
    const out = [];
    for (const [points, n] of cases) {
      const gl = new OffscreenCanvas(256, 256).getContext('webgl2');
      const shader = (type, source) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const program = gl.createProgram();
      // Each point runs n iterations of 31 data-dependent integer steps fed from a texture, so nothing folds away.
      gl.attachShader(
        program,
        shader(
          gl.VERTEX_SHADER,
          `#version 300 es
uniform highp uint n; uniform highp usampler2D d; flat out highp uint o;
void main(){
 highp uint h=uint(gl_VertexID)+1u;
 for(highp uint i=0u;i<n;i++){highp uint v=texelFetch(d,ivec2(int(i&63u),0),0).x;for(highp uint k=0u;k<31u;k++){h=h*1664525u+(v^k);if(h<v){h+=7u;}}}
 o=h|1u;gl_PointSize=1.0;
 gl_Position=vec4((float(gl_VertexID&255)+0.5)/128.0-1.0,(float(gl_VertexID>>8)+0.5)/128.0-1.0,0.0,1.0);
}`,
        ),
      );
      gl.attachShader(
        program,
        shader(
          gl.FRAGMENT_SHADER,
          '#version 300 es\nflat in highp uint o; layout(location=0) out highp uvec4 c; void main(){ c = uvec4(o); }',
        ),
      );
      gl.linkProgram(program);
      const target = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, 256, 256);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.viewport(0, 0, 256, 256);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, 64, 1);
      const words = Uint32Array.from({ length: 64 }, (_, i) => Math.imul(i, 2654435761) >>> 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, words);
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(program);
      gl.uniform1ui(gl.getUniformLocation(program, 'n'), n);
      gl.uniform1i(gl.getUniformLocation(program, 'd'), 1);
      gl.bindVertexArray(gl.createVertexArray());
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array(4));
      gl.drawArrays(gl.POINTS, 0, points);
      const pixels = new Uint32Array(256 * 256 * 4);
      gl.readPixels(0, 0, 256, 256, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pixels);
      let dropped = 0;
      for (let i = 0; i < points; i++) if (pixels[i * 4] === 0) dropped++;
      out.push({ points, iterations: n, dropped, error: gl.getError(), lost: gl.isContextLost() });
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    const probe = new OffscreenCanvas(1, 1).getContext('webgl2');
    probe.getExtension('WEBGL_debug_renderer_info');
    return { renderer: probe.getParameter(0x9246), out };
  }, cases);
  console.log(rows.renderer);
  for (const row of rows.out) console.log(JSON.stringify(row));
} finally {
  await b.close();
}
