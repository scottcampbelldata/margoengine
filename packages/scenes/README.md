# @margoengine/scenes

Ready places in one call. Each scene composes the engine's own packages (terrain, sky, water, scatter, procedural,
shadows, post) at their best settings, and every look value is a documented setting with a default, a range and a
unit. The root is the catalogue, plain data that loads no package; each scene is its own entry.

```ts
import {scenes, sceneInfo} from 'margoengine/scenes';
console.log(scenes.map((s) => s.name), sceneInfo('dune-coast').settings.hour.default); // ['dune-coast'] 10.6
```

## Assets by id and per-shot settings: `@margoengine/scenes/library`, `@margoengine/scenes/shot-settings`

A scene asks for a model or a sky by id; the library says where its file is. `node tools/library-index.mjs <folder>` writes `library.json` in an asset folder (`<subject>/<kind>/<id>/<id>_2k.gltf` for models, `<subject>/hdri/<id>_2k.hdr` for skies; textures sit beside their model; the folder is never in git). `fetchLibrary(root, {signal})` reads and checks it, `parseLibrary(data, root)` checks an index you already have (a repeated id, an unknown type, or a path that is absolute or climbs out of the root throws `RangeError` naming the asset), `assetUrl(library, id)` gives the file URL and `findAssets(library, {subject, kind, type})` lists. With no library a scene draws its procedural pieces and fetches nothing.

`checkShotSettings(block, tables, seconds)` and `shotSettingsAt(block, tables, seconds)` give each shot its own settings. A block is `{target: {row: value | {keys: [{time, value, ease}]}}}`; `tables` maps each target to a package settings table (`WEATHER_SETTINGS`, `SKY_SETTINGS`, `TONEMAP_SETTINGS`, ...), so the packages stay the only source of rows. A plain value holds for the whole shot; keys move a number through each key's ease (`linear`, `in`, `out`, `inOut`), a colour per channel in linear RGB, a gradient stop by stop when both keys have the same stops; a choice, a null and a gradient with other stops step at each key; before the first key and after the last the nearest holds. Only `live` rows can be keyed; a held row that is not live (`shotHeldRebuilds`) is written once before the warm-up. The check names the target and row for an unknown name, a value out of range (the package's own rule), a null on a row that is not nullable, a keyed row that is not live, or key times that do not rise or leave `[0, seconds]`. `SceneInfo` gains optional `looks`, `shots` (each with `settings`) and `targets` (target name to package entry).

```ts
import {checkShotSettings, shotSettingsAt} from 'margoengine/scenes/shot-settings';
import {WEATHER_SETTINGS} from 'margoengine/weather/settings';
import {TONEMAP_SETTINGS} from 'margoengine/tonemap/settings';

const tables = {weather: WEATHER_SETTINGS, tonemap: TONEMAP_SETTINGS};
const shot = {tonemap: {'tonemap.exposure': {keys: [{time: 0, value: -1}, {time: 8, value: 0.5, ease: 'out'}]}}};
checkShotSettings(shot, tables, 8);
console.log(shotSettingsAt(shot, tables, 4).tonemap['tonemap.exposure']);
```

## Dune coast: `@margoengine/scenes/dune-coast`

A winter barrier-island coast. The defaults are Kill Devil Hills, North Carolina, on 17 December 1903 at 10:35, the
morning of the first powered flight: a bare sand flat around the launch rail, low hummocks with sparse winter grass
around it, the big dune 430 m to the south (30 m, windward side toward the camp), two smaller dunes, the camp's two
board sheds, the 60 ft launch rail, the foredune and the winter Atlantic surf 900 m to the east, under a grey sky
with a north wind. x is east, z south, y up, metres, sea level at y = 0; the rail's south end is at the origin.

```ts
import {Engine} from 'margoengine';
import {attach} from 'margoengine/scenes/dune-coast';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, {camera: {near: 0.3, far: 30000}});
const scene = attach(engine, {weather: 'overcast', wind: 11, blownSand: 0.5});
await scene.ready; // the blown sand loads on demand; await before the first frame you keep
scene.view('first-flight');
console.log(scene.height(0, 0).toFixed(1), Object.keys(scene.anchors).length); // ground at the rail, anchors
```

