# @margoengine/tilemap

Import `margoengine/tilemap` from the `margoengine` package, or `@margoengine/tilemap` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

The 2D tile map format every other piece builds on: `TileMapData` holds the tile size, tilesets with per-tile properties, animation and collision shapes, tile layers as `Uint32Array` with Tiled's flip bits, object layers, parallax, offset, opacity and custom properties. This entry has types and small helpers only: no renderer, auto-tiling or importers yet. Orthogonal maps only. (`@margoengine/tiles` is OGC 3D Tiles; this package is unrelated.)

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

Apache-2.0. Optional, tree-shakable package; core peer: ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/tilemap
