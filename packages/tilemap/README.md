# @margoengine/tilemap

Import `margoengine/tilemap` from the `margoengine` package, or `@margoengine/tilemap` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

The 2D tile map format every other piece builds on: `TileMapData` holds the tile size, tilesets with per-tile properties, animation and collision shapes, tile layers as `Uint32Array` with Tiled's flip bits, object layers, parallax, offset, opacity and custom properties. The root entry has the types, small helpers and the `TileMap` renderer; auto-tiling and the Tiled importer are their own entries. `TileMap` draws orthogonal maps; `GridTileMap` of the `iso` entry draws isometric, staggered and hexagonal ones. (`@margoengine/tiles` is OGC 3D Tiles; this package is unrelated.)

```ts
import {createTileLayer, encodeTile, FLIP_H, tileAt, validateTileMap, type TileMapData} from 'margoengine/tilemap';
const ground = createTileLayer('ground', 2, 2, Uint32Array.of(1, encodeTile(2, FLIP_H), 0, 1));
const map: TileMapData = {
  width: 2, height: 2, tileWidth: 16, tileHeight: 16, layers: [ground],
  tilesets: [{name: 'grass', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 2, columns: 2,
    image: {source: 'grass.png', width: 32, height: 16}, tiles: [{id: 1, properties: {solid: true}}]}],
};
validateTileMap(map);
console.log(tileAt(ground, 1, 0)); // 2147483650: tile 2, mirrored left to right
```

Layer values keep the low 28 bits for the global tile id (0 is empty) and the top bits for `FLIP_H`, `FLIP_V` and `FLIP_D`, exactly as Tiled stores them, so imported data is used as is. `decodeTile` and `encodeTile` split and join them; `tilesetForGid` and `tileDefForGid` find the tileset and the per-tile entry; `validateTileMap` throws a `TypeError` or `RangeError` that names the field.

## Drawing a map

`TileMap` draws the tile layers with exact pixels: one instanced draw per visible 64 x 64 chunk per tileset, texels read with no filtering. Pass each tileset's atlas by name, as pixels, an `ImageBitmap`, a `GPUTexture` or a function.

```ts
import {EngineKernel} from 'margoengine/core';
import {createTileLayer, TileMap, type TileMapData} from 'margoengine/tilemap';
const canvas = document.querySelector('canvas')!;
const engine = await EngineKernel.create(canvas, {backend: 'webgpu', exactSize: [320, 180]});
const map: TileMapData = {
  width: 2, height: 1, tileWidth: 16, tileHeight: 16,
  layers: [createTileLayer('ground', 2, 1, Uint32Array.of(1, 2))],
  tilesets: [{name: 'grass', firstGid: 1, tileWidth: 16, tileHeight: 16, tileCount: 2, columns: 2}],
};
const image = await createImageBitmap(await (await fetch('grass.png')).blob());
const tiles = TileMap.attach(engine, {map, atlases: {grass: image}, camera: {x: 0, y: 0, zoom: 1}});
tiles.setTile('ground', 1, 0, 1); // only this cell's chunk goes up again
engine.render({delta: 1 / 60});
console.log(tiles.stats.draws); // 1
```

| Option | Default | What it does |
| --- | --- | --- |
| `map` | required | The `TileMapData`. `setMap` swaps it |
| `atlases` | required | Tileset name to atlas. `setAtlas` swaps one |
| `camera` | `{x: 0, y: 0, zoom: 1}` | Map point at the top left and target pixels per map pixel, read each frame |
| `snap` | `true` | Rounds each layer's top left to a whole pixel, read each frame |
| `mapLayers` | every tile layer | Names of the tile layers to draw |
| `parallax` | `true` | Scrolls each layer by its own `parallax`; false when the camera carries it |
| `target` | the frame's colour target | Draw into this texture, or a function returning one |
| `clear` | the map's `backgroundColor`, else transparent | With `target`: colour to clear to, false draws over it |
| `order` | `10` | Frame-graph order |
| `layers` | `1` | Render-layer bits |
| `name` | `tilemap-1`, ... | Plugin name, unique per scene |

To draw into a compositor layer of `margoengine/pixel`, pass `target: layer.target, camera: layer.camera, parallax: false, mapLayers: ['ground']`, with one `TileMap` per layer that scrolls on its own.