`attach(engine, settings)` builds the ground (one mesh, from `@margoengine/terrain/dunes`: hummocks, `duneHill` dunes,
the foredune and a beach of 1 in 28 above the water and 1 in 50 below), sand colours with a wet band that follows the
surf (`TerrainColors` wetness), the sky, fog, bloom and tone curve of the weather's `PresetScene` with the sun put
where it was for the date and hour (`sunPath`), shadows, the sea (`Water` coupled to the beach), the dune grass
(`GrassScatter` from `@margoengine/scatter/grass`: clumps of 30 arching blades, 0.4 to 1 m, straw with olive bases,
swaying in the wind, on a grid that follows the camera out to 230 m) and the camp (`generatePlankShed`, `generateLaunchRail` from `@margoengine/procedural/sheds`). The handle
gives `height(x, z)`, named `anchors` and `views` (`view(name, fov)` moves the engine camera there),
`advanceTime(seconds)` for film frames (sky, sea and grass sway), the `parts` (the PresetScene, the water, the
shadows, the grass, the occlusion pass) and `dispose()`. A gltf/pbr model placed in the scene joins the shadows with
`scene.parts.shadows.add(model.root, {})` and the occlusion with `scene.parts.occlusion?.add(model)`. `ground(settings)` gives the same height function with no engine, for placing
subjects and cameras, and `grassCover(settings)` where the grass grows, 0 (bare sand) to 1 (a full clump):

```ts
import {ground} from 'margoengine/scenes/dune-coast';
const height = ground();
console.log(height(0, 0).toFixed(1), height(-40, 430).toFixed(1), height(900, 0).toFixed(1)); // rail, big dune crest, waterline
```

```ts
import {grassCover} from 'margoengine/scenes/dune-coast';
const cover = grassCover({grass: 0.5});
console.log(cover(-40, 0).toFixed(2), cover(-40, 430), cover(900, 0)); // the flat, the bare dune crest, the wet beach
```

The camp yard is bare, trodden sand: no grass grows inside the hangar and the shed or within a metre of them
(x -98 to -60.5, z 26 to 34), also when `camp: false` leaves the buildings to a film's own models at the same place.

The grass follows the ecology of American beachgrass (Ammophila breviligulata): it grows where blown sand buries it
and spreads in clumps, and the sand it traps builds the hummocks, so hummock tops carry the most and the hollows the
least (Hesp 2002, "Foredunes and blowouts: initiation, geomorphology and dynamics", Geomorphology 48; Maun 2009, *The
Biology of Coastal Sand Dunes*). None grows on the beach and wet band below 1.2 m or on the dunes above about 9 m,
which were bare moving sand in 1903 (LC-W86-120, LC-W85-110). Clumps stand in patches 3 to 10 m across, in groups,
with a lone clump between them; `grass` sets the share of ground in patches.

The page `examples/dune-coast/index.html` shows the scene and is ready for the shot tool (tools/shot): it takes
`view`, `fov` and any setting as URL options, sets `#viewport[data-ready="true"]` 30 frames after `scene.ready` and exposes
`window.duneCoast = {engine, scene}` (shot `page.engine`: `duneCoast.engine`).

