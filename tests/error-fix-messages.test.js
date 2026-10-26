import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetURL } from '../packages/shared/asset-url.js';
import { readBytes } from '../packages/shared/loading.js';
import { triangulatePolygon } from '../packages/shared/polygon.js';
import { validatePreparedGeometry } from '../packages/shared/prepared-geometry.js';
import { rectFrame } from '../packages/shared/rect-frame.js';
import { viewMatrix } from '../packages/shared/view.js';

// Every message names its fix (docs/conventions.md, Errors): a `;` clause or a verb that tells the caller what to do.
const FIX = /;\s*(?:pass|use|move|remove|raise|check|run|simplify|post)\b/;
const fixed = (type) => (error) => error instanceof type && FIX.test(error.message);
const square = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];

test('shared validation errors name their fix', async () => {
  assert.throws(() => assetURL('', 'https://example.com/'), fixed(TypeError));
  assert.throws(() => assetURL('http://', 'https://example.com/'), fixed(TypeError));
  assert.throws(() => rectFrame([0, 1, 0], [0, 1, 0], 'Rect'), fixed(RangeError));
  assert.throws(() => viewMatrix(new Float32Array(16), { position: [1, 1, 1], target: [1, 1, 1] }), fixed(RangeError));
  assert.throws(
    () => validatePreparedGeometry({ vertices: new Float32Array(1), indices: new Uint32Array(3) }),
    fixed(RangeError),
  );
  await assert.rejects(readBytes(new Response(new Uint8Array(8)).body, { maxBytes: 4 }), fixed(RangeError));
  await assert.rejects(readBytes(new Response(new Uint8Array(8)).body, { maxBytes: -1 }), fixed(RangeError));
});

test('polygon errors name their fix', () => {
  assert.throws(() => triangulatePolygon(square, [], { maxVertices: 1 }), fixed(RangeError));
  assert.throws(() => triangulatePolygon(square, [], { maxVertices: 3 }), fixed(RangeError));
  assert.throws(
    () =>
      triangulatePolygon([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    fixed(RangeError),
  );
  assert.throws(
    () =>
      triangulatePolygon(square, [
        [
          [10, 10],
          [11, 10],
          [11, 11],
          [10, 11],
        ],
      ]),
    fixed(RangeError),
  );
  assert.throws(
    () =>
      triangulatePolygon(square, [
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
        ],
        [
          [1.5, 1.5],
          [3, 1.5],
          [3, 3],
          [1.5, 3],
        ],
      ]),
    fixed(RangeError),
  );
});

// The throw sites that used a bare Error now carry a MargoError code; reading the source keeps the check free of
// the GPU and the codecs the throws sit behind.
test('gltf-pro throws coded MargoErrors, never a bare Error', () => {
  for (const file of ['asset', 'compression', 'index', 'side-shader', 'worker']) {
    const source = readFileSync(new URL(`../packages/gltf-pro/src/${file}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /throw new Error\(/, `${file}.ts throws a bare Error; use margoError(code, message)`);
  }
});
