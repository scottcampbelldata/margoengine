import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasManifest, packAtlasFrames } from '@margoengine/exporters/atlas';
import {
  createGodotTileMapScript,
  godotSpriteFrames,
  godotTileCells,
  godotTileSet,
} from '@margoengine/exporters/godot-2d';

// Parses this writer's text resources back: sections with their header fields and key = value lines.
function parseResource(text) {
  const sections = [];
  let open = '';
  for (const line of text.split('\n')) {
    if (open) {
      sections.at(-1).values[open.key] += `\n${line}`;
      if (
        (sections.at(-1).values[open.key].match(/[[{]/g) ?? []).length ===
        (sections.at(-1).values[open.key].match(/[\]}]/g) ?? []).length
      )
        open = '';
      continue;
    }
    const header = /^\[(\w+)(.*)\]$/.exec(line);
    if (header) {
      const fields = Object.fromEntries(
        [...header[2].matchAll(/(\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2].replace(/"/g, '')]),
      );
      sections.push({ tag: header[1], fields, values: {} });
    } else if (line.includes(' = ')) {
      const at = line.indexOf(' = '),
        key = line.slice(0, at),
        value = line.slice(at + 3);
      sections.at(-1).values[key] = value;
      if (/^[[{]/.test(value) && (value.match(/[[{]/g) ?? []).length !== (value.match(/[\]}]/g) ?? []).length)
        open = { key };
    }
  }
  return sections;
}

const pixels = (width, height, alpha = 255) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = alpha;
  return { data, width, height };
};
function bordered() {
  const image = pixels(8, 8, 0);
  for (let y = 2; y < 6; y++) for (let x = 1; x < 4; x++) image.data[(y * 8 + x) * 4 + 3] = 255;
  return { ...image, name: 'b"ody' };
}

test('SpriteFrames: atlas textures, trim margins, relative durations, loops and references that resolve', () => {
  const atlas = packAtlasFrames([bordered(), { ...pixels(4, 4), name: 'plain' }]),
    manifest = atlasManifest(atlas, { image: 'hero.png' }),
    text = godotSpriteFrames(
      manifest,
      {
        walk: { frames: ['b"ody', 'plain', 'b"ody'], fps: 10, durations: [0.1, 0.25, 0.1] },
        idle: { frames: ['plain'], loop: false },
      },
      { folder: 'res://art/' },
    ),
    sections = parseResource(text),
    subs = sections.filter((s) => s.tag === 'sub_resource'),
    body = atlas.frames[0];
  assert.equal(sections[0].fields.type, 'SpriteFrames');
  assert.equal(sections[0].fields.format, '3');
  assert.equal(sections[0].fields.load_steps, String(1 + 2 + 1), 'one page, two textures, the resource');
  assert.equal(sections[1].fields.path, 'res://art/hero.png');
  assert.deepEqual(
    subs.map((s) => s.fields.id),
    ['AtlasTexture_0', 'AtlasTexture_1'],
    'each frame once, ids unique',
  );
  assert.equal(subs[0].values.region, `Rect2(${body.x}, ${body.y}, 3, 4)`);
  assert.equal(subs[0].values.margin, 'Rect2(1, 2, 5, 4)');
  assert.equal(subs[0].values.atlas, 'ExtResource("page_0")');
  const animations = sections.at(-1).values.animations;
  assert.match(animations, /"name": &"walk",\n"speed": 10\.0/);
  assert.match(animations, /"loop": false,\n"name": &"idle",\n"speed": 12\.0/);
  assert.match(animations, /"duration": 2\.5,\n"texture": SubResource\("AtlasTexture_1"\)/);
  for (const [, id] of animations.matchAll(/SubResource\("([^"]+)"\)/g))
    assert.ok(
      subs.some((s) => s.fields.id === id),
      `${id} defined`,
    );
});

test('SpriteFrames: a name with quotes stays quoted, and bad clips are refused', () => {
  const manifest = atlasManifest(packAtlasFrames([{ ...pixels(1, 1), name: 'a' }]));
  assert.match(godotSpriteFrames(manifest, { 'say "hi"': { frames: ['a'] } }), /&"say \\"hi\\""/);
  assert.throws(() => godotSpriteFrames(manifest, {}), /needs clips/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: [] } }), /no frames/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: ['b'] } }), /frame b, not in the atlas/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: ['toString'] } }), /not in the atlas/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: ['a'], fps: 0 } }), /fps 0/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: ['a'], durations: [] } }), /0 durations/);
  assert.throws(() => godotSpriteFrames(manifest, { x: { frames: ['a'], durations: [0] } }), /lasts 0 s/);
});