| Setting | Default | Range or values | Meaning |
| --- | --- | --- | --- |
| `date` | `'1903-12-17'` | `YYYY-MM-DD` | the day, for the sun's place |
| `hour` | 10.6 | 0 to 24 h | local solar time (10:35 eastern time at 75.67 W) |
| `latitude` | 36.02 | -90 to 90 deg | degrees north |
| `weather` | `'overcast'` | `'overcast'`, `'clear'` | the photographs' grey sky and soft light, or sun and broken cloud |
| `visibility` | 6000 | 500 to 50,000 m | haze distance |
| `wind` | 11 | 0 to 25 m/s | wind speed: grass sway, whitecaps, chop and the wind sea |
| `windFrom` | 0 | 0 to 360 deg | compass direction the wind blows from; dunes face away from it |
| `sand` | [0.52, 0.46, 0.35] | linear RGB | dry sand albedo |
| `grass` | 0.5 | 0 to 1 | share of the ground in grass patches, most on the hummocks (0 removes it) |
| `grassColor` | [0.36, 0.31, 0.16] | linear RGB 0 to 1 | dune grass albedo (winter straw with olive bases) |
| `grassHeight` | 0.8 | 0.2 to 2 m | tallest grass leaf |
| `grassBlades` | 30 | whole number 4 to 64 | leaves to a clump |
| `grassVariety` | 0.035 | 0 to 0.2 | hue spread between clumps: straw and olive clumps side by side |
| `grassTranslucency` | 0 | 0 to 1 | sunlight seen through the leaves (`GrassScatter` `blades.translucency`), so a field against a low sun reads as thin leaves |
| `grassWidth` | 0.016 | 0.004 to 0.05 m | leaf width at the root |
| `hill` | 30 | 0 to 40 m | crest of the big dune above the flat |
| `crest` | 0 | 0 to 1 | sharpness of the big dune's brink: 0 rounds it over a third of its height (a settled crest), 1 over a twentieth (a crest the wind is building) |
| `sandBands` | 0 | 0 to 1 | broad scour bands along the wind on the sand (`TerrainColors` `sandSurface.broad`), seen at any distance |
| `surf` | 1.2 | 0 to 3 m | swell height at the beach (0 removes the sea) |
| `camp` | true | | the sheds and the rail |
| `boards` | [0.258, 0.205, 0.147] | linear RGB 0 to 1 | albedo of the sheds' wall boards and the rail (the `weatheredWood` preset) |
| `roof` | [0.258, 0.205, 0.147] | linear RGB 0 to 1 | albedo of the sheds' roof boards |
| `shedOverhang` | 0.2 | 0 to 1 m | roof overhang past the shed walls |
| `shedWeathering` | 0.5 | 0 to 1 | board tilts, uneven ends and gaps |
| `shedWindows` | false | | two windows in the hangar's back wall and one in each shed's end wall |
| `occlusion` | 1.5 | 0 to 10 m | reach of the ambient occlusion (`GTAO` of `@margoengine/post`, first in the post stack; 0 for none): the eaves, battens, rail and grass feet shut out the grey sky's light |
| `heights` | built landform | `{samples, width, depth, cellSize, origin, sea}` | real heights, such as a USGS 3DEP 1 m bare-earth grid (heights at or below `sea` are lowered under the water) |
| `footprints` | 1 | 0 to 1 | footprints trodden between the sheds, to the launch rail and along it, 4.5 cm deep at 1 (`TerrainDeformation` of `@margoengine/terrain/deform` on the ground mesh; they show within 45 m of the camera and need `camp`; `scene.parts.footprints?.walk(points)` lays more) |
| `scour` | 1 | 0 to 1 | sand the wind has shaped (`windScour` of `@margoengine/terrain/scour`): with `camp`, a moat along the sheds' windward walls and flanks, a deposit horseshoe in front and two tails; with `grass`, shadow dunes behind grass clumps round the camp and the rail; none at 6.6 m/s or less. `scene.height` includes it, and the ground mesh is split finer there |
| `blownSand` | 0 | 0 to 1 | sand blowing off the crests and over the dry sand (`BlownSand` from `@margoengine/vfx/blown-sand`), wherever the wind with its gusts is over 6.6 m/s; none on the wet beach or in the grass |
| `quality` | `'film'` | `'film'`, `'preview'` | ground cells, sea segments, shadow map and grass count |
| `seed` | 1903 | | seed of the hummocks and small dunes |

