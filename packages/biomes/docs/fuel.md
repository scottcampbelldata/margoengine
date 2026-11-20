# Fuel and the northern Rockies conifers

`@margoengine/biomes/fuel` says which fuel model burns where. A species names the surface fuel under its crowns
(`SpeciesRule.fuel`), a biome names the fuel of its open ground (`BiomeDefinition.openFuel`), and `fuelMap(world)` turns
those names into a grid over the world that `FireFront` of `@margoengine/vfx/fire-front` takes as its `fuel` option. The
fuel models themselves (loads by size class, bed depth, surface-area-to-volume ratio, moisture of extinction) live in
`FUEL_MODELS` of `@margoengine/vfx/fire-front`, the one table; biomes holds names only, so the two never disagree.

```js
import { BiomeWorld } from '@margoengine/biomes';
import { fuelMap } from '@margoengine/biomes/fuel';
import { rockiesWorld } from '@margoengine/biomes/presets';
import { pathExclusions } from '@margoengine/biomes/splines';
import { FUEL_MODELS, fireBehaviour } from '@margoengine/vfx/fire-front';

const { biomes, climate, relief } = rockiesWorld;
using world = await BiomeWorld.create({ size: [2048, 2048], biomes, climate, height: { relief } });
// A road clears its fuel; a cut-over (logging slash) burns as model 12.
const map = fuelMap(world, {
  bare: pathExclusions([{ points: [[-800, 0], [800, 40]], width: 6, edge: 2 }]),
  patches: [{ kind: 'polygon', points: [[-300, -300], [-200, -300], [-200, -200], [-300, -200]], fuel: 'FM12' }],
  models: FUEL_MODELS,
});
const here = map.at(-250, -250); // 'FM12'; null where nothing burns (the road)
console.log(map.names, here); // the models in use, and the model at one place
// map.at is bound: FireFront.attach(engine, { ground: world.heightAt.bind(world), fuel: map.at, ignitions: [...] })
if (here) console.log(fireBehaviour(FUEL_MODELS[here], { moisture: 0.06, wind: 4 }).rate); // m/s at the head of a fire in that slash
```

## The northern Rockies presets

