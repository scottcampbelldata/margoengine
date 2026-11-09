import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FontOutlines,
  classifyLoops,
  extrudeText,
  parseFontOutlines,
  pointInPolygon,
  polygonArea,
  triangulatePolygon,
} from '../dist/extrude.js';
import { buildColorFont } from './color-font.js';

test('polygonArea calculates signed area of 2D loops', () => {
  const ccwSquare = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  assert.equal(polygonArea(ccwSquare), 4);

  const cwSquare = [
    [0, 0],
    [0, 2],
    [2, 2],
    [2, 0],
  ];
  assert.equal(polygonArea(cwSquare), -4);
});

test('pointInPolygon tests point containment in 2D loop', () => {
  const square = [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ];
  assert.equal(pointInPolygon([2, 2], square), true);
  assert.equal(pointInPolygon([5, 2], square), false);
  assert.equal(pointInPolygon([-1, 2], square), false);
});

test('classifyLoops organizes outer loops and nested holes', () => {
  const outer = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole = [
    [2, 2],
    [2, 8],
    [8, 8],
    [8, 2],
  ]; // Clockwise
  const shapes = classifyLoops([outer, hole]);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].outer.length, 4);
  assert.equal(shapes[0].holes.length, 1);
  assert.equal(shapes[0].holes[0].length, 4);
});

test('triangulatePolygon triangulates simple polygons and polygons with holes', () => {
  // Simple quad
  const quad = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const simple = triangulatePolygon(quad);
  assert.equal(simple.indices.length, 6);

  // Polygon with a hole
  const outer = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole = [
    [3, 3],
    [3, 7],
    [7, 7],
    [7, 3],
  ];
  const withHole = triangulatePolygon(outer, [hole]);
  assert.ok(withHole.indices.length >= 12, 'Triangulates polygon with hole');

  // Verify total triangulated area equals outerArea - holeArea
  let totalArea = 0;
  for (let i = 0; i < withHole.indices.length; i += 3) {
    const a = withHole.vertices[withHole.indices[i]];
    const b = withHole.vertices[withHole.indices[i + 1]];
    const c = withHole.vertices[withHole.indices[i + 2]];
    totalArea += 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  }
  assert.ok(Math.abs(totalArea - (100 - 16)) < 1e-4, `Expected area 84, got ${totalArea}`);
});

test('parseFontOutlines reads TrueType SFNT metadata and glyph outlines', () => {
  const fontBuffer = buildColorFont();
  const font = parseFontOutlines(fontBuffer);
  assert.ok(font instanceof FontOutlines);
  assert.equal(font.unitsPerEm, 1000);
  assert.ok(typeof font.ascender === 'number');
  assert.ok(typeof font.descender === 'number');

  // Emoji character mapped in test font
  const glyphIdx = font.glyphIndex(0x1f600);
  assert.ok(glyphIdx > 0, 'Finds mapped glyph');
  const advance = font.glyphAdvance(glyphIdx);
  assert.ok(advance > 0, 'Has valid advance width');

  const contours = font.getGlyphContours(glyphIdx, 6);
  assert.ok(contours.length > 0, 'Extracts glyph contours');
  for (const loop of contours) {
    assert.ok(loop.length >= 3, 'Each contour has at least 3 points');
  }
});

test('extrudeText creates 3D solid text meshes with caps and walls', () => {
  const fontBuffer = buildColorFont();
  const geo = extrudeText('\u{1F600}', {
    font: fontBuffer,
    size: 2,
    depth: 0.5,
    bevelEnabled: false,
  });

  assert.ok(geo.positions.length > 0);
  assert.ok(geo.normals.length === geo.positions.length);
  assert.ok(geo.uvs.length === (geo.positions.length / 3) * 2);
  assert.ok(geo.indices.length > 0);
  assert.equal(geo.groups.length, 2, 'Has material group 0 (caps) and group 1 (walls)');

  // Bounding box checks
  assert.ok(geo.boundingBox.max[2] - geo.boundingBox.min[2] >= 0.49);
  assert.ok(geo.boundingBox.max[0] > geo.boundingBox.min[0]);
  assert.ok(geo.boundingBox.max[1] > geo.boundingBox.min[1]);
});

test('extrudeText supports bevels and multi-line alignment', () => {
  const fontBuffer = buildColorFont();
  const geoBevel = extrudeText('\u{1F600}\n\u{1F600}', {
    font: fontBuffer,
    size: 1,
    depth: 0.4,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.03,
    bevelSegments: 2,
    align: 'center',
    lineHeight: 1.5,
  });

  assert.ok(geoBevel.positions.length > 0);
  assert.ok(geoBevel.indices.length > 0);
  assert.equal(geoBevel.groups.length, 2);

  // Group 0 is caps, group 1 is walls/bevels
  const capCount = geoBevel.groups[0].count;
  const wallCount = geoBevel.groups[1].count;
  assert.ok(capCount > 0);
  assert.ok(wallCount > 0);
  assert.equal(geoBevel.groups[0].start, 0);
  assert.equal(geoBevel.groups[1].start, capCount);
});

test('extrudeText handles empty or missing text cleanly', () => {
  const fontBuffer = buildColorFont();
  const empty = extrudeText('', { font: fontBuffer });
  assert.equal(empty.positions.length, 0);
  assert.equal(empty.indices.length, 0);
  assert.equal(empty.groups.length, 0);
  assert.deepEqual(empty.boundingBox.min, [0, 0, 0]);
  assert.deepEqual(empty.boundingBox.max, [0, 0, 0]);
});

test('extrudeText validates arguments with descriptive errors', () => {
  const fontBuffer = buildColorFont();
  assert.throws(() => extrudeText('test', null), /extrudeText requires a font/);
  assert.throws(
    () => extrudeText('test', { font: fontBuffer, size: -1 }),
    /extrudeText size must be a positive finite number/,
  );
  assert.throws(
    () => extrudeText('test', { font: fontBuffer, depth: -0.1 }),
    /extrudeText depth must be a non-negative finite number/,
  );
  assert.throws(() => parseFontOutlines(new Uint8Array([0, 1, 2])), /Font file buffer is too small/);
});