Presets (`info.presets`): `first-flight` (the defaults), `clear-morning`, `calm-summer`. Anchors: `rail`, `camp`,
`flightLine`, `bigHill`, `beach`. Views: the six Library of Congress photographs' camera places (`first-flight`,
`camp-buildings`, `killdevil-from-flat`, `flyer-on-rail`, `killdevil-back`, `landing-rail-view`), `surf` and `crest` (the big dune's crest seen side on, the wind blowing across the view).

Sources for the layout: Library of Congress, Wright Brothers negatives LC-W861-35, LC-W86-15, LC-W86-21, LC-W86-38,
LC-W86-120 and LC-W85-110 (public domain, https://www.loc.gov/pictures/collection/wri/); USGS 3D Elevation Program
1 m bare-earth heights (public domain, https://www.usgs.gov/3d-elevation-program) for the distances from the camp flat
to the hill and the shore; McFarland (ed.) 1953, *The Papers of Wilbur and Orville Wright*, for the hangar and the
rail. The ground, the sky and the sea come from their packages' own sources (terrain/dunes, sky/sun, water).

## Fauld tunnels: `@margoengine/scenes/fauld-tunnels`

The RAF Fauld underground bomb store in Staffordshire (the explosion of 27 November 1944): the arched gypsum bays with
their racks of 1,000 lb and 500 lb bombs, the narrow-gauge rails and trolleys, the brick blast walls, the work bay, the
timbered Old Mine roadways beyond, and the portal yard in the hillside. Plan metres (+x into the hill, +y north, z up)
map to Margo as (x, z, -y). Every model is a library glTF with full PBR maps (`<library>/fauld-1944/tunnels/<id>`,
converted from the film's kit in Blender), drawn once each and repeated by GPU instancing.

```ts
import {dressState, FAULD_STATE_EV, FAULD_TUNNEL_STATES} from 'margoengine/scenes/fauld-tunnels';
const working = dressState('working');
console.log(FAULD_TUNNEL_STATES.length, working.lamps.length, FAULD_STATE_EV.working); // 10 55 2
```

`attach(engine, settings)` (async) loads the state's models and draws them with clustered lights: each bulkhead bulb
a 2700 K lamp of the lighting plan's catalogue (40 W 400 lm, 60 W 690 lm, 100 W 1,250 lm, light output 0.65, lower
hemisphere only) in candela, hand lamps as 40 lm cones standing on the floor in their `tn_handlamp` fitting (the film has
no people, so no lamp hangs in the air at chest height; `HANDLAMP_ASSET`, `HANDLAMP_STAND`), the nearest and brightest lamps shadowed (`LocalShadows` with
`shadowBudget`, 16 in `film`, 8 in `preview`), one `LightBounce`, a glowing bulb at each fitting (`flameEmission`),
lamp-lit `VolumetricFog` (gypsum dust, or smoke after the blast and in the fire), `Fire` and `Smoke` of the state
(each smoke column added to the fog, so the lit air lies in front of it: `packages/scenes/test/fauld-smoke-fog.mjs`),
and a `PostStack` of `GTAO`, `DOF`, `Bloom`, an AgX `Tonemap` white-balanced to 3200 K at the state's one metered
exposure (`FAULD_STATE_EV`, EV100) and `SMAA`. The yard states use the overcast `PresetScene` sky. `frame(position,
target, focal, stop)` sets the camera, its field of view on a 36 mm gate and the focus; `advanceTime(seconds)` runs
the fires; `counts`, `parts` and `dispose()` as the other places. The page `examples/fauld` draws one row of the
film's shot list (`tools/shot/shots/fauld-frNNN.json`) and `examples/fauld/stills.mjs` renders their stills.

| Setting | Default | Range or values |
| --- | --- | --- |
| `state` | `working` | `working`, `blast`, `fire`, `after`, `flooded`, `sealed`, `yard_day`, `yard_night`, `yard_fire`, `yard_sealed` |
| `time` | 0 | 0 to 600 s of fire and smoke |
| `quality` | `film` | `film` (16 shadowed lamps, 1,024 maps), `preview` (8, 512) |
| `library` | `/asset-library/` | the URL root of the asset library |

Sources: the film's reference bible and lighting plan (fauld-reference-bible.md and fauld-tunnel-lighting-plan.md);
the store's records at Kew (AIR 17/8, 17/10, 17/12, plan MFQ 1/1003); McCamley, *Disasters Underground* (2004);
Waltham 2001, *Mercian Geologist* 15(2), 123 to 125, for the white gypsum about 35 m down; the Osram-GEC 60 W 240 V
coiled-coil lamp, 690 lm at 2700 K (lamptech.co.uk); Lagarde and de Rousiers 2014, *Moving Frostbite to PBR*, s5.1,
for EV100 metering. Fauld's own lamp wattage and spacing are not on record online, so the rig follows period practice.

## Timber valley: `@margoengine/scenes/timber-valley`

A northern Rockies mountain valley in the 1910 fires (the Big Burn of 20 and 21 August 1910, Idaho and Montana). The
defaults are the blowup afternoon of 20 August 1910 round Wallace, Idaho: a level floor 870 m up with the creek and the
rail grade on it, walls of about 30 degrees cut into side gulches (`rockiesValleyWorld` of `@margoengine/biomes`, a
4 km world), western white pine, larch, red cedar, Douglas-fir and grand fir on them, a mining and railway town laid out
as lots in two places along the line, and a fire that has run for 30 minutes under a 20 m/s south-west gale, with smoke
columns, flames on the hottest stretches of the front and embers. x is east, z south, y up, metres; the valley drains
west out of the world's west edge.

```ts
import {layout, world} from 'margoengine/scenes/timber-valley';
const w = await world({seed: 1910});
const plan = layout(w, {houses: 48});
console.log(plan.structures.length > 0, plan.rail.length > 100); // true true: town lots, and the rail line up the valley
w.dispose();
```

`attach(engine, settings)` (async) builds the world and draws it with `BiomeView` (terrain, the forest by species with
LOD rings, the creek's water, rocks and ground cover; nothing is placed on the rail, the creek or the lots), the sky,
bloom and tone curve of a `PresetScene` with the sun where it was for the date and hour, `VolumetricClouds`, shadows, a
`GTAO` occlusion pass, one `WeatherMachine` and a `WeatherDrive` that writes the wind, cloud and smoke haze into every
part and dries the fire's dead fuel from the weather's humidity and temperature, the fuel map of the forest
(`fuelMap`, Anderson's models 8 and 10 under timber, 1, 2 and 5 in the openings, none on the rail, the creek and the
streets) and a `FireFront` on it with the town lots as structures. The look family (`look`, default `animatedFeature`)
is written through each package's settings. The handle gives `height`, `anchors`, `views` and `view(name, fov)`,
`shots` (eight, from the catalogue) and `tracks` (a camera track per shot for `shotFilesFromScene` of `tools/shot`),
`targets`, `layout`, `applyLook(name)`, `applySettings({weather, sky, fire})` for per-shot rows, `advanceTime(seconds)`
(fire and sky), `settle()` (the forest tiles around the camera), the `parts` and `dispose()`.

| Setting | Default | Range or values |
| --- | --- | --- |
| `date`, `hour`, `latitude`, `longitude` | `1910-08-20`, 16, 47.47, -115.93 | the sun's place by `sunPath` and the moon's by `moonPosition`; with the sun below the horizon the sky is a moonlit night (`sunScene`) |
| `look` | `animatedFeature` | `animatedFeature`, `natural` |
| `weather` | `blowup` | `calm` (2 m/s), `redFlag` (9 m/s, 15 percent humidity, 32 C), `blowup` (20 m/s gusting, 12 percent, 30 C), `smoke` |
| `windFrom` | 225 | 0 to 360 degrees, the compass direction the wind blows from |
| `fire` | `running` | `none`, `running` (for `fireTime` seconds), `burnt` (run until nothing burns) |
| `fireTime` | 1,800 | 0 to 21,600 s |
| `houses` | 48 | 0 to 256 lots |
| `meshes` | none | library models by species key (`BiomeViewOptions.meshes`) |
| `quality` | `film` | `film` (2 km of objects, 4 m fire cells), `preview` (1 km, 8 m) |
| `seed` | 1910 | the valley, the forest, the town and the embers |

Presets: `blowup` (the defaults), `calm-august` (no fire, late morning), `red-flag` (ten minutes of fire on a red-flag
afternoon), `aftermath` (two days later, the fire burned out, under smoke). The town draws no buildings: its 1910 frame
and brick blocks, depot, mine works and locomotive have no models yet; the lots are laid out, burn as structures and
keep the forest off. `libraryMesh(url, options)` of `@margoengine/scenes/library` loads a library glTF as one mesh part
(base on the ground) for `meshes`, so a rock or plant model draws by key. A model whose material has a base colour map
keeps its maps: the part carries `textures` (its uvs and its base colour, normal and occlusion-roughness-metal images)
and draws textured; one of several textured materials goes to `libraryParts` (a coded `unsupported` error says so).
Pass `color` to draw it as one flat colour instead, as here:

```ts
import {libraryMesh} from 'margoengine/scenes/library';
const files: Record<string, unknown> = {
  'r.gltf': {asset: {version: '2.0'}, buffers: [{uri: 'r.bin', byteLength: 78}],
    bufferViews: [{buffer: 0, byteLength: 72}, {buffer: 0, byteOffset: 72, byteLength: 6}],
    accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3'},
      {bufferView: 0, byteOffset: 36, componentType: 5126, count: 3, type: 'VEC3'},
      {bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2}]}], nodes: [{mesh: 0}]},
};
const bin = new ArrayBuffer(78);
new Float32Array(bin, 0, 18).set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
new Uint16Array(bin, 72, 3).set([0, 1, 2]);
const fetch = async (url: string) =>
  ({ok: true, status: 200, json: async () => files[url], arrayBuffer: async () => bin});
const rock = await libraryMesh('r.gltf', {fetch, color: [0.3, 0.29, 0.27]});
console.log(rock.geometry.indices.length / 3, rock.kind); // 1 stone
// attach(engine, {meshes: {'procedural:rock': [rock]}}) draws it in place of the procedural rock.
```

`libraryParts(url, options)` loads a scanned model with its textures instead: one part per glTF material, each with its
TEXCOORD_0 (KHR_texture_transform applied), base colour, normal and metallic-roughness images (R read as occlusion, the
packing of Poly Haven scans), MASK and BLEND materials and names with twig, leaf or needle as `foliage` with an alpha
cut-out. Three URLs (near, middle and far levels of one model) give each part a geometry per LOD ring. Scans are heavy:
decimate them into levels first (the 1910 conifer is `plants/fir_tree_01/forest/fir_tree_01_a_{near,middle,far}.gltf`
in the asset library, 90,000, 20,000 and 11,371 faces).

```ts
import {libraryParts} from 'margoengine/scenes/library';
const base = '/asset-library/big-burn-1910/plants/fir_tree_01/forest/fir_tree_01_a';
const load = () => libraryParts([base + '_near.gltf', base + '_middle.gltf', base + '_far.gltf']);
// attach(engine, {meshes: {'procedural:douglas-fir/pole': await load()}}) draws the scanned fir as every Douglas-fir.
console.log(typeof load); // function
```

Sources: Pyne, *Year of the Fires: The Story of the Great Fires of 1910*, 2001 (the blowup, the south-west gale, the
burning of part of Wallace); Koch, "History of the 1910 forest fires in Idaho and western Montana", USDA Forest Service,
1942. The valley, forest, fuel and fire come from their packages' own sources (biomes docs/relief-and-hydrology.md and
docs/fuel.md, vfx fire-front).

## Fauld, Staffordshire: `@margoengine/scenes/fauld-countryside` and `@margoengine/scenes/fauld-crater`

The hills round Hanbury and Fauld on the real ground (Ordnance Survey OS Terrain 50, tiles SK12, SK13, SK22 and SK23,
resampled to 5 m; Open Government Licence v3.0, "Contains OS data (c) Crown copyright and database right"), the farm
quilt of `@margoengine/biomes/farmland` (hedged fields, hedge oaks, ashes and hollies, lanes that end at a junction, the
edge or a gate), hedgerows and woods grown by the biome view from library trees with Poly Haven bark maps, fields,
lanes, mud and woodland floor from Poly Haven ground scans (CC0) at their own repeats, and an overcast late-November
sky, clouds and weather calibrated to photographs of the area; the haze lies in the boundary layer, thinning by e
every 500 m over the ground round the subject (`FAULD_HAZE_SCALE_HEIGHT`, the sky fog's `scaleHeight`), so drone views
look down through thin air. `fauld-crater` stamps the 1944 crater (`era: '1944'`, bare
marl and gypsum) or the wooded hollow today (`era: 'today'`) into the terrain from its model's heights. Models, scans and
the height grid are served from `library` (default `/asset-library/`, which holds `margo-library/fauld/` and `dem/`);
the buildings, the fire tender, the WVS van and a grazing herd stand in their slots (`FAULD_SLOTS`, each with its eras),
from Tripo models decimated to real size in `margo-library/fauld/buildings/`, drawn by `@margoengine/gltf/textured`
with their base colour maps and stood on the ground; shots keep them 150 m or more away. Origin: the crater's centre,
OS grid E 418225, N 327725; x east, z south.

```ts
import { Engine } from 'margoengine';
import { attach, FAULD_PLACES, FAULD_SLOTS } from 'margoengine/scenes/fauld-countryside';

// Needs the asset library served at /asset-library/ (the OS Terrain 50 grid and the crater and tree models).
async function show(canvas: HTMLCanvasElement) {
  const engine = await Engine.create(canvas, { camera: { far: 40000 } });
  const scene = await attach(engine, { sky: 'dawn', focus: [...FAULD_PLACES.hanbury] });
  const [x, z] = FAULD_PLACES.hanbury;
  scene.look([x + 900, scene.height(x + 900, z + 1200) + 120, z + 1200], [x, scene.height(x, z) + 20, z], 30);
  engine.start();
  return scene;
}
console.log(typeof show, FAULD_PLACES.hanbury, Object.keys(FAULD_SLOTS).length); // function [-1225, -175] 9
```

| Setting | Default | What it does |
| --- | --- | --- |
| `era` | `before` (countryside), `1944` (crater) | `before`, `1944` or `today` |
| `sky` | `lowSun` | `dawn`, `lowSun`, `overcast`, `grey`, `dusk`, `night`, `snow`, `rain` or `mist` |
| `hour` | by `sky` | local solar time on 27 November |
| `focus` | `[0, 0]` | the shot's subject (the shot files keep it) |
| `radius` | 2,500 | how far round the camera the view grows plants (hedges, trees, woods), 200 to 3,000 m |
| `dem`, `library` | under `/asset-library/` | the height grid and the model library |
| `buildings` | `true` | draws the `FAULD_SLOTS` models of the era (church, inn, cottages, kiln works, guard hut, tender, van, cattle) |
| `lens` | `{stop: 8, focusDistance: 1000}` | the lens's f-number and focus distance (metres), drawn by `DOF` of `@margoengine/dof` on a Super 35 sensor (24.89 mm across), so its focal length follows the camera's field of view; the handle's `dof` is that effect |

Shot files for the film's crater and countryside rows: `node tools/shot/fauld-shots.mjs` (from the recut shot list).
Each lens is on the film's 24.89 x 14 mm filmback inside a named band (wide 18 to 24 mm, natural 35 to 50, portrait 85
to 135; a 28 or 200 mm row takes the nearest band edge), the aim drifts across the subject by 7 percent of the frame
width, and the page query carries the lens (`stop` f/8 or f/11, `focusDistance` at the harmonic mean of the subject's
near and far faces, so the thin-lens depth of field covers it);
every camera is checked against the scene's own ground, trees and hedges (`tools/shot/fauld-sight.mjs`,
`sightClearance`) and, where blocked, turned about its subject, stepped in towards the crater rim or lifted, the least
that works (`tools/shot/fauld-sight.json` records each row);
stills through the shot tool, which adds the page's ground under each camera (`shot.page.ground`):
`node tools/shot/cli.mjs tools/shot/shots/fauld-fr008.json --stills --out <folder>`, or by hand
`node packages/scenes/test/fauld-still.mjs --shots=fr008,fr074 --out=<folder>`.

### The Fauld ground without an engine

Tools that must know where the hills, hedges and trees stand without rendering them (shot cameras kept clear with
`@margoengine/cameras/clearance`) build the same ground on the CPU: `layFauldGround({ dem, era, crater })` gives the
biome world, farm, planting exclusions and height, `fauldDem(meta, heights)` reads the height grid and
`FAULD_PLANT_MODELS` names the plant models. All three are exported by `/fauld-countryside`.

```js
import { BiomePlacement } from '@margoengine/biomes/placement';
import { fauldDem, layFauldGround } from '@margoengine/scenes/fauld-countryside';

// Needs the asset library served at /asset-library/ (the OS Terrain 50 grid).
async function trees(url = '/asset-library/dem/os-terrain-50/fauld_sk12_sk23') {
  const meta = await (await fetch(`${url}.json`)).json();
  const dem = fauldDem(meta, new Float32Array(await (await fetch(`${url}.f32`)).arrayBuffer()));
  using ground = await layFauldGround({ dem, era: 'before' });
  const placement = BiomePlacement.attach(ground.world, { exclusions: ground.exclusions });
  return { plants: (await placement.tile(12, 12)).count, height: ground.height(0, 0) };
}
console.log(typeof trees); // function
```

## The Fauld explosion: `@margoengine/scenes/fauld-blast`

The countryside above at 11:11 on 27 November 1944, with the explosion drawn into it on film time. Two releases 1.6 s
apart (`FAULD_BLASTS`, 4,000 t of TNT equivalent split 55 / 45) rise as one merging mushroom cloud (`BlastCloud` of
`@margoengine/weather/eruption` in `Clouds` of `@margoengine/vfx/clouds`, the fire inside it in a second, unlit
`Clouds`); earth clods and gypsum blocks fly and land with dust (`Debris` of `@margoengine/vfx/debris`); the incendiary
dump catches at `FAULD_FIRE_AT` (`Fire` of `@margoengine/vfx/fire`); and with `mud: true` the burst reservoir's mud
pours down to the works from `FAULD_MUD_AT` (`Flood` of `@margoengine/water/flood`, a GPU solver). Every part is a
function of the film time, so `seek(t)` shows the same frame in any order, and each engine frame moves the film on by
its delta unless `clock: false`. It takes the countryside's settings (the `sky` default is `overcast`) plus:

| Setting | Default | What it does |
| --- | --- | --- |
| `time` | 0 | film seconds since the first explosion, 0 to 3,600; checked before the world is built |
| `mud` | `false` | the burst reservoir's mud flows to the works |
| `clock` | `true` | each engine frame moves the film on; `false` leaves it where `seek` puts it (a shot tool's own clock) |
| `puffs` | `{cap: 2040, stem: 1020}` | puffs of each cap and each stem drawn by `BlastCloud.draw` |

```ts
import { Engine } from 'margoengine';
import { attach, FAULD_BLASTS, FAULD_CLOUD_DECK } from 'margoengine/scenes/fauld-blast';

// Needs the asset library served at /asset-library/, like the countryside.
async function show(canvas: HTMLCanvasElement) {
  const engine = await Engine.create(canvas, { camera: { far: 40000 } });
  const scene = await attach(engine, { time: 30 });
  scene.look([-1800, 150, 900], [0, 900, 0], 30);
  scene.seek(60); // the column a minute after the first explosion
  engine.start();
  return scene;
}
console.log(typeof show, FAULD_BLASTS.length, FAULD_CLOUD_DECK.bottom); // function 2 1000
```

The blast rows of the shot list (`margo:scenes/fauld-blast`) come from the same `node tools/shot/fauld-shots.mjs`. Every
blast camera stays over the 6.4 km world and 150 m or more under the overcast deck's base in world height; the
generator records the OS Terrain 50 ground under each camera key in `packages/scenes/test/fauld-blast-ground.json`
for the scenes test, so the world and the weather are never moved for one camera.

## Look families: one call, every package

`applyLookFamily(name, targets)` (`@margoengine/scenes/look-family`) applies a look family by name through each package's own
apply function, for each part of the scene you give it. `LOOK_FAMILIES` is `['natural', 'animatedFeature']`. `natural` writes
every row at its default (each part draws as it does with no settings); `animatedFeature` is the animated-feature picture
style: a fuller zenith and warm horizon, a larger sun disc and rounder clouds in the sky; clear blue-green water with wide
soft foam; larger colour masses on the ground; air at 0.6 of the clear-air visibility; soft pale sand and smoke; one warm
grade with the saturation up 12 percent, no grain and dither on; a gentle bloom, a 180 degree shutter and GTAO and SSGI on.
A family is a picture style for any hour, never a time of day: the sky keeps the scene's clock (`hours`, `timeScale`)
and sun direction, so a night scene stays night and an afternoon keeps its sun under either family.
Both families live in each package's own table, `natural` (no rows: the defaults) beside `animatedFeature`
(`SKY_LOOKS`, `WATER_LOOKS`, `TERRAIN_LOOKS`, `WEATHER_LOOKS`, `ENVIRONMENT_LOOKS`, `SAND_LOOKS`, `SMOKE_LOOKS`, `FLAME_LOOKS`
(a `fire` target), `TONEMAP_LOOKS`, `POST_LOOKS` and the ground-material multipliers `BIOME_LOOKS`), so a page can also pick
one package's family alone. The `biomes` target is the options of a `BiomeView` before `BiomeView.attach` (the ground
materials are read when the view is built): its `materials` becomes `biomeMaterials(name)`.

| Target | Package apply function | Notes |
| --- | --- | --- |
| `sky` | `applySkySettings` | `{ sky }`, optionally its tonemap, grade and volumetric clouds |
| `water` | `applyWaterSettings` | a `Water`; a wind or chop the family set goes back to the Water's own under `natural` |
| `terrain` | `applyTerrainSettings` | a `TerrainColors` |
| `weather` | `applyWeatherSettings` | writes the family's state: give it only when nothing else owns the weather |
| `environment` | `applyEnvironmentSettings` | `{ air }` (a `VolumetricFog`) and/or the scene `fog`, `environment`, `background` |
| `sand`, `smoke`, `fire` | `applySandSettings`, `applySmokeSettings`, `applyFlameSettings` | a `BlownSand`, a `Smoke` or a `FireFront` (its smoke columns keep their heat and radius), a `Fire` or a `FireFront` |
| `tonemap` | `applyTonemapSettings` | `{ tonemap, grade }`: the family's `grade.saturation` needs a `Grade` in `grade` |
| `post` | `applyPostSettings` | `{ bloom, gtao, ssgi, dof, lens, motionBlur }`: the family turns GTAO and SSGI on, so it needs both |
| `biomes` | `biomeMaterials` | `{ materials }` of a `BiomeView` not yet attached |

Every part is proved on the CPU (test/look-family-parts.test.js: the family by name gives the package's own table values,
`natural` gives the defaults back byte for byte) and on a real GPU on WebGPU and the WebGL2 layer
(test/look-family-gpu.mjs: the family changes the picture and `natural` gives back the first frame).

```ts
import { Sky } from '@margoengine/sky';
import { applyLookFamily } from '@margoengine/scenes/look-family';

const sky = new Sky();
const smoke = { options: {} }; // any target with an options object, such as a Smoke
applyLookFamily('animatedFeature', { sky: { sky }, smoke });
console.log(sky.options.look); // { cloudDensity: 1.2, zenithStrength: 0.35, horizonStrength: 0.3, sunDiscSize: 2.2, sunDiscSoftness: 0.6 }
applyLookFamily('natural', { sky: { sky }, smoke }); // every row back at its default
```