Tiles animate by their `animation` steps on the `time` clock (milliseconds; each frame adds its delta), which changes a small lookup and no cells. A tile larger than the cell sits on the cell's bottom left, as in Tiled. Layer `offset`, `opacity`, `tint`, `visible` and `parallax` and tileset `margin`, `spacing` and `tileOffset` are honoured. Overlapping oversize tiles of different tilesets draw tileset by tileset. Object layers are data only: draw tile objects with `margoengine/sprites`. Image collection tilesets (`columns: 0`) must be packed into one atlas first. After writing into `layer.data` yourself, call `invalidate(layer)`.

## Isometric, staggered and hexagonal maps

`margoengine/tilemap/iso` places cells the way Tiled does for every `orientation`: isometric diamonds, staggered
diamonds whose rows (or columns) are pushed half a cell, and hexagons with flat sides of `hexSideLength`. `GridTileMap`
draws them with exact texels, the cells in view back to front so tiles taller than their cell (walls, trees) cover the
cells behind them. `margoengine/tilemap/hex` adds cube coordinates for distances, rings and lines.

```ts
import { EngineKernel } from 'margoengine/core';
import { createTileLayer, type TileMapData } from 'margoengine/tilemap';
import { cellCenter, GridTileMap, pixelToCell } from 'margoengine/tilemap/iso';
import { hexDistance, hexRing } from 'margoengine/tilemap/hex';

const engine = await EngineKernel.create(document.querySelector('canvas')!, { exactSize: [160, 90] });
// Two 16 x 8 diamond tiles: grass and stone.
const data = new Uint8Array(32 * 8 * 4);
for (let y = 0; y < 8; y++)
  for (let x = 0; x < 32; x++)
    if (Math.abs((x % 16) + 0.5 - 8) / 8 + Math.abs(y + 0.5 - 4) / 4 <= 1)
      data.set(x < 16 ? [70, 160, 60, 255] : [150, 150, 160, 255], (y * 32 + x) * 4);
const map: TileMapData = {
  orientation: 'isometric', width: 8, height: 8, tileWidth: 16, tileHeight: 8,
  layers: [createTileLayer('ground', 8, 8, new Uint32Array(64).map((_, i) => 1 + ((i >> 3) % 2)))],
  tilesets: [{ name: 'floor', firstGid: 1, tileWidth: 16, tileHeight: 8, tileCount: 2, columns: 2 }],
};
GridTileMap.attach(engine, { map, atlases: { floor: { width: 32, height: 8, data } }, camera: { x: -16, y: -10, zoom: 1 } });
engine.start();

console.log(pixelToCell(map, ...cellCenter(map, 3, 5))); // [3, 5]
const hexes: TileMapData = { ...map, orientation: 'hexagonal', hexSideLength: 4, staggerAxis: 'y', staggerIndex: 'odd' };
console.log(hexDistance(hexes, [0, 0], [3, 2]), hexRing(hexes, 4, 4, 1).length); // 4 6
```

| Function | What it gives |
| --- | --- |
| `cellBox(map, x, y)` | The cell's bounding box `{x, y, width, height}` in map pixels |
| `cellCenter`, `cellPolygon` | The cell's centre; its outline, 4 corners (6 for hexagons), clockwise from the top |
| `pixelToCell(map, px, py)` | The cell under a map pixel, for picking; cells outside the map are returned too |
| `cellNeighbors(map, x, y)` | The cells that share an edge: 4, or 6 on hexagonal maps |
| `mapPixelSize(map)`, `paintOrder(map)` | The box around all cells; every cell index back to front |
| `visibleCells(map, layer, [left, top, right, bottom])` | The cells whose boxes reach a view, in paint order |
| `cellToCube`, `cubeToCell`, `hexDistance`, `hexLine`, `hexRing`, `roundCube` (`/hex`) | Cube coordinates `q + r + s = 0` of hexagonal and staggered maps |

`GridTileMap` takes the options of `TileMap` (`map`, `atlases`, `camera`, `snap`, `mapLayers`, `parallax`, `target`,
`clear`, `order`, `layers`, `name`) and draws any orientation, `TileMap` included; `setMap`, `setAtlas`, `time`,
`stats` and `dispose` (or `using`) work the same. `TileMap` itself refuses a map that is not orthogonal.

- Tiles larger than the cell sit on the cell box's bottom left, as Tiled's format describes; flips work as on
  orthogonal maps, and on hexagonal maps `FLIP_D` turns a tile 60 degrees clockwise and `HEX_ROTATE_120` 120.
- It writes the cells in view each frame (12 words each), so its cost follows the view, not the map; one draw per run
  of tiles from one tileset in paint order. Cells are read every frame: writes into `layer.data` show on the next one.
