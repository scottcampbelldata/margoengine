import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasManifest, packAtlasFrames } from '@margoengine/exporters/atlas';
import { createUnity2DBundle } from '@margoengine/exporters/unity-2d';

const opaque = (width, height) => ({ data: new Uint8Array(width * height * 4).fill(255), width, height });
function bordered() {
  const image = { data: new Uint8Array(8 * 8 * 4), width: 8, height: 8, name: 'body' };
  for (let y = 2; y < 6; y++) for (let x = 1; x < 4; x++) image.data[(y * 8 + x) * 4 + 3] = 255;
  return image;
}
const png = (byte) => new Uint8Array([137, byte]);
const get = (files, name) => files.find((f) => f.name === name)?.data;
const sprites = (meta) =>
  meta
    .split('    - serializedVersion: 2\n')
    .slice(1)
    .map((block) => ({
      name: JSON.parse(/name: (".*")/.exec(block)[1]),
      rect: ['x', 'y', 'width', 'height'].map((k) => Number(new RegExp(`\\n\\s+${k}: (\\d+)`).exec(block)[1])),
      pivot: /pivot: \{x: ([-\d.e]+), y: ([-\d.e]+)\}/.exec(block).slice(1).map(Number),
      border: /border: \{x: (\d+), y: (\d+), z: (\d+), w: (\d+)\}/.exec(block).slice(1).map(Number),
      alignment: /alignment: (\d+)/.exec(block)[1],
      spriteID: /spriteID: (\w+)/.exec(block)[1],
      internalID: /internalID: (\d+)/.exec(block)[1],
      block,
    }));
const atlasBundle = () => {
  const atlas = packAtlasFrames([bordered(), { ...opaque(4, 4), name: 'plain', pivot: { x: 0, y: 1 } }]),
    manifest = atlasManifest(atlas, { image: 'hero.png' });
  return {
    atlas,
    manifest,
    files: createUnity2DBundle({
      folder: 'Hero',
      manifest,
      pages: [png(1)],
      clips: {
        walk: { frames: ['body', 'plain'], fps: 10 },
        hit: { frames: ['plain'], loop: false, durations: [0.5] },
      },
      borders: { plain: { left: 1, bottom: 2, right: 3, top: 0 } },
    }),
  };
};

test('the file list is the images, their metas, the JSON and the C#, sorted', () => {
  assert.deepEqual(
    atlasBundle().files.map((f) => f.name),
    [
      'Editor.meta',
      'Editor/Build2D.cs',
      'Editor/Build2D.cs.meta',
      'MapTile.cs',
      'MapTile.cs.meta',
      'export-2d.json',
      'export-2d.json.meta',
      'hero.png',
      'hero.png.meta',
    ],
  );
});

test('the TextureImporter meta slices with Unity rects, Y up, and pivots that keep trimmed frames in place', () => {
  const { files, atlas } = atlasBundle(),
    meta = get(files, 'hero.png.meta'),
    page = atlas.pages[0],
    [body, plain] = sprites(meta),
    f = atlas.frames[0];
  assert.match(meta, /^fileFormatVersion: 2\nguid: [0-9a-f]{32}\nTextureImporter:/);
  assert.match(meta, /spriteMode: 2/);
  assert.match(meta, /textureType: 8/);
  assert.match(meta, /spritePixelsToUnits: 100/);
  assert.equal(body.name, 'body');
  assert.equal(body.alignment, '9');
  assert.deepEqual(body.rect, [f.x, page.height - f.y - f.height, 3, 4]);
  // The centre of an 8 x 8 image, from a 3 x 4 rect at (1, 2): 3/3 across, and half way up.
  assert.deepEqual(body.pivot, [1, 0.5]);
  assert.deepEqual(plain.pivot, [0, 0], 'the top left in map terms: x 0, and y 1 from the top is the bottom');
  assert.deepEqual(plain.border, [1, 2, 3, 0], 'left, bottom, right, top');
  assert.deepEqual(body.border, [0, 0, 0, 0]);
  assert.ok(meta.includes(`"body": ${body.internalID}`), 'the name table matches the sprite');
  assert.notEqual(body.spriteID, plain.spriteID);
});

test('GUIDs are stable across exports, differ by file, and the same input gives the same bytes', () => {
  const first = atlasBundle().files,
    second = atlasBundle().files;
  assert.deepEqual(first, second);
  const guids = first.filter((f) => f.name.endsWith('.meta')).map((f) => /guid: (\w+)/.exec(f.data)[1]);
  assert.ok(guids.every((g) => /^[0-9a-f]{32}$/.test(g)));
  assert.equal(new Set(guids).size, guids.length);
  const other = createUnity2DBundle({ folder: 'Other', manifest: atlasBundle().manifest, pages: [png(1)] });
  assert.notEqual(
    /guid: (\w+)/.exec(get(other, 'hero.png.meta'))[1],
    /guid: (\w+)/.exec(get(first, 'hero.png.meta'))[1],
  );
});

