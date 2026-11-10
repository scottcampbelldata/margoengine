import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { videoDomeMaterial } from '../dist/dome.js';

test('dome accepts all projection and packing combinations with eye borders and validated sources', () => {
  const before = globalThis.HTMLVideoElement,
    dom = new JSDOM('<video></video>');
  globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
  try {
    const source = dom.window.document.querySelector('video'),
      code = 'fn surface(i:Out,front:bool)->Surface {var s:Surface;s.base=f.base*i.color;return s;}';
    for (const layout of ['mono', 'stereo-left-right', 'stereo-top-bottom'])
      for (const eye of ['left', 'right'])
        for (const angle of [180, 360]) {
          const feature = videoDomeMaterial(source, { layout, eye, angle }),
            out = feature.shader(code, 2);
          assert.match(out, /@group\(2\) @binding\(250\)/);
          assert.match(out, /origin\+border,origin\+span-border/);
          assert.equal(out.includes('(p.x-0.25)*2.0'), angle === 180);
          assert.equal(out.includes('s.base=vec4f(0,0,0,1)'), angle === 180);
          assert.ok(
            out.includes(
              `span=vec2f(${layout === 'stereo-left-right' ? '0.5' : '1.0'},${layout === 'stereo-top-bottom' ? '0.5' : '1.0'})`,
            ),
          );
          assert.throws(
            () => feature.bindings({}, { backend: 'webgl2' }),
            (e) => e.code === 'unsupported',
          );
        }
    for (const options of [{ layout: 'bad' }, { eye: 'middle' }, { angle: 90 }])
      assert.throws(() => videoDomeMaterial(source, options));
    Object.defineProperty(source, 'videoHeight', { value: 1 });
    assert.throws(() => videoDomeMaterial(source, { layout: 'stereo-top-bottom' }).bindings({}, {}), RangeError);
    assert.throws(() => videoDomeMaterial({}), TypeError);
  } finally {
    globalThis.HTMLVideoElement = before;
    dom.window.close();
  }
});