const tileset = (over = {}) => ({
  name: 'ground',
  firstGid: 1,
  tileWidth: 16,
  tileHeight: 16,
  tileCount: 8,
  columns: 4,
  margin: 1,
  spacing: 2,
  image: { source: 'ground.png', width: 70, height: 36 },
  ...over,
});
const FLIP_H = 0x80000000,
  FLIP_V = 0x40000000,
  FLIP_D = 0x20000000;
const map = (tilesets, data = new Uint32Array(4)) => ({
  width: 2,
  height: 2,
  tileWidth: 16,
  tileHeight: 16,
  tilesets,
  layers: [
    { type: 'tile', name: 'floor', width: 2, height: 2, data },
    { type: 'tile', name: 'off', width: 2, height: 2, data: new Uint32Array([1, 1, 1, 1]), visible: false },
    { type: 'object', name: 'things', objects: [] },
  ],
});

test('TileSet: atlas sources, physics relative to the centre, animation columns and custom data', () => {
  const text = godotTileSet(
      map([
        tileset({
          tiles: [
            {
              id: 0,
              type: 'wall',
              properties: { hp: 3, slip: 0.5 },
              collision: [{ kind: 'rect', x: 0, y: 0, width: 16, height: 8 }],
            },
            {
              id: 1,
              properties: { hp: 2.5, solid: true },
              collision: [
                {
                  kind: 'polygon',
                  x: 8,
                  y: 8,
                  points: [
                    { x: 0, y: 0 },
                    { x: 8, y: 0 },
                    { x: 0, y: 8 },
                  ],
                },
              ],
            },
            {
              id: 4,
              animation: [
                { tileId: 4, duration: 100 },
                { tileId: 5, duration: 250 },
                { tileId: 6, duration: 100 },
              ],
            },
          ],
        }),
        tileset({
          name: 'b',
          firstGid: 9,
          tileCount: 1,
          columns: 1,
          margin: 0,
          spacing: 0,
          image: { source: 'b.png', width: 16, height: 16 },
        }),
      ]),
      { folder: 'res://tiles' },
    ),
    sections = parseResource(text),
    first = sections.find((s) => s.fields.id === 'source_0').values,
    resource = sections.at(-1).values;
  assert.equal(sections[0].fields.type, 'TileSet');
  assert.equal(sections[0].fields.load_steps, '5');
  assert.equal(sections[1].fields.path, 'res://tiles/ground.png');
  assert.equal(first.texture, 'ExtResource("image_0")');
  assert.equal(first.margins, 'Vector2i(1, 1)');
  assert.equal(first.separation, 'Vector2i(2, 2)');
  assert.equal(first.texture_region_size, 'Vector2i(16, 16)');
  assert.equal(first['0:0/0'], '0');
  assert.equal(first['0:0/0/physics_layer_0/polygon_0/points'], 'PackedVector2Array(-8, -8, 8, -8, 8, 0, -8, 0)');
  assert.equal(first['1:0/0/physics_layer_0/polygon_0/points'], 'PackedVector2Array(0, 0, 8, 0, 0, 8)');
  assert.equal(first['0:1/animation_columns'], '3');
  assert.equal(first['0:1/animation_speed'], '1.0');
  assert.equal(first['0:1/animation_frame_1/duration'], '0.25');
  assert.equal(first['1:1/0'], undefined, 'cells an animation covers are not tiles of their own');
  assert.equal(first['2:1/0'], undefined);
  assert.equal(first['3:1/0'], '0');
  assert.equal(resource.tile_size, 'Vector2i(16, 16)');
  assert.equal(resource['physics_layer_0/collision_layer'], '1');
  const names = [0, 1, 2, 3].map((i) => [
    resource[`custom_data_layer_${i}/name`],
    resource[`custom_data_layer_${i}/type`],
  ]);
  assert.deepEqual(
    names,
    [
      ['"type"', '4'],
      ['"hp"', '3'],
      ['"slip"', '3'],
      ['"solid"', '1'],
    ],
    'an int and a float share a float layer',
  );
  assert.equal(first['0:0/0/custom_data_0'], '"wall"');
  assert.equal(first['0:0/0/custom_data_1'], '3.0');
  assert.equal(first['1:0/0/custom_data_1'], '2.5');
  assert.equal(first['1:0/0/custom_data_3'], 'true');
  assert.equal(resource['sources/1'], 'SubResource("source_1")');
});

