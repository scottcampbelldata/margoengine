import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { video360Material, video360Layer } from '../dist/panorama.js';
import { XRLayers } from '../../xr/dist/layers.js';
test('sphere feature maps the documented axes and clamps inside each stereo eye', () => {
  const before = globalThis.HTMLVideoElement,
    dom = new JSDOM('<video></video>');
  globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
  try {
    const source = dom.window.document.querySelector('video');
    const shader = 'fn surface(i:Out,front:bool)->Surface {var s:Surface;s.base=f.base*i.color;return s;}';
    for (const eye of ['left', 'right']) {
      const feature = video360Material(source, { layout: 'stereo-left-right', eye });
      const out = feature.shader(shader, 2);
      assert.match(out, /fract\(0.25-uv.x\),1.0-uv.y/);
      assert.match(out, /span=vec2f\(0.5,1.0\)/);
      assert.ok(out.includes(`origin=vec2f(${eye === 'right' ? '0.5' : '0.0'},0.0)`));
      assert.match(out, /textureDimensions\(margoVideo\)/);
      assert.match(out, /margoVideoSampler,margoPanoramaUV\(i.uv.xy\)/);
      assert.throws(
        () => feature.bindings({}, { backend: 'webgl2' }),
        (e) => e.code === 'unsupported' && /https:/.test(e.message),
      );
    }
    assert.match(video360Material(source).shader(shader, 2), /span=vec2f\(1.0,1.0\)/);
    assert.throws(() => video360Material(source, { eye: 'center' }), TypeError);
    assert.throws(() => video360Material(source, { layout: 'cube' }), TypeError);
    Object.defineProperty(source, 'videoWidth', { value: 1 });
    assert.throws(
      () => video360Material(source, { layout: 'stereo-left-right' }).bindings({}, { backend: 'webgpu' }),
      (e) => e instanceof RangeError && /at least two pixels/.test(e.message),
    );
  } finally {
    globalThis.HTMLVideoElement = before;
    dom.window.close();
  }
});
test('XR adapter reaches XRMediaBinding equirect creation and retains native panel lifecycle', () => {
  const previous = [globalThis.XRMediaBinding, globalThis.XRRigidTransform];
  const session = new EventTarget();
  session.enabledFeatures = ['layers'];
  const native = [],
    states = [];
  let destroyed = 0;
  globalThis.XRRigidTransform = class {
    constructor(position, orientation) {
      this.position = position;
      this.orientation = orientation;
    }
  };
  globalThis.XRMediaBinding = class {
    constructor(s) {
      assert.equal(s, session);
    }
    createEquirectLayer(source, init) {
      native.push({ source, init });
      return {
        destroy() {
          destroyed++;
        },
      };
    }
  };
  const host = {
    session,
    referenceSpace: {},
    layerBinding: { binding: {}, device: {} },
    onFrame: () => () => {},
    setLayers: (...args) => states.push(args),
  };
  const layers = XRLayers.attach(host),
    source = { videoWidth: 256, videoHeight: 64 };
  try {
    const panel = video360Layer(layers, source, { layout: 'stereo-left-right' });
    assert.equal(native.length, 1);
    assert.equal(native[0].source, source);
    assert.equal(native[0].init.layout, 'stereo-left-right');
    assert.equal(native[0].init.radius, 0);
    assert.equal(native[0].init.space, host.referenceSpace);
    assert.equal(native[0].init.invertStereo, false);
    panel.dispose();
    assert.equal(destroyed, 1);
    assert.ok(states.length > 0);
  } finally {
    layers.dispose();
    [globalThis.XRMediaBinding, globalThis.XRRigidTransform] = previous;
  }
});
test('XR route delegates to existing native equirect layers, preserves disposal and errors', () => {
  const source = {},
    panel = { dispose() {} },
    calls = [];
  const layers = {
    video: (...args) => {
      calls.push(args);
      return panel;
    },
  };
  assert.equal(video360Layer(layers, source, { layout: 'stereo-left-right', radius: 5 }), panel);
  assert.deepEqual(calls[0], [source, { shape: 'equirect', layout: 'stereo-left-right', radius: 5 }]);
  video360Layer(layers, source);
  assert.deepEqual(calls[1][1], { shape: 'equirect', layout: 'mono', radius: 0 });
  assert.throws(() => video360Layer(layers, source, { radius: NaN }), RangeError);
  const error = Object.assign(Error('unsupported; see https://margoengine.com/errors#xr'), { code: 'unsupported' });
  assert.throws(
    () =>
      video360Layer(
        {
          video() {
            throw error;
          },
        },
        source,
      ),
    (e) => e === error,
  );
});
