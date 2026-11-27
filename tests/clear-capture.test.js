// KB-CLEAR-CAPTURE1: a scene's background colour (sRGB bytes) was written as the clear value of every colour target,
// also of a post effect's linear HDR capture, so the display transform encoded it a second time (#808080 drew 181 under
// Tonemap, Bloom and PostStack). Core now clears a capture's target (a target a pass drew the scene into instead of the
// frame's own) that holds linear light (a float format, or an -srgb format, whose clear value the device encodes on
// store) with the colour decoded by the sRGB transfer function (IEC 61966-2-1), on both of its clear paths: the
// attachment clear of a whole view and the drawn clear of a part of one. The frame's own target (the canvas, a view's
// target of any format) and a display-encoded capture still take the bytes as given.
// KB-CLEAR-DEFAULT1: core's own clear colour (no background set) was the same numbers, 0.018, 0.023, 0.035, on every
// target: display values on the canvas (5,6,9) and linear light in a capture (7,20,38 under Tonemap). It now takes the
// path of a background: the same decode for a linear capture, on both clear paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureClearColor, clearColorValue, defaultClear } from '../packages/shared/clear-color.js';
import { gpuDrawHarness } from './support/core-draw-gpu.js';

const decode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
  grey = 128 / 255,
  bytes = [grey, grey, grey, 1],
  linearGrey = [decode(grey), decode(grey), decode(grey), 1],
  // Core's own clear colour as linear light: its display values decoded like a background's.
  linearDefault = [decode(0.018), decode(0.023), decode(0.035), 1];
const close = (actual, expected, label) => {
  assert.equal(actual.length, 4, label);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}: ${actual} vs ${expected}`);
};

test('captureClearColor decodes sRGB for a linear capture and keeps the bytes for any other target', () => {
  for (const capture of [undefined, false, '', 'bgra8unorm', 'rgba8unorm', 'rgb10a2unorm'])
    assert.deepEqual(captureClearColor('#808080', capture), bytes, String(capture));
  for (const capture of ['rgba16float', 'rg11b10ufloat', 'rgba32float', 'rgba8unorm-srgb', 'bgra8unorm-srgb'])
    close(captureClearColor('#808080', capture), linearGrey, capture);
  // Both branches of the curve: 7/255 is below the 0.04045 knee, 15/255 above it; alpha stays 1.
  close(captureClearColor('#07090f', 'rgba16float'), [decode(7 / 255), decode(9 / 255), decode(15 / 255), 1], 'dark');
  close(captureClearColor('#ffffff', 'rgba16float'), [1, 1, 1, 1], 'white');
  close(captureClearColor('#000', 'rgba16float'), [0, 0, 0, 1], 'black');
  // Unset is core's clear colour, by the same path: as given on a display-encoded target, decoded for a linear capture.
  assert.deepEqual(defaultClear, [0.018, 0.023, 0.035, 1]);
  for (const unset of [undefined, false]) {
    for (const capture of [undefined, false, '', 'bgra8unorm', 'rgba8unorm', 'rgb10a2unorm'])
      assert.equal(captureClearColor(unset, capture), defaultClear, String(capture));
    for (const capture of ['rgba16float', 'rg11b10ufloat', 'rgba32float', 'rgba8unorm-srgb', 'bgra8unorm-srgb'])
      close(captureClearColor(unset, capture), linearDefault, `unset, ${capture}`);
  }
  // One array for every linear capture: the clear-colour cache keys on the value and a frame allocates nothing.
  assert.equal(captureClearColor(undefined, 'rgba16float'), captureClearColor(undefined, 'rg11b10ufloat'));
  // A background of core's displayed colour (5,6,9) is the same linear light to within the byte's rounding.
  captureClearColor('#050609', 'rgba16float').forEach((v, i) =>
    assert.ok(Math.abs(v - linearDefault[i]) < 0.5 / 255 / 12.92 + 1e-9, `channel ${i}`),
  );
  assert.throws(() => captureClearColor('#12345', 'rgba16float'), { name: 'RangeError' });
  // With no capture it is clearColorValue, the bytes-only form the display-encoded targets keep (the WebGL2 preview,
  // sciviz tiles), which takes no format.
  for (const colour of ['#808080', '#07090f', '#abc', undefined])
    assert.deepEqual(captureClearColor(colour), clearColorValue(colour), String(colour));
  assert.deepEqual(clearColorValue('#808080', 'rgba16float'), bytes, 'clearColorValue has no capture form');
});

const full = (c) => ({ id: '0', camera: c.camera, viewport: [0, 0, c.width, c.height], index: 0, count: 1 });
// A capture, as SceneTarget.begin makes one: the pass context's colour target and its format are the capture's.
const capture = (c, format) => {
  c.color = { capture: format };
  c.format = format;
};

test("core's attachment clear decodes for a linear capture and keeps the bytes on the frame's own target", (t) => {
  const h = gpuDrawHarness(t),
    clearOf = (format, view, color = '#808080') => {
      h.frame((draw, c) => {
        c.view = { ...(view ? c.view : full(c)), clear: color ? { color } : undefined };
        if (format) capture(c, format);
        draw();
      }, view);
      return h.passes.at(-1).descriptor.colorAttachments[0].clearValue;
    },
    // A view drawing into the caller's own texture, in the shape the mock device reports.
    target = (format) => ({
      rect: [0, 0, 64, 32],
      index: 0,
      count: 1,
      id: 't',
      target: { color: { format, sampleCount: 1, width: 64, height: 32, createView: () => ({ caller: format }) } },
    });
  assert.deepEqual(clearOf(), bytes, 'no capture: the canvas takes the bytes');
  close(clearOf('rgba16float'), linearGrey, 'a post capture (rgba16float)');
  close(clearOf('rg11b10ufloat'), linearGrey, "the WebGL2 layer's capture (rg11b10ufloat)");
  close(clearOf('rgba8unorm-srgb'), linearGrey, 'an -srgb capture');
  assert.deepEqual(clearOf('bgra8unorm'), bytes, 'a display-encoded capture (FXAA, SMAA) takes the bytes');
  // The canvas again after a capture frame: nothing of the capture's colour is kept.
  assert.deepEqual(clearOf(), bytes, 'the canvas after a capture');
  // No capture: core's own shader writes display colour into a view's target whatever its format, so the clear
  // colour stays the bytes there, as before the fix.
  for (const format of ['rgba16float', 'rgba8unorm-srgb', 'rgba8unorm'])
    assert.deepEqual(clearOf(undefined, target(format)), bytes, `a view's own ${format} target, no capture`);
  // A capture of a view that itself draws into a float target is still a capture.
  close(clearOf('rgba16float', target('rgba16float')), linearGrey, 'a capture inside a float view target');
  // No background (KB-CLEAR-DEFAULT1): core's own clear colour by the same rule.
  assert.deepEqual(clearOf(undefined, undefined, null), defaultClear, 'unset: the canvas');
  for (const format of ['rgba16float', 'rg11b10ufloat', 'rgba8unorm-srgb'])
    close(clearOf(format, undefined, null), linearDefault, `unset: a linear capture (${format})`);
  assert.deepEqual(clearOf('bgra8unorm', undefined, null), defaultClear, 'unset: a display-encoded capture');
  assert.deepEqual(clearOf(undefined, undefined, null), defaultClear, 'unset: the canvas after a capture');
  for (const format of ['rgba16float', 'rgba8unorm-srgb', 'rgba8unorm'])
    assert.deepEqual(clearOf(undefined, target(format), null), defaultClear, `unset: a view's own ${format} target`);
});