test('TileSet: ellipses become outlines; what Godot cannot hold is refused with the fix named', () => {
  const ellipse = godotTileSet(
    map([tileset({ tiles: [{ id: 0, collision: [{ kind: 'ellipse', x: 0, y: 0, width: 16, height: 16 }] }] })]),
  );
  const line = /polygon_0\/points = PackedVector2Array\((.*)\)/.exec(ellipse)[1].split(', ').map(Number);
  assert.equal(line.length, 32);
  assert.ok(line.every((v) => Math.abs(v) <= 8));
  const rotated = godotTileSet(
    map([
      tileset({ tiles: [{ id: 0, collision: [{ kind: 'rect', x: 8, y: 8, width: 8, height: 2, rotation: 90 }] }] }),
    ]),
  );
  assert.match(rotated, /PackedVector2Array\(0, 0, 0, 8, -2, 8, -2, 0\)/);
  assert.throws(() => godotTileSet(map([])), /no tilesets/);
  assert.throws(() => godotTileSet(map([tileset({ columns: 0, image: undefined })])), /image collection/);
  assert.throws(
    () => godotTileSet(map([tileset({ tiles: [{ id: 0, collision: [{ kind: 'point', x: 0, y: 0 }] }] })])),
    /collides with a point/,
  );
  assert.throws(
    () =>
      godotTileSet(
        map([
          tileset({
            tiles: [
              {
                id: 0,
                animation: [
                  { tileId: 0, duration: 1 },
                  { tileId: 7, duration: 1 },
                ],
              },
            ],
          }),
        ]),
      ),
    /consecutive atlas cells/,
  );
  assert.throws(
    () =>
      godotTileSet(
        map([
          tileset({
            tiles: [
              {
                id: 3,
                animation: [
                  { tileId: 3, duration: 1 },
                  { tileId: 4, duration: 1 },
                ],
              },
            ],
          }),
        ]),
      ),
    /consecutive atlas cells/,
    'a block that wraps from a later column',
  );
  assert.throws(
    () =>
      godotTileSet(
        map([
          tileset({
            tiles: [
              { id: 0, properties: { a: 1 } },
              { id: 1, properties: { a: 'x' } },
            ],
          }),
        ]),
      ),
    /property a is used with two types/,
  );
});

test('cells: every placed tile, flips as transform bits, and the script calls set_cell, not tile_map_data', () => {
  const data = new Uint32Array([0, 2, (6 | FLIP_H) >>> 0, (9 | FLIP_V | FLIP_D) >>> 0]),
    cells = godotTileCells(map([tileset(), tileset({ name: 'b', firstGid: 9, tileCount: 1, columns: 1 })], data));
  assert.deepEqual(cells, {
    version: 1,
    layers: [
      {
        name: 'floor',
        cells: [
          [1, 0, 0, 1, 0, 0],
          [0, 1, 0, 1, 1, 4096],
          [1, 1, 1, 0, 0, 8192 | 16384],
        ],
      },
    ],
  });
  assert.throws(() => godotTileCells(map([tileset()], new Uint32Array([99, 0, 0, 0]))), /tile 99, in no tileset/);
  const script = createGodotTileMapScript();
  assert.match(script, /^extends Node2D/);
  assert.match(script, /layer\.set_cell\(/);
  assert.match(script, /TileMapLayer\.new\(\)/);
  assert.doesNotMatch(script, /tile_map_data/);
  assert.ok(script.split('\n').filter((l) => l.startsWith(' ')).length === 0, 'GDScript indents with tabs here');
});