- WebGPU only, exact texels on a single-sample target, like `TileMap`.

## Auto-tiling

`margoengine/tilemap/autotile` picks the tile for each cell from its neighbours with rule sets written as data: 16 tiles for the four edge neighbours (`cardinal`), or 47 for all eight (`blob`; corners count only when both edges beside them are filled). Terrain sets match the terrain at a tile's four corners instead. Both are deterministic.

```ts
import {autotileGrid, BLOB_MASKS} from 'margoengine/tilemap/autotile';
const filled = [1, 1, 0, 1, 1, 1, 0, 1, 1]; // 3 x 3, 1 = ground
const tiles = BLOB_MASKS.map((_, i) => i); // tile id for each of the 47 cases
const cells = autotileGrid(filled, 3, 3, {mode: 'blob', tiles}, {firstGid: 1});
console.log(cells.length); // 9 global tile values, 0 where nothing is drawn
```

`autotile(layer, rules)` does the same on a `TileLayer`; `resolveTerrain(vertices, width, height, set)` and `verticesFromCells` handle corner terrain.

## Tiled import

`margoengine/tilemap/tiled` reads a Tiled map saved as JSON (`.tmj`, or `.json`) into `TileMapData`. It takes the text, UTF-8 bytes or the parsed object. Tile layers may be CSV (an array), base64, or base64 with zlib or gzip compression; infinite maps are joined into one layer per Tiled layer; group layers pass their offset, opacity, visibility and parallax to their children. An external tileset (`.tsj`) is loaded through `options.resolve`, which receives the path written in the map. Image layers, text and object templates are skipped with a call to `onWarning`. Isometric, staggered and hexagonal maps keep their `orientation`, `staggerAxis`, `staggerIndex` and `hexSideLength`, and hexagonal ones keep Tiled's 120 degree turn bit (`HEX_ROTATE_120`); oblique maps and infinite maps that are not orthogonal are refused.

```ts
import { parseTiled } from 'margoengine/tilemap/tiled';
const map = await parseTiled({
  orientation: 'orthogonal', width: 2, height: 1, tilewidth: 16, tileheight: 16,
  tilesets: [{ firstgid: 1, name: 'grass', tilewidth: 16, tileheight: 16, tilecount: 2, columns: 2, image: 'grass.png', imagewidth: 32, imageheight: 16 }],
  layers: [{ type: 'tilelayer', name: 'ground', width: 2, height: 1, data: [1, 2] }],
});
console.log(map.layers[0].type); // 'tile'
```

Bad input throws a `MapImportError` with a `code` (`syntax`, `truncated`, `missing`, `unsupported`, `limit` or `aborted`) and a message that names the fix; a compressed layer cannot expand past its declared size, and a layer past 16,777,216 cells is refused. `fromTMX(map)` converts what `parseTMX` of `margoengine/loaders` returns into the same `TileMapData`. Pass `signal` to stop an import.

## LDtk import

`margoengine/tilemap/ldtk` reads an LDtk project saved as JSON (`.ldtk`). It takes the text, UTF-8 bytes or the parsed object and returns each level of every world as a `TileMapData` with its entities, IntGrid values and fields.

```ts
import { parseLDtk } from 'margoengine/tilemap/ldtk';
const project = parseLDtk({
  jsonVersion: '1.5.3',
  defs: { tilesets: [{ uid: 1, identifier: 'Grass', relPath: 'grass.png', pxWid: 32, pxHei: 16, tileGridSize: 16, __cWid: 2, __cHei: 1 }] },
  levels: [{ identifier: 'Start', pxWid: 32, pxHei: 16, layerInstances: [
    { __identifier: 'Ground', __type: 'Tiles', __gridSize: 16, __tilesetDefUid: 1, gridTiles: [{ px: [16, 0], t: 1, f: 0 }] },
  ] }],
});
console.log(project.levels[0].map.layers[0].type); // 'tile'
```

Layers come back to front, with `__opacity`, `visible` and the total pixel offset. A cell holds one tile, so tiles LDtk rules stack on one cell become extra layers named `Ground#2`, `Ground#3`. When layers have different grids the map's tile size is their common divisor. Entity layers become object layers, and `entities` lists each one with its pivot, tags and fields. `.ldtkl` separate level files are refused with a `MapImportError` (the same codes as Tiled); off-grid tiles and tiles with their own alpha go through `onWarning`. Pass `signal` to stop an import.

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tilemap
