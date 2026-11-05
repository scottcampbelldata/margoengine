# @margoengine/biomes: Seasons

Green-up, autumn, snow and wet ground for any day of the year (`/seasons`). One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Seasons

`@margoengine/biomes/seasons` gives each cell a state for one day of the year, 4 bytes in integers (the same bytes
everywhere): R green-up, G senescence, B snow and A wetness, each 0 to 255. It reads the temperature, warmest-month,
rainfall and moisture layers the world already makes and adds none, so tiles, placement and their digests do not change.

- **Green-up** counts degree days above 5 C from the spring crossing (the partial-year integral of the sinusoidal year,
  McMaster and Wilhelm 1997); 200 C day is full green. A cell above 5 C all year stays green.
- **Senescence** grows from the warmest day to the autumn crossing of 5 C, as the share of the cooling between them,
  and stays full through the dormant season.
- **Snow** is the precipitation of the days below 0 C since the autumn crossing, melted at 3 mm per thaw degree day (Hock
  2003) from the spring crossing; 50 mm of snow water covers the ground fully, less covers it in proportion. What the
  summer cannot melt lies all year, and below 0 C all year the year's precipitation lies, so a cold, dry cell stays
  thinly covered.
- **Wetness** is the soil moisture, raised toward 255 by `weather.rain`.

The counts start at the season crossings, not at 1 January, so 31 December runs into 1 January without a step. South
of the equator the year is half a year on. `seasonalColor(base, state)` turns a colour with the state: autumn orange,
bare straw in winter, darker on wet ground and white under snow. Species with `color: { seasonal: true }` and biomes
with `tint: { seasonal: true }` follow it when `BiomeView` or `BiomeObjects` gets the seasons. `seasonalMix(state)`
is the same curve as one mix, `[r, g, b, amount]`, for a shader: `base + (rgb - base) * amount`. Both work in linear
RGB, so mix in linear light. `seasons.tintAt(x, z)` gives that mix at a place as 4 bytes for an `rgba8unorm-srgb`
texture: the linear colour sRGB encoded, then the linear amount, scaled by the share of seasonal biomes there.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { BiomeSeasons, seasonalColor } from '@margoengine/biomes/seasons';

const world = await BiomeWorld.create({ size: [1024, 1024], climate: { latitude: 50 } });
using seasons = BiomeSeasons.attach(world, { dayOfYear: 300, weather: { rain: 0.4 } });
const state = await seasons.tile(1, 1); // rgba8, one texel per cell
const [green, autumn, snow, wet] = seasons.at(0, 0);
const leaf = seasonalColor([0.14, 0.3, 0.05], state.data, 0);
seasons.set({ dayOfYear: 20 }); // midwinter; views and objects that hold these seasons repaint
console.log(green, autumn, snow, wet, leaf);
```

With a view, pass the seasons as an option. The plant cover ground of seasonal biomes is drawn through a tint texture
of `tintAt` over the world (the terrain's `tint`, a texel every `regionResolution` metres, 16 m by default, or every
`textureResolution` when that is coarser), so each place shows its own snow, wet ground and green-up, and ground of
other biomes keeps its look. The foliage of seasonal species takes the state at the centre of the objects' bounds, one
colour per species. Each `seasons.set` and each world change repaints the tint and the foliage colours. Without
`seasons` the view draws exactly what it drew before.

```ts
import { Engine } from '@margoengine/core';
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { presets } from '@margoengine/biomes/presets';
import { BiomeSeasons } from '@margoengine/biomes/seasons';
import { BiomeView } from '@margoengine/biomes/view';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const temperate = defineBiome({ ...presets.temperate, tint: { seasonal: true } });
const world = await BiomeWorld.create({ biomes: [temperate, presets.alpine] });
const seasons = BiomeSeasons.attach(world, { dayOfYear: 290 });
const view = await BiomeView.attach(engine, world, { seasons });
seasons.set({ dayOfYear: 120 }); // spring green-up
console.log(view.materials);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `dayOfYear` | required | integer 1 to 365, 1 is 1 January |
| `weather.snowfall` | 1 | share of the cold season's precipitation that lies as snow, 0 to 1 |
| `weather.rain` | 0 | rain now, 0 to 1: wetness rises from the soil moisture toward 255 |
