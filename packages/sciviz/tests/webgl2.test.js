import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Figure, SciRenderer, SurfaceLayer, RectsLayer } from '@margoengine/sciviz';
import { attachWebGL2 } from '@margoengine/sciviz/webgl2';

function fixture() {
  const resources = [],
    inputs = [];
  const resource = () => {
    const r = {
      uniforms: [],
      heights: [],
      draws: 0,
      freed: 0,
      update(v) {
        this.uniforms.push(v.slice());
      },
      setHeights(v) {
        this.heights.push(v.slice());
      },
      draw() {
        this.draws++;
      },
      dispose() {
        this.freed++;
      },
    };
    resources.push(r);
    return r;
  };
  const driver = {
    setup() {},
    dispose() {},
    render(_context, visible) {
      for (const d of visible) d.drawGL({});
    },
    surface(data, nx, ny) {
      inputs.push({ data: Array.from(data), nx, ny });
      return resource();
    },
    rects: resource,
  };
  const renderer = new SciRenderer({ fallback: driver });
  const engine = {
    backend: 'webgl2',
    gpu: null,
    use(p) {
      p.setup(this);
    },
    removePlugin() {},
  };
  renderer.setup(engine);
  return { renderer, driver, engine, resources, inputs };
}

test('native WebGL2 is explicit: wrong backend and missing axes:false reject before touching the engine', async () => {
  const unsupported = (e) => e.code === 'unsupported' && /errors#sciviz/.test(e.message);
  await assert.rejects(attachWebGL2({ backend: 'webgpu' }, { axes: false }), unsupported);
  await assert.rejects(attachWebGL2({ backend: 'webgl2' }, {}), unsupported);
  await assert.rejects(attachWebGL2({ backend: 'webgl2' }), unsupported);
  assert.throws(() => new SciRenderer().setup({ gpu: null }), /attachWebGL2.*sciviz\/webgl2/);
});

test('native texture and draw-count limits reject before shader or data allocation', async () => {
  const gl = { MAX_TEXTURE_SIZE: 1, getParameter: () => 32768 };
  const engine = {
    backend: 'webgl2',
    gpu: null,
    canvas: { getContext: () => gl },
    use(p) {
      p.setup(this);
    },
    removePlugin() {},
  };
  const figure = await attachWebGL2(engine, { axes: false });
  assert.throws(() => figure.surface({ length: 65536 * 2 }, { nx: 65536, ny: 2, range: [0, 1] }), /MAX_TEXTURE_SIZE/);
  assert.throws(
    () => figure.surface({ length: 32768 ** 2 }, { nx: 32768, ny: 32768, range: [0, 1] }),
    /vertex-count limit/,
  );
  assert.deepEqual(figure.layers, []);
  figure.dispose();
});

test('abort before or during lazy attachment retains the exact reason and touches no engine resources', async () => {
  let touched = 0;
  const engine = {
    backend: 'webgl2',
    use() {
      touched++;
    },
    canvas: {
      getContext() {
        touched++;
      },
    },
  };
  for (const before of [true, false]) {
    const controller = new AbortController(),
      reason = { canceled: before };
    if (before) controller.abort(reason);
    const pending = attachWebGL2(engine, { axes: false, signal: controller.signal });
    if (!before) controller.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
  }
  assert.equal(touched, 0);
});

test('surface updates, latest-height restoration and disposal use only the injected native driver', () => {
  const f = fixture(),
    layer = new SurfaceLayer(f.renderer, [0, 1, 2, 3, 4, 5], { nx: 3, ny: 2, range: [0, 5] });
  const model = new Float32Array([2, 0, 0, 0, 0, 0, -3, 0, 0, 4, 0, 0, 1, 2, 3, 1]);
  layer.setModel(model);
  layer.drawGL({});
  const first = f.resources[0],
    uniform = first.uniforms[0];
  assert.deepEqual(uniform.subarray(0, 16), model);
  assert.deepEqual(Array.from(uniform.subarray(32, 36)), [0, 1, 0, 1]);
  assert.deepEqual(Array.from(new Uint32Array(uniform.buffer).subarray(36, 40)), [3, 2, 0, 0]);
  assert.equal(first.draws, 1);
  const updated = new Float32Array([5, 4, 3, 2, 1, 0]);
  layer.setHeights(updated);
  updated.fill(42);
  assert.deepEqual(first.heights[0], new Float32Array([5, 4, 3, 2, 1, 0]));
  layer.restore();
  assert.equal(first.freed, 1);
  assert.deepEqual(f.inputs[1].data, [5, 4, 3, 2, 1, 0], 'restore uses last update, with an owned copy');
  layer.drawGL({});
  assert.deepEqual(f.resources[1].uniforms[0], uniform);
  layer.dispose();
  layer.dispose();
  assert.equal(f.resources[1].freed, 1);
});

test('native surfaces reject foreign GPU buffers and malformed grids before allocating driver resources', () => {
  const f = fixture();
  const gpu = { storage: {}, buffer: {}, shape: [2, 2], size: 4 };
  assert.throws(
    () => new SurfaceLayer(f.renderer, gpu, { range: [0, 1] }),
    (e) => e.code === 'unsupported',
  );
  assert.throws(() => new SurfaceLayer(f.renderer, [0, 1, 2], { nx: 3, ny: 2 }), RangeError);
  assert.equal(f.resources.length, 0);
});

test('rectangles keep data/picking bounds and rebuild/dispose the native draw resources', () => {
  const f = fixture();
  const rects = new Float32Array([1, 2, 3, 4, 4, 5, 6, 7]);
  const layer = new RectsLayer(
    f.renderer,
    'bar',
    rects,
    new Float32Array([2, 2]),
    new Uint32Array([0xff0000ff, 0xff00ff00]),
    { swatch: '#ff0000' },
  );
  layer.drawGL({});
  assert.deepEqual(layer.bounds, [1, 6, 2, 7, 0, 0]);
  assert.equal(layer.indexAt(2, 3), 0);
  assert.equal(f.resources[0].uniforms[0][16], -0.5);
  layer.restore();
  assert.equal(f.resources[0].freed, 1);
  layer.dispose();
  layer.dispose();
  assert.equal(f.resources[1].freed, 1);
});

test('unimplemented native layers reject before allocating or publishing and never attach warning-only plugins', async () => {
  const f = fixture(),
    figure = new Figure(f.engine, { axes: false }, f.renderer);
  const unsupported = (e) => e.code === 'unsupported' && /errors#sciviz/.test(e.message);
  await assert.rejects(figure.scatter({ x: [0], y: [0] }), unsupported);
  await assert.rejects(figure.line({ x: [0, 1], y: [0, 1] }), unsupported);
  assert.throws(() => figure.volume(new Float32Array(8), { dims: [2, 2, 2] }), unsupported);
  await assert.rejects(figure.isosurface(new Float32Array(8), 0, { dims: [2, 2, 2] }), unsupported);
  assert.deepEqual(figure.layers, []);
  assert.equal(f.resources.length, 0);
  figure.dispose();
});

test('the root and CPU extraction do not import the optional native drawing implementation', async () => {
  for (const name of ['index', 'figure', 'render', 'surface', 'rects', 'fallback']) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()\s*['"][^'"]*\/webgl2(?:\.js)?['"]/);
  }
});
