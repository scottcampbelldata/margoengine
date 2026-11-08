# @margoengine/biomes: Disturbance and ecosystem growth

Fire history, flood return periods and succession stages over the region grid (`/disturbance`), and forest growth over years (`/ecosystem`). One of the package guides; the [README](../README.md) has the quickstart and the list of guides.

## Disturbance

`@margoengine/biomes/disturbance` computes independent region data. `age` is a u16 count of years since the last
burn at the end of the history, with 65535 meaning never burned. `flood` is the smallest listed return period in
years whose water stage reaches the cell: 1 on water, 0 if no listed flood reaches it. `stage` is a u8 succession
index: 0 burnt, 1 grass, 2 shrub, 3 young stand, 4 mature with the default thresholds. Frequently flooded cells
stop at stage 1. Flood is derived from hydrology, independently of the seed. Without hydrology, flood is 0;
explicit water masks still block fire.

```ts
import { BiomeWorld } from '@margoengine/biomes';
import { hydrologyOf } from '@margoengine/biomes/hydrology';
import { disturbanceOf, disturbanceTile } from '@margoengine/biomes/disturbance';

const world = await BiomeWorld.create({ size: [256, 256], resolution: 4, height: { relief: { coast: 'west' } } });
const h = hydrologyOf(world);
const d = disturbanceOf(world, h, { seed: 7, years: 20 });
const layers = disturbanceTile(world, d, 0, 0);
console.log(layers.map((layer) => layer.name)); // age, flood, stage
```

Compute the region once, then sample its nearest corners in any tile order. Rerun after changing the region or
hydrology. No result changes `BiomeWorld`, its tile digests, placement, or rendering. Setting both `fire: false`
and `flood: false` produces age 65535, flood 0, and the oldest succession stage everywhere. Importing the root entry
does not load disturbance. All work here is synchronous and CPU only: nothing loads or waits, so these functions
take no AbortSignal. For large worlds, the existing `/workers` entry can prepare world fields off the main thread;
it does not dispatch disturbance. Run this synchronous calculation in an application worker if needed.

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | 0 | unsigned 32-bit seed for fire |
| `years` | 100 | integer history length, 1 to 10000; the last year has age 0 |
| `fuel` | 128 everywhere | Uint8Array of nx times nz values; 0 cannot burn, 255 is full fuel |
| `water`, `rock` | no masks | Uint8Array masks of 0 or 1; water combines with `h.water === 0`; neither can burn |
| `fire` | `{}` | settings below, or `false` |
| `fire.ignitionsPerYear` | 1 | seeded attempts per year, integer 0 to 65535 |
| `fire.ignitions` | `[]` | authored cell indices ignited in year 0 before seeded attempts |
| `fire.duration` | 480 | whole minutes per fire, 0 to 2147483646 |
| `fire.wind.speed`, `fire.wind.direction` | 0, 0 | speed 0 to 100 m/s; finite degrees, 0 toward +x, clockwise toward +z |
| `fire.moisture` | 0.2 | fraction of extinction moisture, 0 to 1; 1 stops ignition and spread |
| `fire.recovery` | 5 | integer years before reburning, 0 to 10000; never twice in one year |
| `flood` | `{}` | settings below, or `false` |
| `flood.returnPeriods` | `[2, 10, 100]` | strictly ascending whole years, 2 to 65535; `[]` tests no periods, water remains 1 |
| `flood.wetland` | 2 | periods at or below this whole year, 1 to 65535, cap succession at 1 |
| `succession.stages` | `[1, 5, 20, 80]` | strictly increasing whole ages 1 to 65535, up to 255 thresholds |

`successionStage(age, cap, stages)` counts thresholds at or below age and takes the smaller of that count and cap.
`encodeDisturbance` and `decodeDisturbance` round-trip the independent data, including height. MGDS version 1 stores
four magic bytes, a u32 version, u32 nx, nz, step in mm, seed and years, then each cell's i32 height, u16 age, u16 flood
and u8 stage, all multi-byte values little endian. Decode requires exactly one complete record.

### Sources and limits

The code was written from these descriptions and Margo's integer helpers. No other engine source was read.
Fire uses least-time paths on 16 neighbours with an integer-minute cost and a heap ordered by time then cell index.
Every cell touched by a move must be burnable, including both cells at diagonal corners. A fire's eligibility stays
fixed until that search ends; previous fires and previous years supply the recovery barriers. Seeded chances are
fuel divided by 255 times moisture damping. Never burned means the oldest age, including for custom thresholds.

