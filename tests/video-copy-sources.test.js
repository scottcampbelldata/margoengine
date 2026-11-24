// Firefox (d), bug sweep L3a (2026-11-11): Firefox 157's copyExternalImageToTexture throws a TypeError for an
// HTMLVideoElement or VideoFrame source. Packages that may pass a video go through packages/shared/copy-external.js
// (materials, points, shader's Shadertoy media channels, xr), which draws such a frame on a canvas first. The bug
// sweep row named voxel and video as well: voxel makes no external copies, and video imports its frames with
// importExternalTexture, never copying them. This test pins that: every direct queue.copyExternalImageToTexture call in a package's source is listed here with the
// kinds of source it takes, none of them a video, so a new call (a video one above all) has to be looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Each package source file that calls copyExternalImageToTexture itself, and what its calls copy. */
const DIRECT = {
  'packages/creative/src/planet-pass.ts': 'decoded images',
  'packages/gltf/src/model.ts': 'glTF images (ImageBitmap)',
  'packages/gltf/src/textured.ts': 'glTF images (ImageBitmap)',
  'packages/html/src/texture.ts': 'an HTML element drawn on a canvas',
  'packages/inspector/src/frame.ts': 'the name only, in its list of queue calls it counts',
  'packages/materials/src/built-material.ts': 'images and canvases; videos go through shared/copy-external.js',
  'packages/materials/src/textures.ts': 'images and canvases',
  'packages/pixel/src/index.ts': 'images',
  'packages/quality/src/knobs.ts': 'a canvas',
  'packages/rigging/src/mtoon.ts': 'images',
  'packages/terrain/src/imagery.ts': 'imagery tiles (ImageBitmap)',
  'packages/transitions/src/live.ts': 'a mask bitmap (ImageData is written instead)',
  'packages/transitions/src/mask.ts': 'a mask bitmap (ImageData is written instead)',
};

test('the packages that take videos copy through shared/copy-external.js', () => {
  for (const file of [
    'packages/materials/src/built-material.ts',
    'packages/points/src/plugin.ts',
    'packages/shader/src/shadertoy.ts',
    'packages/xr/src/layers.ts',
  ])
    assert.match(readFileSync(join(root, file), 'utf8'), /shared\/copy-external\.js/, file);
});

/** A call of the queue method (or a reference to it by name, as the inspector's list of queue calls). */
const CALL = /\.copyExternalImageToTexture\b|'copyExternalImageToTexture'/;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

test('every direct copyExternalImageToTexture call in package sources is a known, non-video one', () => {
  const found = {};
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sources(src))
      if (CALL.test(readFileSync(file, 'utf8')))
        found[relative(root, file).replaceAll('\\', '/')] = true;
  }
  // The WebGL2 layer implements the call; it is not a caller.
  const callers = Object.keys(found)
    .filter((file) => !file.startsWith('packages/webgl2-compat/'))
    .sort();
  assert.deepEqual(callers, Object.keys(DIRECT).sort(), 'a new direct caller: route any video source through shared/copy-external.js, then list it');
});

test('voxel makes no external copies, and video imports its frames rather than copying them', () => {
  for (const pkg of ['voxel', 'video'])
    for (const file of sources(join(root, 'packages', pkg, 'src')))
      assert.equal(CALL.test(readFileSync(file, 'utf8')), false, file);
  const video = [...sources(join(root, 'packages', 'video', 'src'))].map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.match(video, /importExternalTexture\(/);
});
