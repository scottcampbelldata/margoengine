import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { videoMaterial } from '../dist/material.js';

const shader = `fn surface(i:Out,front:bool)->Surface {
  var s:Surface;s.base=f.base*i.color;
  if(s.base.a<0.5){discard;}return s;
}`;

test('external material imports on every draw, reuses samplers and never uploads pixels', () => {
  const dom = new JSDOM('<video></video>'),
    before = globalThis.HTMLVideoElement;
  globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
  try {
    const source = dom.window.document.querySelector('video');
    Object.defineProperties(source, { videoWidth: { value: 8 }, readyState: { value: 2 } });
    const imports = [],
      samplers = [],
      device = {
        createSampler: (desc) => {
          samplers.push(desc);
          return desc;
        },
        importExternalTexture: (desc) => {
          imports.push(desc);
          return { frame: imports.length };
        },
      };
    const feature = videoMaterial(source);
    const a = feature.bindings(device, { backend: 'webgpu' }),
      b = feature.bindings(device, { backend: 'webgpu' });
    assert.notEqual(a[0].resource, b[0].resource);
    assert.equal(a[1].resource, b[1].resource);
    assert.equal(imports.length, 2);
    assert.equal(imports[0].source, source);
    assert.equal(samplers.length, 1);
    const out = feature.shader(shader, 2);
    assert.match(out, /@group\(2\) @binding\(250\) var margoVideo:texture_external/);
    assert.match(out, /textureSampleBaseClampToEdge/);
    assert.match(out, /vec2f\(i.uv.xy.x,1.0-i.uv.xy.y\)/);
    assert.match(videoMaterial(source, { flipY: false }).shader(shader, 2), /margoVideoSampler,i.uv.xy\)/);
    assert.ok(out.indexOf('s.base*=') < out.indexOf('if(s.base.a'));
    assert.equal(feature.shader(shader, 2), out);
    assert.match(videoMaterial(source, { texCoord: 1 }).shader(shader, 3), /i.uv.zw/);
    assert.throws(
      () => feature.bindings(device, { backend: 'webgl2' }),
      (e) => e.code === 'unsupported' && /https:/.test(e.message),
    );
    assert.throws(
      () => feature.shader('no mesh surface', 2),
      (e) => e.code === 'unsupported',
    );
    assert.throws(() => videoMaterial(source, { texCoord: 2 }), RangeError);
    assert.throws(() => videoMaterial(source, { flipY: 1 }), TypeError);
    assert.throws(() => videoMaterial({}), TypeError);
  } finally {
    globalThis.HTMLVideoElement = before;
    dom.window.close();
  }
});

test('a pending or closed frame fails before importing an invalid resource', () => {
  const before = globalThis.VideoFrame;
  globalThis.VideoFrame = class {
    displayWidth = 0;
  };
  try {
    const feature = videoMaterial(new VideoFrame());
    assert.throws(
      () =>
        feature.bindings(
          {
            importExternalTexture() {
              assert.fail('unready import');
            },
          },
          {},
        ),
      (e) => e.code === 'state',
    );
  } finally {
    globalThis.VideoFrame = before;
  }
});
