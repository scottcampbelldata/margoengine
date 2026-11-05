# @margoengine/biomes: Biomes, presets, painting and editing

Defining biomes, the presets and how they blend, painting and clearings, Koppen labels, and the editor with undo. One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Biomes, presets and blends

A world classifies every cell into weighted biomes: the `biome` layer holds the four strongest per cell (indices into
`world.biomes`) and `biomeWeight` their weights, which always sum to exactly 255.

```ts
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { presets } from '@margoengine/biomes/presets';

const heath = defineBiome({
  id: 'heath',
  climate: { moistureIndex: [0.45, 0.75], gdd5: [600, 1600], treeline: [0, null] },
  ground: [{ material: 'heather' }, { material: 'rock', slope: [30, null] }],
});
const world = await BiomeWorld.create({ biomes: [presets.temperate, presets.boreal, heath] });
const tile = await world.tile(4, 4);
const first = tile.layer('biome')!.data[0]; // strongest biome of cell (0, 0)
console.log(world.biomes[first].id, tile.layer('biomeWeight')!.data[0] / 255, world.sample(0, 0).biomes);
```

- **Envelopes** (`classifier: 'envelopes'`, the default): each biome lists ranges on any fields: `temperature`,
  `coldest`, `warmest`, `gdd5`, `season`, `treeline`, `rainfall`, `moistureIndex`, `moisture`, `height`, `slope`
  (degrees), `exposure`, `soil`, `waterDistance`, or `custom` ranges on any layer or on a user mask `mask/<name>`. A
  range is `[min, max]` in plain units; `null` leaves a side open. Membership is the product of Wendland kernels: 1
  well inside, a smooth band centred on each bound (`blend`, default 0.15 of the range; open ranges use a per-field
  width such as 1.5 K or 100 mm), exactly 0 beyond.
- **Ground layers** take ranges on `slope`, `height`, `moisture`, `curvature`, `temperature`, `coldest` and `warmest`
  (plus `weight`); every range given must hold, and `defineBiome` rejects any other field. The tundra preset lays snow
  where the mean annual temperature is -6 C or less, the alpine preset above 2,800 m where it is -3 C or less.
- **Ecotones that wander**: the climate inputs are warped by smooth integer noise (700 m, up to +-1.6 K and +-8 % of
  rainfall) before classification, so borders do not follow contour lines, and a 3x3 blur removes speckle from noisy
  slopes.
- **Nothing is ever empty**: a cell outside every envelope gets the nearest one by normalised distance (ties: higher
  `priority`, then id).
- **Weight**: `weight` (0.1 to 10, default 1) on a biome multiplies its membership of every cell before the top 4 are
  chosen, so on a cell two biomes cover equally, a weight 3 biome stores three times the share of a weight 1 biome
  (`priority` only breaks exact ties). A biome that is a member of a cell stays a member at any weight.
- **Whittaker and Holdridge** (entry `/zones`): `classifier: whittaker` weights each biome by the Whittaker classes in
  its `zones` (`WHITTAKER`, our rectangles over mean temperature and rainfall from the published diagram); `holdridge`
  by Holdridge life zones (`holdridgeZone(biotemperature, rainfall)`, nearest hexagon in log biotemperature, rainfall
  and PET ratio, such as `'cool-temperate-perhumid'`). `import { whittaker } from '@margoengine/biomes/zones'`, then
  `BiomeWorld.create({ classifier: whittaker })`. A classifier of your own implements `ZoneClassifier`. Set
  `perCell: true` when its scorer weights cell k from cell k of the warped inputs alone (not from the grid size or
  other cells), so `tilePart` can classify just the cells it makes; unset by default, `tilePart` makes whole tiles.

`presets` holds `temperate`, `boreal`, `alpine`, `wetland`, `tundra`, `desert`, `savanna` and `tropical`, written as
plant functional type limits over the coldest month, growing degree days and the moisture index, with Korner's
treeline for forests, so belts move with latitude, aspect and cold air instead of fixed heights. They are plain frozen
data (the package tests check each one with `defineBiome`), so the entry is small. `presetWorlds` holds
a climate and relief where each one is common, used by the golden digests. `presets.beach` is sand on low, gentle
ground by the sea (below 5 m, under 12 degrees) in any climate, and `presetWorlds.island` is a tropical island world
with its biomes ready to pass (see Procedural relief). The default world uses `temperate` with
its neighbours `alpine`, `wetland` and `boreal`. Every definition is plain JSON: `defineBiome` validates it and returns
a frozen copy.

### Painting