test("core's drawn clear of a partial view writes the linear colour on a linear capture", (t) => {
  const h = gpuDrawHarness(t),
    writes = [];
  h.device.queue.writeBuffer = (buffer, offset, data) => {
    if (buffer.size === 16) writes.push([...data]);
  };
  const partial = (format, color = '#808080') =>
    h.frame((draw, c) => {
      c.view = { ...full(c), viewport: [0, 0, 80, 60], clear: color ? { color } : undefined };
      if (format) capture(c, format);
      draw();
    });
  partial();
  partial('rgba16float');
  // The clear colour's uniform holds the colour at float32 precision; one per colour, cached per device, so the
  // canvas's bytes and the capture's linear colour are two entries and neither is drawn with the other's.
  assert.equal(writes.length, 2, JSON.stringify(writes));
  close(writes[0], bytes.map(Math.fround), 'canvas');
  close(writes[1], linearGrey.map(Math.fround), 'capture');
  assert.ok(
    h.passes.at(-1).commands.some(([name]) => name === 'fullscreen'),
    'the partial view clears by drawing',
  );
  // Both again: the cached colours are reused, nothing new is written.
  partial();
  partial('rgba16float');
  assert.equal(writes.length, 2, 'the cached colours are reused');
  // No background (KB-CLEAR-DEFAULT1): core's own colour as given on the canvas, decoded on the linear capture.
  partial(undefined, null);
  partial('rgba16float', null);
  assert.equal(writes.length, 4, JSON.stringify(writes));
  close(writes[2], defaultClear.map(Math.fround), 'unset: canvas');
  close(writes[3], linearDefault.map(Math.fround), 'unset: capture');
});