| Source | URL or DOI | Exact claim used | Assumptions and limits |
| --- | --- | --- | --- |
| Rothermel 1972, INT-115 | [USDA paper](https://research.fs.usda.gov/download/treesearch/32533.pdf) | Moisture damping is `1 - 2.59r + 5.11r² - 3.52r³`; wind and slope multiply spread through `1 + phiW + phiS`; slope uses squared tangent. | Paper equations verified in this run. Full-fuel base rate 1000 mm/min, slope K=5, wind C=0.1 and B=1.5 are assumptions, not fitted fuel models. Uphill tangent is capped at 2. |
| Finney 2002 | [10.1139/x02-068](https://doi.org/10.1139/x02-068) | Least-time paths over a spatial network produce fire perimeters comparable to expanding fronts. | Paper abstract verified through an indexed primary-paper copy; DOI resolver unavailable. Our finite stencil and integer minutes approximate propagation. Cosine-weighted wind is a stand-in for the elliptical law; no spotting or leap across barriers. |
| Connell and Slatyer 1977 | [10.1086/283241](https://doi.org/10.1086/283241) | Conceptual motivation for stage sequences following disturbance. | Publisher abstract and DOI verified in this run. The chosen thresholds are assumptions; there are no fire-adapted species flags or species dynamics. |
| Botkin, Janak and Wallis 1972 | [10.2307/2258570](https://doi.org/10.2307/2258570) | Historical gap-model motivation for forest development over time. | Not re-verified in this run: primary page inaccessible. This is a threshold model, not a reproduction of the gap model. |
| Renno et al. 2008 | [10.1016/j.rse.2008.03.018](https://doi.org/10.1016/j.rse.2008.03.018) | HAND measures elevation relative to drainage along flow paths. | Not re-verified in this run: primary page inaccessible. Margo consumes the existing hydrology HAND and direction arrays. |
| Nobre et al. 2011 | [10.1016/j.jhydrol.2011.03.051](https://doi.org/10.1016/j.jhydrol.2011.03.051) | HAND classes describe soil water environments, not universal flood return periods. | Publisher summary verified in this run; DOI resolver unavailable. Flood depths must be modelled separately, not taken from fixed HAND classes. |
| Leopold and Maddock 1953 | [USGS PP252](https://pubs.usgs.gov/pp/0252/report.pdf), [10.3133/pp252](https://doi.org/10.3133/pp252) | Hydraulic depth varies with discharge as a power, with an illustrative exponent near 0.4. | Not re-verified in this run: primary report and DOI inaccessible. Discharge proportional to catchment area is an assumption. Depth coefficient 10 mm per m² raised to 0.4 is uncalibrated. |
| Chow 1951 | [10.1029/TR032i002p00231](https://doi.org/10.1029/TR032i002p00231) | Frequency-factor framing of a return-period quantile. | Not re-verified in this run: primary page inaccessible. Uses the brief's Gumbel factor `-(sqrt(6)/pi)(0.5772 + ln ln(T/(T-1)))`, tabulated in Q16 for default periods and calculated in fixed point for custom periods. |
| Gumbel 1941 | [10.1214/aoms/1177731747](https://doi.org/10.1214/aoms/1177731747) | Extreme-value return-period framing for flood flows. | Publisher title and DOI verified, full formula not re-verified in this run. No local flood calibration or hydraulic routing is claimed. |

Flood follows each D8 path to the first channel or outlet, with memoised drainage. Catchment area is flow times
step squared; fixed-point logarithms avoid overflowing that product. These synthetic layers support authored worlds,
not forecasts of actual fires or flood risk. No performance or package-size target was measured for this entry.

## Ecosystem growth

`/ecosystem` grows a forest year by year from a few founders, or from a placed tile's plants. Every year each living
plant is shaded by the taller crowns it overlaps, grows by the light left to it, may die, and once mature scatters
seedlings, so a stand fills in, closes its canopy and thins itself, and shade-tolerant species take the understorey.

```js
import { growEcosystem } from '@margoengine/biomes/ecosystem';

const forest = growEcosystem({
  bounds: [0, 0, 100, 100], // metres; seedlings establish only inside
  species: [
    { id: 'birch', radius: 3, growth: 0.3, age: 80, shade: 0.1, seeds: 6, dispersal: 8 },
    { id: 'beech', radius: 5, growth: 0.12, age: 250, shade: 0.9, seeds: 3, dispersal: 6 },
  ],
  plants: [
    { species: 'birch', x: 30, z: 30, radius: 2 },
    { species: 'beech', x: 70, z: 60, radius: 3 },
  ],
  years: 60,
  seed: 1,
});
console.log(forest.counts, forest.history.at(-1)); // living plants per species; the last year's alive, born and died
```

A species sets its largest crown `radius` (metres), its logistic `growth` rate a year in full light, its lifespan
`age` (past it a quarter die each year), its `shade` tolerance 0..1, its `seeds` a year at full crown (0..64, scaled by
crown area), its `dispersal` scale (half the seedlings land closer than it) and the share of the largest crown at which
it starts to seed (`maturity`, default 0.4). `where(x, z, species)` gives a seedling's chance to establish at a place,
0..1, for example from a world's moisture or a clearing. `forest.plants` lists the living plants, then the standing
dead (`died` is their year), which fall after `snags` years (default 10). `plantsFromTile(placement, tile)` gives a
placed tile's living plants as founders, keyed `'<biome>/<species>'` with their crowns, so a run can start from what
`BiomePlacement` placed:

```js
import { BiomeWorld, defineBiome } from '@margoengine/biomes';
import { BiomePlacement } from '@margoengine/biomes/placement';
import { growEcosystem, plantsFromTile } from '@margoengine/biomes/ecosystem';

const world = await BiomeWorld.create({
    seed: 3,
    size: [512, 512],
    biomes: [
      defineBiome({
        id: 'wood',
        climate: {},
        ground: [{ material: 'grass' }],
        plants: [{ id: 'oak', mesh: 'procedural:broadleaf', density: 80, radius: 4 }],
      }),
    ],
  }),
  placement = BiomePlacement.attach(world),
  tile = await placement.tile(0, 0);
const grown = growEcosystem({
  bounds: [tile.origin[0], tile.origin[1], tile.origin[0] + tile.size, tile.origin[1] + tile.size],
  species: [{ id: 'wood/oak', radius: 8, age: 300, shade: 0.6 }],
  plants: plantsFromTile(placement, tile),
  years: 10,
});
console.log(grown.counts['wood/oak']);
```

Everything is integers (centimetres, millimetres and Q16.16 shares) decided by hashes of the seed, the plant's birth
number and the year, so the same start gives the same forest on every machine. Light is a crown-overlap share, not a
ray-cast canopy; there is no soil, water or seed bank, and plants do not move. A run is CPU only and its cost grows with
plants times neighbours times years; `limit` caps the plants held (default 200,000) and `crowded` counts the seedlings
left out.

### Sources and limits

| Source | URL or DOI | Exact claim used | Assumptions and limits |
| --- | --- | --- | --- |
| Botkin, Janak and Wallis 1972 | [10.2307/2258570](https://doi.org/10.2307/2258570) | Individual trees in a plot grow, shade one another by height and die by a base and a growth-dependent rate, year by year. | Not re-verified in this run. Crown radius stands in for diameter and height; no climate or soil response. |
| Pacala et al. 1996 | [10.2307/2963479](https://doi.org/10.2307/2963479) | Growth falls with the light a tree receives as the species allows, and the chance of death rises as growth falls. | Not re-verified in this run. The light share and the rates are assumptions, not the paper's fitted functions. |
| Clark et al. 1999 | [10.1890/0012-9658(1999)080[1475:SDNAFP]2.0.CO;2](https://doi.org/10.1890/0012-9658(1999)080[1475:SDNAFP]2.0.CO;2) | The 2Dt kernel fits seed dispersal with a fat tail; with shape 1 its distance CDF is r² / (u + r²). | Not re-verified in this run. Shape fixed at 1, scale per species, capped at 30 scales; seedlings by crown area. |
| Weiner 1990 | [10.1016/0169-5347(90)90095-U](https://doi.org/10.1016/0169-5347(90)90095-U) | Competition for light is size-asymmetric: larger plants take a share out of proportion to their size. | Not re-verified in this run. Only taller crowns shade a crown (ties to the older); the shaded share is overlap depth over the crown's diameter. |
| Bella 1971 | [10.1093/forestscience/17.3.364](https://doi.org/10.1093/forestscience/17.3.364) | A tree's competition is the overlap of its zone of influence with its neighbours'. | Not re-verified in this run. Crowns are the zones; no weighting by size ratio. |