test('every clip is in the JSON with its page and seconds, and the C# reads those fields', () => {
  const { files } = atlasBundle(),
    data = JSON.parse(get(files, 'export-2d.json'));
  assert.deepEqual(data.clips, [
    {
      name: 'walk',
      loop: true,
      frames: [
        { sprite: 'body', page: 'hero.png', seconds: 0.1 },
        { sprite: 'plain', page: 'hero.png', seconds: 0.1 },
      ],
    },
    { name: 'hit', loop: false, frames: [{ sprite: 'plain', page: 'hero.png', seconds: 0.5 }] },
  ]);
  const editor = get(files, 'Editor/Build2D.cs');
  assert.match(editor, /const string Root = "Assets\/Hero"/);
  assert.match(editor, /\[MenuItem\("Tools\/Margo Export\/Hero"\)\]/);
  assert.match(editor, /namespace MargoExport\.Hero/);
  assert.match(editor, /"m_Sprite"/);
  assert.match(editor, /TilemapCollider2D/);
  assert.match(get(files, 'MapTile.cs'), /class MapTile : TileBase/);
  assert.equal(get(files, 'hero.png')[1], 1, 'the PNG goes through untouched');
});

const FLIP_H = 0x80000000;
const map = (over = {}) => ({
  width: 2,
  height: 1,
  tileWidth: 16,
  tileHeight: 16,
  tilesets: [
    {
      name: 'ground',
      firstGid: 1,
      tileWidth: 16,
      tileHeight: 16,
      tileCount: 4,
      columns: 2,
      margin: 1,
      spacing: 2,
      image: { source: 'ground.png', width: 36, height: 36 },
      tiles: [
        { id: 0, collision: [{ kind: 'rect', x: 0, y: 0, width: 16, height: 8 }] },
        {
          id: 3,
          animation: [
            { tileId: 3, duration: 100 },
            { tileId: 2, duration: 300 },
          ],
        },
      ],
      ...over,
    },
  ],
  layers: [
    { type: 'tile', name: 'floor', width: 2, height: 1, data: new Uint32Array([1, (4 | FLIP_H) >>> 0]) },
    { type: 'tile', name: 'hidden', width: 2, height: 1, data: new Uint32Array([2, 2]), visible: false },
  ],
});

test('a map gives a sliced tileset, named tiles with animation and collision, and placed cells', () => {
  const files = createUnity2DBundle({ map: map(), tilesetImages: { 'ground.png': png(2) } }),
    data = JSON.parse(get(files, 'export-2d.json')),
    cells = sprites(get(files, 'ground.png.meta'));
  assert.deepEqual(
    cells.map((c) => [c.name, ...c.rect]),
    [
      ['ground_0', 1, 19, 16, 16],
      ['ground_1', 19, 19, 16, 16],
      ['ground_2', 1, 1, 16, 16],
      ['ground_3', 19, 1, 16, 16],
    ],
  );
  assert.match(
    cells[0].block,
    /physicsShape:\n\s+- - \{x: -8, y: 8\}\n\s+- \{x: 8, y: 8\}\n\s+- \{x: 8, y: 0\}\n\s+- \{x: -8, y: 0\}/,
  );
  assert.match(cells[1].block, /physicsShape: \[\]/);
  assert.deepEqual(data.tiles, [
    { name: 'ground_0', image: 'ground.png', solid: true, frames: [], framesPerSecond: 1 },
    {
      name: 'ground_3',
      image: 'ground.png',
      solid: false,
      frames: ['ground_3', 'ground_2', 'ground_2', 'ground_2'],
      framesPerSecond: 10,
    },
  ]);
  assert.deepEqual(data.layers, [
    {
      name: 'floor',
      cells: [
        { x: 0, y: 0, tile: 'ground_0', flipH: false, flipV: false, flipD: false },
        { x: 1, y: 0, tile: 'ground_3', flipH: true, flipV: false, flipD: false },
      ],
    },
  ]);
  assert.equal(data.cellWidth, 0.16);
});

test('what cannot be built is refused with the fix named', () => {
  const { manifest } = atlasBundle();
  assert.throws(() => createUnity2DBundle({}), /manifest or a map/);
  assert.throws(() => createUnity2DBundle({ manifest, pages: [] }), /0 page images for 1/);
  assert.throws(() => createUnity2DBundle({ manifest, pages: [png(1)], folder: '../x' }), /folder \.\.\/x/);
  assert.throws(() => createUnity2DBundle({ manifest, pages: [png(1)], pixelsPerUnit: 0 }), /pixelsPerUnit 0/);
  assert.throws(() => createUnity2DBundle({ manifest, pages: [png(1)], clips: { x: { frames: ['no'] } } }), /frame no/);
  assert.throws(
    () => createUnity2DBundle({ map: map(), clips: { x: { frames: ['a'] } }, tilesetImages: { ground: png(1) } }),
    /need a manifest/,
  );
  assert.throws(() => createUnity2DBundle({ map: map() }), /Tileset ground has no image/);
  assert.throws(() => createUnity2DBundle({ map: map({ columns: 0 }), tilesetImages: {} }), /image collection/);
  assert.throws(
    () =>
      createUnity2DBundle({
        map: map({ tiles: [{ id: 0, collision: [{ kind: 'point', x: 0, y: 0 }] }] }),
        tilesetImages: { ground: png(1) },
      }),
    /collides with a point/,
  );
  assert.throws(
    () =>
      createUnity2DBundle({
        map: map({ tiles: [{ id: 0, animation: [{ tileId: 0, duration: 0.2 }] }] }),
        tilesetImages: { ground: png(1) },
      }),
    /under 1 ms/,
  );
});