User layers sit on top of the climate: `world.writeLayer('paint/<biome>', x, z, data)` (u8 per cell of tile x, z)
paints a biome, `mask/<name>` writes a mask that envelopes and paint layers can read. Paint layers compose in the
world's `paint` order with a mode: `'replace'` (the default: the painted share replaces the rest), `'add'`,
`'multiply'` (0 removes a biome; the next nearest envelope takes over if nothing is left) or `'max'`, optionally
through a mask: `world.update({ paint: [{ biome: 'desert', mode: 'replace', mask: 'mask/dunes' }] })`. Writing a layer
recomputes that tile and its neighbours and calls the `onChange` listeners. Painted edges blend over the world's
`ecotone` (default 24 m): each cell reads the paint at the cell the climate warp moves it to, through a box that wide,
so a constant dab ramps from full strength to nothing across about 24 m and its border wanders by several metres like
the generated ecotones (`BiomeWorld.create({ ecotone: 0 })` keeps the old one-cell step). Stored plants follow the
blended weights, so a forest thins across the band. `readLayer` returns a copy. Stored plants
thin with the painted share: none of a replaced biome stand where its paint reaches 255, and where half is painted a
dense stand keeps somewhat more than half, because fewer seedlings meet fewer neighbours (a temperate forest keeps 75
percent at a 49 percent desert share; `tests/placement.test.js`).

### Clearings

A clearing is a biome no climate picks, with a ground and no plants, painted where stored objects and detail should
stay out (a cabin yard, a path, a beach): `custom: { 'mask/clearing': [0.5, null] }` never matches until something
writes that mask, so only paint chooses it. Where its paint reaches 255 nothing of the other biomes stands (the
`ecotone` feather ramps the edge, so the bare core is the painted radius less about 25 m). For a hard footprint
without any ground change, use `BiomePlacement` `exclusions` (lines and polygons in metres).

```ts
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { presetWorlds } from '@margoengine/biomes/presets';

const { climate, relief, biomes } = presetWorlds.island;
const clearing = defineBiome({
  id: 'clearing',
  climate: { custom: { 'mask/clearing': [0.5, null] } },
  ground: [{ material: 'grass' }],
});
const world = await BiomeWorld.create({ size: [1024, 1024], climate, height: { relief }, biomes: [...biomes, clearing] });
const placement = BiomePlacement.attach(world);
BiomeEditor.attach(world).paint('clearing', { center: [100, 80], radius: 40, falloff: 'constant' });
const tile = await placement.tile(2, 2); // objects stay out of the painted yard; undo brings them back
console.log(tile.count, world.heightAt(100, 80)); // where to stand the cabin, in metres
```

### Koppen labels

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { KOPPEN, koppen, koppenClass } from '@margoengine/biomes/koppen';

const world = await BiomeWorld.create();
const codes = koppen(await world.tile(8, 8), world.climate.rainSeason); // one class index per cell
console.log(KOPPEN[codes[0]]); // 'Cfb' for the default world
console.log(KOPPEN[koppenClass({ temperature: 2700, coldest: 2600, warmest: 2800, rainfall: 2600, rainSeason: 'uniform' })]); // 'Af'
```

An optional view over the seasonal climate layers (Beck et al. 2018 rules, 30 classes), not a classifier: nothing
depends on it and the root entry does not include it. Monthly rainfall follows the climate's `rainSeason`.

## Editing: paint, undo and dirty rectangles

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeEditor } from '@margoengine/biomes/editor';

const world = await BiomeWorld.create();
const editor = BiomeEditor.attach(world); // or `using editor = ...` inside a block
editor.stroke(() => {
  editor.paint('wetland', { center: [120, -40], radius: 50 }); // a biome id paints paint/<id>
  editor.paint('wetland', { center: [150, -30], radius: 50, strength: 0.5, falloff: 'linear' });
});
editor.erase('wetland', { center: [130, -35], radius: 10 });
editor.fill('mask/clearing', { rect: [0, 0, 200, 200], value: 1 });
console.log(editor.dirty, editor.edits.length); // the rectangles the last step can change, and the edits as data
editor.undo(); // the exact bytes from before the erase
```

- `paint(layer, { center, radius = 10, strength = 1, mode = 'add', falloff = 'smooth' })`: modes `'add'`,
  `'subtract'`, `'set'` (move toward the strength), `'max'` and `'min'`; falloffs `'smooth'` (quintic), `'linear'`,
  `'constant'`. `erase` moves toward 0; `fill(layer, { rect, value, mask })` sets a rectangle, scaled by a mask.
- `stroke(work)` or `using s = editor.stroke()` groups edits into one undo step; `undo()` and `redo()` restore the exact
  bytes of every raster a step touched.
- Edits are plain data (`editor.edits`, `editor.history()` as an async iterator of every edit as it is made), and
  `apply(edit)` replays one exactly: a stroke replayed in another world gives the same digests, so edits can be saved or
  synced.
- `editor.dirty` covers every cell the last step can change, grown by `editor.margin()`: what classification reads
  across (one cell for the blur, or twice the half width of the `ecotone` feather, 24 m by default) plus the placement reach (`BiomePlacement.reach` with the default spacing: two spacings per
  Luby round in every layer, the earlier layers each one reads, and the 32 m canopy cells), so tiles outside it are
  guaranteed unchanged. The world reports the same rectangles through `onChange`, and
  `BiomeView` redraws them. Heights edited with `world.update({ height })` dirty the whole world, since rain shadow
  and continentality reach far downwind.
- Brush maths is integer, so the same edit gives the same bytes everywhere. A dab or an undo costs well under a frame;
  the touched tiles are remade on their next request (on this thread until the worker pool of a later milestone).
