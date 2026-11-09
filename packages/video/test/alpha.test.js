import test from 'node:test';
import assert from 'node:assert/strict';
import { stackedAlphaMaterial, chromaKeyMaterial } from '../dist/alpha.js';
const shader =
  'fn surface(i:Out,front:bool)->Surface {var s:Surface;s.base=f.base*i.color;if(s.base.a<0.5){discard;}return s;}';
const withFrame = (run) => {
  const before = globalThis.VideoFrame;
  globalThis.VideoFrame = class {
    displayWidth = 8;
    displayHeight = 8;
  };
  try {
    run(new VideoFrame());
  } finally {
    globalThis.VideoFrame = before;
  }
};
test('stacked masks sample straight colour and raw alpha within separate half-texel rectangles', () =>
  withFrame((frame) => {
    for (const layout of ['top-bottom', 'left-right']) {
      const feature = stackedAlphaMaterial(frame, { layout, flipY: false, texCoord: 1 }),
        code = feature.shader(shader, 3);
      assert.match(code, /textureDimensions\(margoVideo\)/);
      assert.match(code, /i.uv.zw/);
      assert.match(code, /margoVideoColor.a\*margoStackAlpha/);
      assert.ok(code.indexOf('margoVideoColor.a*margoStackAlpha') < code.indexOf('if(s.base.a'));
      assert.match(code, layout === 'top-bottom' ? /margoAlphaSpan=vec2f\(1,0.5\)/ : /margoAlphaSpan=vec2f\(0.5,1\)/);
      assert.equal(feature.name, 'videoMaterial');
    }
    const device = { importExternalTexture: () => ({}), createSampler: () => ({}) };
    assert.equal(stackedAlphaMaterial(frame).bindings(device, {}).length, 2);
    frame.displayHeight = 3;
    assert.throws(() => stackedAlphaMaterial(frame).bindings(device, {}), RangeError);
    frame.displayHeight = 1;
    assert.throws(() => stackedAlphaMaterial(frame).bindings(device, {}), RangeError);
    frame.displayHeight = 8;
    frame.displayWidth = 3;
    assert.throws(() => stackedAlphaMaterial(frame, { layout: 'left-right' }).bindings(device, {}), RangeError);
    assert.throws(() => stackedAlphaMaterial(frame, { layout: 'other' }), TypeError);
  }));
test('RGB key operates on sRGB before linear colour conversion and material alpha test', () =>
  withFrame((frame) => {
    const color = [0, 0, 1],
      feature = chromaKeyMaterial(frame, { color, threshold: 0.25, softness: 0.25 });
    color[2] = 0;
    const out = feature.shader(shader, 2);
    assert.match(out, /smoothstep\(0.25,0.5,distance\(margoVideoColor.rgb,vec3f\(0,0,1\)\)\)/);
    assert.ok(out.indexOf('smoothstep(') < out.indexOf('if(s.base.a'));
    assert.match(chromaKeyMaterial(frame).shader(shader, 0), /vec3f\(0,1,0\)/);
    for (const options of [
      { threshold: -1 },
      { softness: 0 },
      { softness: NaN },
      { threshold: Infinity },
      { threshold: 1, softness: 1e-20 },
      { color: [0, 2, 0] },
      { color: [0, 1] },
      { color: Array(3) },
    ])
      assert.throws(() => chromaKeyMaterial(frame, options), RangeError);
    for (const feature of [stackedAlphaMaterial(frame), chromaKeyMaterial(frame)])
      assert.throws(
        () => feature.bindings({}, { backend: 'webgl2' }),
        (e) => e.code === 'unsupported' && /https:/.test(e.message),
      );
  }));
