import { Engine } from '@margoengine/core';
import { Figure } from '@margoengine/sciviz';
import { attachWebGL2 } from '@margoengine/sciviz/webgl2';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { webglRestore } from '@margoengine/webgl2-compat/restore';

const assert = (value, message) => {
  if (!value) throw new Error(message);
};
const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message);
const encode = (image) => {
  let s = '';
  for (let i = 0; i < image.length; i += 8192) s += String.fromCharCode(...image.subarray(i, i + 8192));
  return btoa(s);
};
async function pixels(figure) {
  figure.render();
  const bitmap = await createImageBitmap(figure.engine.canvas);
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = copy.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return g.getImageData(0, 0, copy.width, copy.height).data;
}
function state(gl) {
  const parameters = [
    gl.CURRENT_PROGRAM,
    gl.VERTEX_ARRAY_BINDING,
    gl.ARRAY_BUFFER_BINDING,
    gl.ACTIVE_TEXTURE,
    gl.VIEWPORT,
    gl.SCISSOR_BOX,
    gl.DEPTH_FUNC,
    gl.DEPTH_WRITEMASK,
    gl.DEPTH_RANGE,
    gl.COLOR_WRITEMASK,
    gl.BLEND_SRC_RGB,
    gl.BLEND_DST_RGB,
    gl.BLEND_SRC_ALPHA,
    gl.BLEND_DST_ALPHA,
    gl.BLEND_EQUATION_RGB,
    gl.BLEND_EQUATION_ALPHA,
    gl.UNPACK_ALIGNMENT,
    gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_SKIP_PIXELS,
    gl.UNPACK_SKIP_ROWS,
    gl.PIXEL_UNPACK_BUFFER_BINDING,
    gl.UNPACK_FLIP_Y_WEBGL,
    gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
  ];
  const values = parameters.map((p) => {
    const v = gl.getParameter(p);
    return ArrayBuffer.isView(v) ? Array.from(v) : v;
  });
  const flags = [
    gl.DEPTH_TEST,
    gl.CULL_FACE,
    gl.BLEND,
    gl.SCISSOR_TEST,
    gl.RASTERIZER_DISCARD,
    gl.STENCIL_TEST,
    gl.POLYGON_OFFSET_FILL,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
    gl.SAMPLE_COVERAGE,
    gl.DITHER,
  ];
  const enabled = flags.map((f) => gl.isEnabled(f));
  const units = [0, 1].map((i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    return [gl.getParameter(gl.TEXTURE_BINDING_2D), gl.getParameter(gl.SAMPLER_BINDING)];
  });
  gl.activeTexture(values[3]);
  return { values, enabled, units };
}
function sameState(a, b) {
  // WebGL objects need identity comparison; JSON would turn every one into {}.
  for (let i = 0; i < a.values.length; i++) {
    if (Array.isArray(a.values[i])) equal(a.values[i], b.values[i], `GL state ${i}`);
    else assert(a.values[i] === b.values[i], `GL object/state ${i}`);
  }
  equal(a.enabled, b.enabled, 'GL enable flags');
  a.units.forEach((unit, i) => unit.forEach((v, j) => assert(v === b.units[i][j], `GL unit ${i} state ${j}`)));
}