`rockiesPresets` of `@margoengine/biomes/presets` holds three biomes for the inland northern Rockies of Idaho and
western Montana, the country of the 1910 fires, and `rockiesWorld` the steep mountain world they split between
(latitude 47.3, 550 mm of rain, 1,200 m of relief over a 1,000 m base). They stay apart from `presets` so a list of
`Object.values(presets)` is still the eight climate presets and the beach. `rockiesValleyWorld` puts the same climate and presets on a
mountain valley round Wallace, Idaho (`mountainValley` of `createRelief`, see
[relief and hydrology](relief-and-hydrology.md#mountain-valleys)): a level floor 870 m up with a creek and a rail grade,
walls of about 30 degrees cut into side gulches, and ridges up to 1,000 m above the floor.

| Preset | Where | Species (fuel model) | Open ground |
| --- | --- | --- | --- |
| `rockies-moist-forest` | moist soil: valley floors, north slopes, the higher cool ground | western white pine (8), western red cedar (10), grand fir (8), mountain maple (5) | brush, model 5 |
| `rockies-dry-forest` | drier slopes | Douglas-fir (10), western larch (8, in stands of half the ground), ninebark (5) | grass, model 1 |
| `rockies-opening` | the driest, south-facing slopes | scattered Douglas-fir (2), snowbrush (5) | bunchgrass, model 1 |

Which species stand where follows the habitat types of Pfister, Kovalchik, Arno and Presby, "Forest habitat types of
Montana", INT-34, 1977, and Cooper, Neiman and Roberts, "Forest habitat types of northern Idaho: a second
approximation", INT-GTR-236, 1991: cedar, white pine and grand fir on the moist ground, Douglas-fir with larch on the
dry slopes, bunchgrass and brush where timber does not close. The fuel under each is the model Anderson, "Aids to
determining fuel models for estimating fire behavior", INT-GTR-122, 1982, names for it: closed stands of white pine,
lodgepole pine, spruce, fir and larch are model 8 (page 11); timber with heavy dead-down material, such as old-growth
Douglas-fir and the overmature or deadfall stands of any type, is model 10 (page 13), which the cedar stands take for
their deadfall; grass is model 1 (page 4); open pine or Douglas-fir stands over grass are model 2 (page 5); green low
shrub fields in timber, the Douglas-fir snowberry habitat type, are model 5 (page 8); medium logging slash is model 12
(page 15), the `patches` fuel of a cut-over. The Forest Service report "Standard fire behavior fuel models", RMRS-GTR-153,
2005, is the later set (its timber litter and grass-shrub models); this entry stays with Anderson's thirteen, the set
`FireFront` carries. Crown radii, densities and the climate envelopes are ours; the meshes are the procedural conifer.

## The southern California presets

`chaparralPresets` of `@margoengine/biomes/presets` holds three biomes for the coast ranges and foothills of southern
California, the country of the chaparral fires, and `chaparralWorld` the hills they split between (latitude 34.2, 450 mm
of rain, 900 m of relief over a 150 m base). Like the Rockies presets they stay apart from `presets`.

| Preset | Where | Species (fuel model) | Open ground |
| --- | --- | --- | --- |
| `chaparral` | most of the dry slopes | chamise (4), bigberry manzanita (4), hoaryleaf ceanothus (4), scrub oak (4) | brush, model 6 |
| `coastal-sage-scrub` | the lowest, driest, south and west facing ground | California sagebrush (6), black sage (6), California buckwheat (6) | grass, model 1 |
| `oak-woodland` | the moister ground and valley floors | coast live oak (9, in stands), blue oak (2), toyon (6) | grass, model 1 |

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { chaparralWorld } from '@margoengine/biomes/presets';
import { fuelMap } from '@margoengine/biomes/fuel';

const { biomes, climate, relief } = chaparralWorld;
using world = await BiomeWorld.create({ size: [2048, 2048], biomes, climate, height: { relief } });
const fuel = fuelMap(world);
console.log(fuel.names, fuel.at(0, 0)); // FM4 where the chaparral closes, FM6 and FM1 under sage scrub and oaks
```

Which plants stand where follows Keeley and Davis, "Chaparral", and Rundel, "Sage scrub", chapters of Barbour,
Keeler-Wolf and Schoenherr (eds.), *Terrestrial Vegetation of California*, 3rd edition, University of California
Press, 2007, and Allen-Diaz, Standiford and Jackson, "Oak woodlands and forests", in the same book. The fuel under each
is the model Anderson, INT-GTR-122, 1982, names: mature chaparral is model 4 (page 7), the shorter, thinner brush of sage
scrub and of young chaparral gaps model 6 (page 9), open oak savanna grass under scattered trees model 2 (page 5), open
grass model 1 (page 4) and closed hardwood litter under live oak model 9 (page 12). The climate envelopes, densities,
crown radii and the share of each biome in the world are ours (checked by `tests/fuel.test.js`, which needs more than 40
of the 15,625 sampled corners for each).

## How a corner gets its fuel

`fuelMap(world, options)` samples the region fields on a grid of `step` metres (default 16, the world's region grid; a
`step` of 4 to 8 suits a fire front over a town). Nothing is placed and no tile is made. At each corner:

1. Below sea level, within `water` metres of water (default 2) or on a slope past `rockSlope` degrees (default 50) there
   is no fuel.
2. Each biome there, by weight, gives the crown share of each species that has a `fuel` (density x crown area x stands x
   suitability, the cover model of `canopyCover`). From `timber` of the ground (default 0.3) the corner takes the fuel of
   the species with the most crown; below it, the `openFuel` of the biomes there (or, with none, the fuel of the little
   crown there is).
3. `bare` shapes (roads, yards, house footprints; the exclusions of `pathExclusions` and `layoutSettlements`) clear it,
   then `patches` set it in order, a `null` fuel clearing. A corner within half a step of a shape counts as on it, so a
   road narrower than the step still cuts the map.

The result is `{ width, depth, step, origin, names, data, cover, at }`: `data` holds 0 for none or an index into `names`
plus one, `cover` the crown share 0..255, and `at(x, z)` the name at the nearest corner (null outside the world).
Same world and options give the same bytes; the shares are floats like `canopyCover`'s.

## Limits

`models` is optional: with it a name outside it throws at once; without it the names are checked only when `FireFront`
resolves them. At most 255 different names; a `step` of the world resolution or a multiple of it. Only `plants` carry
`fuel` (rocks, props and details do not); a species without a `fuel` shades the ground for `canopyCover` but adds
nothing to the fuel map.