window.runWebGLChecks = async () => {
  // Test-only single sampling for both APIs; never a production global set by sciviz.
  globalThis.margoLow = 1;
  const backend = new URLSearchParams(location.search).get('backend') === 'webgl2' ? 'webgl2' : 'webgpu';
  const canvas = document.querySelector('canvas');
  const engine = await Engine.create(canvas, { backend, fallback: webglRenderer, exactSize: true });
  engine.use(webglRestore());
  const errors = [];
  engine.onError = (e) => errors.push(String(e));
  engine.gpu?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  assert(engine.backend === backend, 'requested real engine backend');
  assert((engine.gpu === null) === (backend === 'webgl2'), 'native WebGL2 has no virtual WebGPU device');
  const images = {},
    checks = [];
  const checkGL = (where) => {
    if (backend !== 'webgl2') return;
    const gl = canvas.getContext('webgl2'),
      error = gl.getError();
    assert(error === gl.NO_ERROR, `${where}: GL error 0x${error.toString(16)}`);
  };
  const make = async (options = {}) => {
    const opts = { axes: false, ...options };
    return backend === 'webgl2' ? attachWebGL2(engine, opts) : Figure.attach(engine, opts);
  };
  try {
    for (const kind of [
      'bar',
      'histogram',
      'heatmap',
      'surface',
      'surface-contours',
      'surface-transparent',
      'surface-updated',
      'surface-hole',
    ]) {
      const surface = kind.startsWith('surface');
      const figure = await make({ mode: surface ? '3d' : '2d' });
      let layer, heights;
      if (surface) {
        engine.camera.position = [2.6, 1.7, 2.9];
        engine.camera.target = [0, 0, 0];
        engine.camera.up = [0, 1, 0];
        engine.camera.near = 0.01;
        engine.camera.far = 100;
        // A 2D chart owns its camera projection. Reset it before returning to a perspective view.
        engine.camera.project = undefined;
        const data = Float32Array.from({ length: 63 }, (_, k) => Math.sin(k % 9) * Math.cos(Math.floor(k / 9)));
        if (kind === 'surface-hole') data[31] = NaN;
        heights = data;
        layer = figure.surface(data, {
          nx: 9,
          ny: 7,
          range: [-1, 1],
          contours: kind === 'surface-contours' ? 7 : 0,
          grid: kind === 'surface-contours' ? 2 : 0,
          opacity: kind === 'surface-transparent' ? 0.4 : 1,
        });
        if (kind === 'surface-updated') {
          heights = Float32Array.from(data, (v) => -v);
          layer.setHeights(heights);
        }
      } else if (kind === 'bar') await figure.bar({ x: [1, 2, 3], y: [1, 3, 2] }, { color: '#e69f00' });
      else if (kind === 'histogram') await figure.histogram([1, 1, 2, 2, 2, 3, 4], { bins: 4 });
      else await figure.heatmap([0, 0.25, 0.5, NaN, 0.75, 1], { nx: 3, ny: 2, range: [0, 1] });
      await figure.ready();
      checkGL(`${kind} creation`);
      const image = await pixels(figure);
      checkGL(`${kind} first frame`);
      let lit = 0;
      for (let i = 0; i < image.length; i += 4)
        if (
          Math.max(
            Math.abs(image[i] - image[0]),
            Math.abs(image[i + 1] - image[1]),
            Math.abs(image[i + 2] - image[2]),
          ) > 24
        )
          lit++;
      assert(lit > 500, `${kind}: draws pixels`);
      images[kind] = { data: encode(image), lit };
      // A real renderer rebuild must reproduce every pixel, including the latest CPU surface update.
      await engine.rebootDevice();
      await figure.ready();
      checkGL(`${kind} reboot`);
      equal(encode(await pixels(figure)), images[kind].data, `${kind}: restored pixels`);
      checkGL(`${kind} restored frame`);
      if (backend === 'webgl2') {
        const gl = canvas.getContext('webgl2');
        const vao = gl.createVertexArray(),
          buffer = gl.createBuffer(),
          unpack = gl.createBuffer();
        const textures = [gl.createTexture(), gl.createTexture()],
          samplers = [gl.createSampler(), gl.createSampler()];
        let before, after;
        engine.use({
          name: 'state-before',
          setup() {},
          registerPasses(graph) {
            graph.add({
              name: 'state-before',
              order: 4,
              execute() {
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
                gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpack);
                for (const i of [0, 1]) {
                  gl.activeTexture(gl.TEXTURE0 + i);
                  gl.bindTexture(gl.TEXTURE_2D, textures[i]);
                  gl.bindSampler(i, samplers[i]);
                }
                gl.viewport(7, 9, 31, 41);
                gl.scissor(11, 13, 23, 29);
                gl.depthFunc(gl.GREATER);
                gl.depthMask(false);
                gl.depthRange(0.2, 0.8);
                gl.colorMask(false, true, false, true);
                gl.enable(gl.CULL_FACE);
                gl.enable(gl.BLEND);
                gl.enable(gl.RASTERIZER_DISCARD);
                gl.enable(gl.STENCIL_TEST);
                gl.enable(gl.POLYGON_OFFSET_FILL);
                gl.enable(gl.SAMPLE_COVERAGE);
                gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
                gl.blendEquationSeparate(gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
                gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 13);
                gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 2);
                gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 1);
                gl.activeTexture(gl.TEXTURE3);
                before = state(gl);
                checkGL(`${kind} hostile setup`);
              },
            });
          },
        });
        engine.use({
          name: 'state-after',
          setup() {},
          registerPasses(graph) {
            graph.add({
              name: 'state-after',
              order: 6,
              execute() {
                after = state(gl);
                checkGL(`${kind} hostile draw`);
              },
            });
          },
        });
        const hostileImage = await pixels(figure);
        sameState(before, after);
        equal(encode(hostileImage), images[kind].data, `${kind}: unaffected by caller GL state`);
        engine.removePlugin('state-before');
        engine.removePlugin('state-after');
        if (surface) {
          const beforeUpload = state(gl);
          layer.setHeights(heights);
          sameState(beforeUpload, state(gl));
          const extra = figure.surface(heights, { nx: 9, ny: 7, range: [-1, 1] });
          sameState(beforeUpload, state(gl));
          figure.remove(extra);
        }
        // Restore the hostile setup so the next main pass can clear normally.
        gl.depthFunc(gl.LESS);
        gl.depthMask(true);
        gl.depthRange(0, 1);
        gl.colorMask(true, true, true, true);
        for (const f of [gl.BLEND, gl.RASTERIZER_DISCARD, gl.STENCIL_TEST, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_COVERAGE])
          gl.disable(f);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindVertexArray(null);
        for (const i of [0, 1]) {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindSampler(i, null);
          gl.deleteTexture(textures[i]);
          gl.deleteSampler(samplers[i]);
        }
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(buffer);
        gl.deleteBuffer(unpack);
        assert(gl.getError() === gl.NO_ERROR, `${kind}: no GL errors`);
      }
      checks.push(`${kind}: pixels, restore${backend === 'webgl2' ? ', state ownership' : ''}`);
      figure.dispose();
      figure.dispose();
    }
    if (backend === 'webgl2') {
      const lostFigure = await make();
      const data = Float32Array.from({ length: 12 }, (_, i) => Math.sin(i));
      lostFigure.surface(data, { nx: 4, ny: 3, contours: 0 });
      const image = encode(await pixels(lostFigure));
      const gl = canvas.getContext('webgl2'),
        extension = gl.getExtension('WEBGL_lose_context');
      assert(extension, 'real GL context-loss extension available');
      const lost = new Promise((resolve) => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
      extension.loseContext();
      await lost;
      const recovery = engine.rebootDevice();
      const restored = new Promise((resolve) =>
        canvas.addEventListener('webglcontextrestored', resolve, { once: true }),
      );
      extension.restoreContext();
      await restored;
      await recovery;
      await lostFigure.ready();
      equal(encode(await pixels(lostFigure)), image, 'actual context loss reconstructs every surface pixel');
      lostFigure.dispose();
      checks.push('actual WEBGL_lose_context event and restoration preserve pixels');
      const figure = await make();
      await figure.ready();
      const rejected = async (run) => {
        try {
          await run();
        } catch (e) {
          assert(e.code === 'unsupported' && /errors#sciviz/.test(e.message), 'coded linked unsupported');
          return;
        }
        throw new Error('unsupported path did not reject');
      };
      await rejected(() => figure.scatter({ x: [0], y: [0] }));
      await rejected(() => figure.line({ x: [0, 1], y: [0, 1] }));
      await rejected(() => figure.volume(new Float32Array(8), { dims: [2, 2, 2] }));
      await rejected(() => figure.isosurface(new Float32Array(8), 0, { dims: [2, 2, 2] }));
      assert(figure.layers.length === 0, 'unavailable paths publish no partial layers');
      figure.dispose();
      checks.push('unimplemented layer paths reject with coded help, never silently drop data');
    }
    assert(!errors.length, errors.join('; '));
    return { backend, checks, images };
  } finally {
    engine.dispose();
  }
};
