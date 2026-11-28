# @margoengine/weather

Import `margoengine/weather` from the `margoengine` package, or `@margoengine/weather` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Weather as a state that changes over time, on top of `@margoengine/sky`'s rain, snow and lightning: a state machine with presets that blends between weathers, follows a schedule or wanders by a seeded chain; a deterministic wind field with gusts and turbulence; ground wetness and snow cover with material hooks in JavaScript and WGSL; helpers that set the sky's `Weather`; and hail drawn as GPU particles that bounce. Rain, snow and lightning stay in `@margoengine/sky/weather`, which this package drives and does not repeat.

```ts
import { WeatherMachine, applyWetness, hailSettings, skyWeather, windAt } from 'margoengine/weather';
import { Hail } from 'margoengine/weather/hail';
import { Weather } from 'margoengine/sky/weather';
import {Engine} from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
const road = { roughness: 0.6 }; // any material with a numeric roughness

const weather = new WeatherMachine('clear', { seed: 7 });
const rain = Weather.attach(engine, { fadeSeconds: 0 }); // the machine does the easing
const hail = Hail.attach(engine);

weather.transitionTo('thunderstorm', { seconds: 45 }); // blends from wherever the weather is now
weather.on((event) => event.type === 'arrive' && console.log('now', event.preset));

engine.onFrame((_, delta) => {
  const state = weather.update(delta);
  const wind = windAt(weather.wind, 0, 2, 0, weather.time); // wind at the camera
  Object.assign(rain.options, skyWeather(state, wind));
  Object.assign(hail.options, hailSettings(state, wind));
  applyWetness(road, 0.8, weather.wetness); // shinier when wet
});
```

## State and presets

A `WeatherState` is nine numbers: `rain`, `snow`, `hail` (0..1), `wind` (m/s), `gust` (0..1), `windDirection` (radians, 0 toward +Z and pi/2 toward +X like lightning azimuth in the sky), `cloud`, `fog` and `lightning` (0..1). `WEATHER_PRESETS` has `clear`, `partlyCloudy`, `overcast`, `fog`, `drizzle`, `rain`, `storm`, `thunderstorm`, `hail`, `sleet`, `snow` and `blizzard`. They are authoring defaults that read well in a game, not meteorology; copy one to change it (`{...WEATHER_PRESETS.rain, wind: 12}`). A bad field throws `TypeError` or `RangeError` naming the field and its range.

## The machine

- `transitionTo(target, {seconds = 30, ease = 'smoothstep'})` blends to a preset or a partial state. Starting another one mid-blend continues from the current weather, so nothing jumps. `set(target)` jumps.
- `schedule([{to, seconds, hold}], {loop})` runs steps in order. `randomWalk(from, {chain, hold, blend, seed})` wanders by a weighted chain (`TEMPERATE` by default; a made-up mild climate), the same way for the same seed; seeds that differ in any way (-1 and 4294967295, 1 and 1.5) walk differently.
- `on(listener)` gets `start` and `arrive` events once each per transition. A listener may call `set` or `stop`; its `transitionTo`, `schedule`, `randomWalk` or `update` throws `MargoError` `'state'` before changing anything.
- `update(delta)` moves everything; a long delta (a hidden tab) is applied in pieces of at most 5 s so the ground and the schedule behave as if time had passed normally. Every blend and hold that ends inside a piece is processed, however many there are, so no time is lost. A call refused for a bad target, seconds, ease or seed (`transitionTo`, `set`, `schedule`, which checks every step's ease up front, and `randomWalk`) throws before it stops a running schedule or walk. `state` is a fresh copy each read.
- `wetness` rises under rain and hail (about 20 s) and dries (about 90 s); `snowCover` builds under snow (about 2 minutes) and melts (about 5 minutes). The time constants match the sky's own `Weather`.
- `using` and `dispose()` end it; use afterwards throws `MargoError` `'disposed'`.

## Wind

`machine.wind` is a `WindField`, kept in step with the state; make your own with `new WindField({speed, direction, gust, turbulence, gustPeriod, scale, seed})`. `sample(x, y, z, t)` returns a velocity: the mean wind scaled by a gust factor (between `1 - gust` and `1 + gust`), a direction that wobbles up to `0.5 * gust` radians, and turbulence that differs from place to place and blows downwind with the mean: the pattern is frozen and carried by the mean speed and mean direction (Taylor's hypothesis), never by the gusting direction, so the wind at a point changes as slowly an hour in as at the start. `drift(t)` is how far it has been carried (metres along x and z). `set(options, at)` changes settings at the field's time `at` and carries the turbulence on from where it was, so a weather blend's changing mean wind never makes it jump; `WeatherMachine` passes its own time, and `resetDrift()` puts the pattern back where a fresh field has it. It is a pure function of its arguments and its `set` calls, so the same calls give the same vector, and its length never exceeds `speed * (1 + gust + turbulence)`. Use it for rain slant, sway of trees and cloth, or a sound's wind layer.

```js
import { WindField } from 'margoengine/weather';

const field = new WindField({ speed: 20, direction: 0.6, gust: 0.8 });
const [vx, vy, vz] = field.sample(0, 2, 0, 1800); // half an hour in
field.set({ speed: 24 }, 1800); // the turbulence goes on from where it was
const [dx, dz] = field.drift(1810); // where the pattern has been carried
```

## Wet and snowy surfaces

`wetRoughness`, `wetColor`, `snowWeight` and `surfaceResponse` give a surface's roughness and colour from the ground state: wet is darker (up to 25 percent) and shinier (down to 35 percent of the dry roughness), and snow whitens up-facing surfaces first and steeper ones as the cover grows. `applyWetness(material, dryRoughness, wetness)` sets `material.roughness`. For a shader, paste `surfaceWGSL` ahead of it and call `weather_surface(roughness, color, normalY, wetness, snowCover)`; the real-GPU test checks that WGSL against the JavaScript.

### Physical land-surface energy and water

`@margoengine/weather/surface-energy` advances a patch's ground temperature, liquid storage, snow water equivalent and
dead-fuel moisture on the `PhysicsWorld` clock. It accounts for incoming sunlight and longwave radiation, thermal
emission, sensible and latent heat, ground conduction, melting, precipitation, condensation and runoff.

```ts
import { CelestialSolver, INSOLATION_FIELD, insolationFromPort } from '@margoengine/physics/celestial';
import { PhysicsWorld } from '@margoengine/physics/world';
import { wetColor } from '@margoengine/weather';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const site = { latitude: 0, longitude: 0 }; // radians
const ground = new SurfaceEnergySolver({
  id: 'basin',
  inputs: {
    shortwave: {
      field: INSOLATION_FIELD,
      sample: (memory, port) => insolationFromPort(memory, port, site).horizontal,
    },
  },
});
world.add(new CelestialSolver(), {}).add(ground, { rain: 2e-5, initialWater: 0 });
world.advance(60);
const patch = ground.read();
console.log(wetColor([0.35, 0.22, 0.13], patch.wetness), patch.temperature);
```

`read()` returns temperature in K, liquid and snow storage in kg/m², and wetness as a fraction of liquid capacity.
Supply `inputs` to bind any forcing option to an upstream field. The default reader reads one layout-1 f32 or f64 word.
A pure `sample(memory, port, context)` projection can read a point in a grid or obtain local sunlight from a celestial
port. A `Precipitation` field can supply patch rain and snow, with rates converted from mm/h of water equivalent.
Precipitation is sampled at the end of the solver's interval. Bound and published forcing ports take precedence over
the sample and over the fallback options.

Every output region uses layout 1 and f64. `temperatureField` and `wetnessField` each publish one value per patch.
`energyFluxField` publishes net radiation, sensible, latent, ground and melt heat flux in W/m², in that order per patch.
`waterFluxField` publishes evaporation, melt and runoff in kg/(m² s). Negative evaporation is condensation.
`fuelMoistureField` publishes the 1-, 10- and 100-hour dead-fuel fractions by dry weight, in that order.
Use `albedo` and `surfaceResistance` inputs to accept cover changes such as a burn scar.

Provide `grid` when several nearby patches need independent storage and forcing. The origin is the first patch
centre in the solver's signed cell, and the spacing follows X then Z. Per-patch overrides and output records
run X fastest. Set `patchStride` to the number of source words between neighboring patches for a dense layout-1 input
in the same cell. Its default zero uses one uniform word. Set `grid.cellSize` to the world's size when it differs
from 4,096 m. A legacy one-patch `precipitation.position` stays in the precipitation field's own cell.

```ts
import { PhysicsWorld } from '@margoengine/physics/world';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';

using ground = await SurfaceEnergySolver.load({}, { threads: 2 });
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(ground, {
  initialWater: 0,
  grid: { columns: 2, rows: 1, spacing: [2, 2], patches: [{ rain: 2e-5 }, {}] },
});
world.advance(60);
console.log(ground.readPatch(0).water, ground.readPatch(1).water, ground.workCounts());
```

The threaded example runs in Node or a cross-origin-isolated browser worker. `load` defaults to one native
participant and can also use four. The count includes the caller. Workers share private native scratch.
`new SurfaceEnergySolver()` uses TypeScript without loading assets. `read()` still returns the first patch.
An invalid forcing value, clock or numeric result rejects the entire step before any port is replaced.

## Puddles and wet ground

`Puddles` from `margoengine/weather/puddles` makes the rain show on every core mesh and every `Material` mesh of
`margoengine/materials` ("On Material meshes" below): surfaces darken and turn shinier
with the wetness, water gathers in the low spots of flat ground as the ground soaks, and falling rain rings it. It
follows a `WeatherMachine` or the sky's `Weather` (anything with `wetness`, and `state.rain` or `amount`), or numbers you
set. WebGPU only.

```ts
import { WeatherMachine } from 'margoengine/weather';
import { Puddles } from 'margoengine/weather/puddles';
import { Engine, PbrMaterial, box } from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box(40, 0.2, 40)).setMaterial(new PbrMaterial({ color: '#4a4a44', roughness: 0.85 }));

const weather = new WeatherMachine('rain', { seed: 3 });
const puddles = Puddles.attach(engine, { weather, coverage: 0.35 }); // a third of flat ground under water when soaked
engine.onFrame((_, delta) => weather.update(delta)); // the ground soaks in about 20 s of rain
puddles.options.size = 5; // wider puddles
```

It hooks core's mesh shader before lighting, so the sky's light, environment lighting and fog see the wet surface.
Wetness darkens every surface as `wetColor` does and smooths it by the water film it holds (set `wetSurfaces: false`
to draw only the water, for example when you already call `applyWetness`). Rain drains off the crests of the ground and
stands as a film in its low spots, so `puddleFilm(x, z, normalY, wetness)` is 1 in the relief's lower half times the
wetness and 0 on the drained crests (0.5 on walls), and `dampRoughness(roughness, wetness, film)` smooths by up to 65
percent under a whole film and 23 percent where it drained: damp asphalt keeps patchy, rough highlights instead of
turning into a mirror (Lagarde 2013, "Water drop 3b: physically based wet surfaces"; Jensen, Legakis and Dorsey 1999,
"Rendering of wet materials", doi:10.1007/978-3-7091-6809-7_25). Water stands where a procedural relief of puddles about
`size` metres wide (default 3) lies below a water level, on surfaces within about 15 degrees of flat: from wetness
`start` (0.4) the share of flat ground under water grows to `coverage` (0.3, at most 0.8) at wetness 1. Under water a
surface is darker by 30 percent, has no metalness, and its normal turns up and is tilted by rings: one drop at a time
in each `rippleSize` cell (0.35 m) of two offset grids, in a share of the cells equal to the rain, by up to
`rippleStrength` (0.35). Its roughness is calm water's 0.03 plus the slope variance of rings too small to resolve,
`puddleWaterRoughness(rain, rippleStrength)` = sqrt(0.03^2 + 0.112 rain strength) (Toksvig 2005, "Mipmapping normal
maps", doi:10.1080/2151237X.2005.10129203; Olano and Baker 2010, "LEAN mapping", doi:10.1145/1730804.1730834): 0.2 in full
rain, so lamps smear in a rain-struck puddle and sharpen again when the rain stops. `puddleMask`, `puddleSurface`,
`puddleFilm`, `puddleRelief` and `puddleLevel` are the same maths in JavaScript; `puddleWGSL` is the shader for your own
materials.

```ts
import { dampRoughness, puddleFilm, puddleWaterRoughness } from 'margoengine/weather/puddles';
const film = puddleFilm(2, 5, 1, 0.9); // 0 on a drained crest to 1 in a low spot
console.log(dampRoughness(0.5, 0.9, film), puddleWaterRoughness(0.8)); // patchy damp gloss; rain-roughened water
```

A bad option throws `RangeError` or `TypeError`; a
replaced core shader throws `MargoError` `'unsupported'`.

### On Material meshes

`Puddles`, `Snow` and `PrecipitationCover` reach the meshes `createMesh` of `margoengine/materials` makes as they reach
core meshes, with no call per mesh: each such mesh with a lit material (standard, Lambert, Phong or toon shading) joins
their `materialSurface` on its next draw and leaves it when they are disposed. A `Material` and a core `PbrMaterial` of
the same colour, roughness and metalness take the same wetness, water, rain rings and snow, lift included
(`tests/material-wet-browser.mjs` holds the two to the same pixels on WebGPU and the WebGL2 layer). The weather runs on
the Material's surface after every map, triplanar and parallax read it made, before any lighting. Set a mesh's
`sceneSurfaces` to `false` to keep it dry (a sign under a canopy, a screen).

```ts
import { Engine } from 'margoengine/core';
import { Material, createMesh } from 'margoengine/materials';
import { Puddles } from 'margoengine/weather/puddles';
import { Snow } from 'margoengine/weather/snow';

const engine = await Engine.create(document.querySelector('canvas')!);
const quad = (size: number, y: number) => ({
  positions: [-size, y, -size, size, y, -size, size, y, size, -size, y, size],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 3, 1, 1, 3, 2],
});
createMesh(engine, quad(20, 0), new Material({ color: '#30363b', roughness: 0.8, metalness: 0.1 })); // asphalt
const canopy = createMesh(engine, quad(2, 2.4), new Material({ color: '#c8a040', roughness: 0.5 }));
canopy.sceneSurfaces = false; // this one stays dry

Puddles.attach(engine, { wetness: 0.95, rain: 0.6, coverage: 0.35 }); // the asphalt darkens, pools and rings
Snow.attach(engine, { cover: 0.3, depth: 0.05 }); // and a thin snow settles on it
```

The surface entries bind their uniforms in gltf/pbr's group 2 at slots 166 to 169 (`MATERIAL_SLOTS` in the source:
160 to 166 for the puddles, 161 to 167 for the snow, 164 and 165 to 168 and 169 for a snow field); the cover keeps
162 and 163. A snow field reads its map at the fragment's position on a Material mesh, where core meshes read it at
the pixel's centroid. A Material mesh under weather composes its shader each frame, as one under a `Sky` does; meshes
that share material and geometry still draw as one instanced batch.

A Material mesh is a gltf/pbr model, so `GLTFWeather.add` takes one as well. Such a mesh takes its weather from that
`GLTFWeather` alone: the scene's `Puddles`, `Snow` and `PrecipitationCover` leave it while any `GLTFWeather` has it
(their `materialSurface` `skips` it) and take it back once it is removed, so the weather is never applied, or its WGSL
declared, twice. Give the `GLTFWeather` a `cover` to shelter it. A film that hands every model to one receiver list may
include a `GLTFWeather` there.

```ts
import { Engine } from 'margoengine/core';
import { Material, createMesh } from 'margoengine/materials';
import { Puddles } from 'margoengine/weather/puddles';
import { GLTFWeather } from 'margoengine/weather/gltf';

const engine = await Engine.create(document.querySelector('canvas')!);
const rain = { wetness: 0.9, rain: 0.6, coverage: 0.3 };
Puddles.attach(engine, rain); // every Material and core mesh of the scene
const imported = GLTFWeather.attach(engine, { puddles: rain });
const kerb = createMesh(engine, {
  positions: [-2, 0.15, -1, 2, 0.15, -1, 2, 0.15, 1, -2, 0.15, 1],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 3, 1, 1, 3, 2],
}, new Material({ color: '#6b6862', roughness: 0.8 }));
const remove = imported.add(kerb); // the kerb is wetted once, by the GLTFWeather
remove(); // and by the scene's Puddles again
```

A scene may hold several `GLTFWeather` effects, each with its own settings and models (each takes its own plugin name:
the `name` option, or with none `attach` takes the first free of `weather-gltf`, `weather-gltf-2`, ... in the scene,
so a world built again for a seek or a second shot names its effects as the first build did; KB-WEATHER-GLTFSEEK1). Water stands only on surfaces that can hold it: give props, roofs and vehicles,
whose small tops and edges shed it, an effect with `coverage: 0`, so they darken and gloss in the rain while the ground
pools (`tests/material-wet-browser.mjs`, KB-WEATHER-GLTFTWO1, WebGPU and the WebGL2 layer).

```ts
import { Engine } from 'margoengine/core';
import { GLTFWeather } from 'margoengine/weather/gltf';

const engine = await Engine.create(document.querySelector('canvas')!);
const rain = { wetness: 0.95, rain: 0.7, coverage: 0.25 };
const ground = GLTFWeather.attach(engine, { puddles: rain }); // add the yard and the track here
const props = GLTFWeather.attach(engine, { puddles: { ...rain, coverage: 0 } }); // and the crates and drums here
console.log(ground.name, props.name); // weather-gltf weather-gltf-2
```

## Snow with depth

`Snow` from `margoengine/weather/snow` lays snow on every core mesh and every `Material` mesh: up-facing surfaces
whiten first and steeper ones as the cover grows, the snow line is patchy, the surface has a fine grain, and the snow has thickness: covered
surfaces are lifted by it, so a plate's edge rises and ground snow buries the foot of a wall that a roof shelters
(see "Snow and rain kept off under a roof" below). It follows a `WeatherMachine` or the
sky's `Weather` by their `snowCover`, or the `cover` you set. WebGPU only.

```ts
import { WeatherMachine } from 'margoengine/weather';
import { Snow } from 'margoengine/weather/snow';
import { Engine, PbrMaterial, box } from 'margoengine/core';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box(40, 0.2, 40)).setMaterial(new PbrMaterial({ color: '#3d4a33', roughness: 0.9 }));

const weather = new WeatherMachine('snow', { seed: 2 });
const snow = Snow.attach(engine, { weather, depth: 0.2 }); // 20 cm on flat ground at full cover
engine.onFrame((_, delta) => weather.update(delta)); // snow cover builds in about 2 minutes
snow.options.variation = 0.6; // deeper drifts and thinner patches
```

Cover follows `snowWeight` (at full cover anything within about 70 degrees of flat), with the edge broken up by noise.
Under snow a surface takes `color` (`SNOW_COLOR`) and `roughness` (`SNOW_ROUGHNESS`), loses its metalness and has a
grain of strength `grain` (0.3). Its thickness is `depth` (0.12 m) times the cover on flat ground, less on slopes and
none on walls, varied in drifts `drift` metres wide (4) by up to `variation` (0.4). The vertex stage moves every vertex
the sky sees up by the thickness on flat ground at its place, whichever way its face turns: a flat-shaded box has its
own vertices per face, and its top and the top of its sides share a place, so they rise together and the faces stay
joined (a lift by each vertex's own normal raised the top off the sides, a gap seen side on; fixed 2026-11-14). Without
a cover every vertex is under the open sky, so everything rises by the same thickness; with a `PrecipitationCover` the
vertices under a shelter stay down, and the sides of a shelter rise only at their top edge. `snowAt` and `snowDepthAt`
are the same maths in JavaScript; `snowWGSL` is the shader for your own materials. `Snow` and `Puddles` work together
on one scene. A bad option throws `RangeError` or `TypeError`; a replaced core shader throws `MargoError`
`'unsupported'`.

## Snow and rain kept off under a roof

`PrecipitationCover` from `margoengine/weather/cover` gives rain, `Puddles`, `Snow` and `GLTFWeather` one top-down
depth map of the meshes you name as shelters, so nothing under a roof gets wet, white or lifted. It takes a new,
unattached `WeatherFX` from `margoengine/sky/weather-fx` (the capture) and runs only its map pass. WebGPU only.

```ts
import { Engine, PbrMaterial, box } from 'margoengine/core';
import { Weather } from 'margoengine/sky/weather';
import { WeatherFX } from 'margoengine/sky/weather-fx';
import { PrecipitationCover } from 'margoengine/weather/cover';
import { Snow } from 'margoengine/weather/snow';

const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box(40, 0.2, 40)).setMaterial(new PbrMaterial({ color: '#3d4a33', roughness: 0.9 }));
// A shelter: the ground under this roof stays bare, and only the roof's top and the top of its sides rise.
const roof = engine.createMesh().setGeometry(box(4, 0.2, 4)).setPosition([0, 2.5, 0]);
roof.setMaterial(new PbrMaterial({ color: '#6b4a32', roughness: 0.8 }));

const weather = Weather.attach(engine, { precipitation: 'snow', intensity: 0.6, radius: 20 });
const cover = PrecipitationCover.attach(engine, new WeatherFX({ weather, occluders: [roof], splashes: 0, lensDrops: 0 }));
Snow.attach(engine, { cover: 1, depth: 0.15 });
console.log(cover.bias); // 0.02 m: a surface within 2 cm of a shelter's top still counts as under the sky
```

The map is the capture's square of side 2 x the weather's `radius` (default 25 m) around the camera, at the capture's
`resolution` (default 256 texels), so set `radius` to reach every sheltered surface in view: outside the square
everything counts as under the sky. A point is sheltered by the highest shelter of the four texels around it, so it
stays dry under any shelter at least one texel wide, and up to one texel past its edge. `bias` (0.02 m, finite and 0
or more) is how far below a shelter's top a surface may lie and still count as on top of it. A surface facing up
(sloped up to 60 degrees) adds its own rise across those texels, so a sloped roof gathers snow on its own top instead
of sheltering itself in stripes (slope-scaled bias, as in shadow maps); a steeper one, a wall, keeps the plain bias. Pass the cover as
`GLTFWeather`'s `cover` option for imported models. An attached or disposed capture throws `MargoError`; a bad `bias`
throws `RangeError`.

## Snow that drifts and slides

`SnowDrift` from `margoengine/weather/snow-drift` is lying snow on a ground grid that the wind moves: it scours windward
slopes and crests, drops the snow on lee slopes and in hollows, grows cornices on sharp lee edges that break off when
they overhang too far, sloughs snow off ground steeper than its angle of repose, and keeps the slide state an avalanche
starts from (a slab on a buried weak layer and how near it is to sliding). It is a pure function of its options, the
weather it follows and film time: fixed steps, cells in a fixed order and no randomness, so `seek` to any time gives the
same snow however it got there (going back replays from 0). Pass it to `Snow` as `field` to draw it on the ground.

```ts
import { Engine, Geometry, PbrMaterial } from 'margoengine/core';
import { heightfield } from 'margoengine/terrain';
import { WeatherMachine } from 'margoengine/weather';
import { Snow } from 'margoengine/weather/snow';
import { SnowDrift } from 'margoengine/weather/snow-drift';

const engine = await Engine.create(document.querySelector('canvas')!);
// A ridge across an east wind: a long windward ramp and a steep lee face, sampled every metre.
const N = 129,
  origin: [number, number] = [-64, -64];
const ridge = (x: number, z: number) => (x < 0 ? 12 * Math.max(0, 1 + x / 50) : 12 * Math.max(0, 1 - x / 10));
const ground = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ground[j * N + i] = ridge(origin[0] + i, origin[1] + j);
engine
  .createMesh()
  .setGeometry(heightfield(ridge, { size: [N - 1, N - 1], origin, resolution: N - 1 }))
  .setMaterial(new PbrMaterial({ color: '#4a4038', roughness: 0.9 }));

const weather = new WeatherMachine('blizzard', { seed: 2 });
// The blizzard's snow, wind speed, temperature and humidity; the wind turned to blow across the ridge (toward +X).
const drift = new SnowDrift({ width: N, depth: N, origin, ground, weather, windDirection: 90, timeScale: 600 });
Snow.attach(engine, { field: drift });
const cornices = engine.createMesh().setMaterial(new PbrMaterial({ color: '#eef1f5', roughness: 0.85 }));
let drawn = -1;
engine.onFrame((_, delta) => {
  drift.update(delta); // 10 minutes of storm per second of film
  if (drift.version === drawn) return;
  const g = drift.corniceGeometry();
  cornices.setGeometry(new Geometry(g.positions, g.normals, g.indices));
  drawn = drift.version;
});
drift.seek(30); // five hours in
console.log(drift.depthAt(-30, 0), drift.depthAt(0, 0), drift.depthAt(3, 0)); // windward, the bare crest, the lee drift
console.log(drift.cornices().length, drift.slide().release); // cornice cells, cells whose slab would release
```

Snowfall is the option `snowfall` in mm/h of water, or follows the weather's `snow` by `snowfallRate`: the rate whose
extinction (Rasmussen, Vivekanandan, Cole, Myers and Masters 1999: sigma = 2 S / (Vt m/A), dry snow falling at 1 m/s
with 0.2 kg/m^2 of mass per area) is the snow extinction `visibility` uses, so light snow (0.35) is about 0.9 mm/h,
moderate (0.65) 1.9 and 1 about 4. `snowVisibility(rate, fallSpeed?, massPerArea?)` is the same relation the other way:
1 mm/h of dry snow leaves about 1.4 km, wet snow (1.5 m/s, 0.8 kg/m^2) six times as far. Snow falls as snow below 0 C,
half at 1 C and none from 2 C (`snowShare`, Dai 2008), at the new-snow density of Hedstrom and Pomeroy 1998
(`newSnowDensity`: 119 kg/m^3 at 0 C, 68 in deep cold).

The wind moves snow above the threshold of Li and Pomeroy 1997 (`snowThreshold`: 9.43 + 0.18 T + 0.0033 T^2 m/s at
10 m, lowest about 7 m/s near -27 C, 9.9 for wet snow) or the `threshold` you set. `snowTransport` is the larger of
Pomeroy and Gray's 1990 saltation and the developed total of the Prairie Blowing Snow Model (Pomeroy, Gray and
Landine 1993: U10^4.04 / 714,801 kg/m/s, times 1 - (Ut/U)^2), times `transport`. The terrain weights the wind as
MicroMet does (Liston and Elder 2006: 1 + `slopeWeight` x the slope along the wind + `curvatureWeight` x the
curvature over `curvatureLength`, each scaled to -0.5..0.5), and a lee cell whose upwind horizon rises by
`shelterAngle` within `shelterDistance` loses `shelter` of it (Winstral, Elder and Davis 2002). The snow in motion grows
toward that capacity over `fetch` (100 m, Takeuchi 1980) and lands over `settle` (5 m) where the wind can carry less;
the depth changes by what crosses each cell's faces (Liston and Sturm 1998, SnowTran-3D), never more than the snow
there, so every kilogram is counted in `budget` (fallen, blown in and out at the edges, sublimated, held in cornices).
`inflow` (true) brings snow in at the upwind edge as from a snowfield beyond; `sublimation` (0.02) is the share lost
per 100 m of travel in dry air (none at full humidity). Wind-moved snow lands at `windDensity` (300 kg/m^3).

Snow on ground steeper than `repose` (45 degrees; 90 never) slides to its lower neighbours, half the excess a pass and
two passes a step (Fearing 2000; Musgrave, Kolb and Mace 1989), so a steep face sheds to its foot. A cornice grows on a
cell whose ground drops by more than `corniceAngle` (35 degrees) to the next cell downwind and is no lower than the cell
upwind: it catches `corniceCapture` (0.25) of the snow blowing over it. `cornices()` lists them (place, lean,
kg per metre, `overhang` from a quarter-ellipse cross-section at `corniceDensity`, `height` 0.6 of it);
`corniceGeometry()` is a closed, flat-shaded mesh of them; past `corniceMax` (3 m) a cornice breaks off onto the lee
cell below and `corniceFalls()` records it (Vogel, Eckerstorfer and Christiansen 2012).

The slide state follows Foehn 1987 and Schweizer, Jamieson and Schneebeli 2003. Snow lying at time 0 (`initialDepth`)
is old snow on a weak layer; new and wind-laid snow is the slab on it. After `burial` seconds of fair weather (6 hours)
the surface becomes the next weak layer and the slab joins the old snow. `slide()` gives, per cell, the slab depth and
mass, the old snow depth, the weak layer's shear strength (`weakLayer` 500 Pa, Jamieson and Johnston 2001's 0.2 to
2 kPa, plus `weakFriction` x the slab's normal stress and `sintering` Pa per hour of age), the shear stress the slab puts
on it (rho g h sin psi cos psi on the bed's slope psi, plus `trigger` Pa), the slope and the index strength / stress
(capped at `STABILITY_MAX` 10 where there is no slab or slope); `release` counts cells under 1. `snowStability` names
the class (`release` under 1, `poor` under 1.5, `fair` under 2.5, then `good`), and `stabilityAt(x, z)` reads one cell.

`wind`, `windDirection` (degrees, 0 toward +Z, 90 toward +X), `snowfall`, `temperature` and `humidity` follow the
`weather` while unset (null); a value overrides it. `timeScale` is simulated seconds per film second (1); `step` (10 s),
`width`, `depth`, `cellSize`, `initialDepth` and `initialDensity` are fixed, and changing `step` or the initial snow
replays from 0. `snowDepth()`, `snowMass()`, `depthAt`, `surfaceAt` and `mass` read the snow; `version` grows with every
step. With a `field`, `Snow` gives every surface on the field's ground (up to `band`, 0.05 m, above it) the field's depth
and whitens it by it (`snowFieldCover`: smoothstep(0.003, 0.03, depth), with the snow line's slope rule), and keeps the
weather's `cover` and `depth` off the field or above its ground; `snowFieldAt`, `snowFieldCover` and `snowFieldDepth`
are the shader's maths in JavaScript, and the real-GPU test holds the WGSL to them on WebGPU and the WebGL2 layer. A
bad option throws `RangeError` or `TypeError`. `examples/test-pages/snow-drift.html` is a whole ridge scene that checks
its budget, seek and step and the drawn field after every button.

## Avalanches with a powder cloud

`Avalanche` accepts a layered `Snowpack` from `@margoengine/physics/snowpack` as `snow`. At release, it reads the
current cover, slab water-equivalent mass and stability. `blocked` marks impermeable building footprints with one
zero or one per height sample. `obstacleDrag` gives one value or an array of distributed drag coefficients in
m⁻¹, equal to half the drag coefficient times the frontal area per volume. These options act on the dense flow.

```ts
import { Avalanche } from '@margoengine/weather/avalanche';
import { Snowpack } from '@margoengine/physics/snowpack';
import { PhysicsWorld } from '@margoengine/physics/world';

const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
const snow = await Snowpack.load();
world.add(snow, {
  width: 3, depth: 3, cellSize: 4, ground: [8, 8, 8, 4, 4, 4, 0, 0, 0],
  layers: [{ mass: 120, density: 300, cohesion: 50 }],
});
world.advance(60);
const slide = new Avalanche({
  snow, obstacleDrag: 0.1, blocked: [0, 0, 0, 0, 0, 0, 0, 1, 0], cloud: false,
});
slide.seek(2);
console.log(slide.budget());
```

`Avalanche` from `margoengine/weather/avalanche` is a snow avalanche on a terrain grid, deterministic over film time
with no physics engine. At `releaseTime` a slab breaks away (a rectangle across the slope, or with a `SnowDrift` as
`snow` every sample whose slide state is under 1); the dense core flows down the ground as a depth-averaged layer
(Savage and Hutter 1989) with Voellmy's friction (dry `friction` mu and turbulent `turbulence` xi, as RAMMS), takes
the snow cover in its path at `entrainment` times its speed and stops as deposit. A fast front throws part of what it
takes up into a powder cloud: parcels that grow in height as they run, entrain air, pick up more cover above
`cloudThreshold` and settle out below it (Beghin et al. 1981; Rastello and Hopfinger 2004); the weather's wind drifts
them. The cloud's head is fed at the core's front, so it runs with or ahead of the core and overruns it on the run-out
(Sovilla, McElwaine and Louge 2015). Plants bend along the flow from `bendPressure` (`plantBend`, or `plantPushers` for
a `TrampledScatter` of `margoengine/scatter/interact`), trees break where the pressure passes `breakPressure` and a deep
deposit buries plants. It is a snow field: pass
it to `Snow` as `field` and the ground shows the cover, the bare scar, the moving core and the deposit; `drawCloud`
puts the cloud into a `Clouds` of `margoengine/vfx/clouds` as soft lit puffs; `AvalancheScatter` gives a `Scatter` the
snow surface and the plants left standing. `seek` to any time gives the same avalanche however it got there.

```ts
import { Engine, PbrMaterial } from 'margoengine/core';
import { heightfield } from 'margoengine/terrain';
import { Clouds } from 'margoengine/vfx/clouds';
import { WeatherMachine } from 'margoengine/weather';
import { Snow } from 'margoengine/weather/snow';
import { Avalanche } from 'margoengine/weather/avalanche';
import { AVALANCHE_LOOKS, applyAvalancheSettings } from 'margoengine/weather/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [300, 220, 700], target: [0, 120, 250], near: 1, far: 4000 },
});
// A 38 degree face falling toward +Z into a flat valley at z = 400, a gully down its middle, a sample every 4 m.
const N = 129,
  cell = 4,
  origin: [number, number] = [-256, 0];
const face = (x: number, z: number) =>
  0.78 * Math.max(0, 400 - z) + 0.4 * Math.abs(x) * Math.min(1, Math.max(0, 400 - z) / 150);
const ground = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ground[j * N + i] = face(origin[0] + i * cell, origin[1] + j * cell);
engine
  .createMesh()
  .setGeometry(heightfield(face, { size: [(N - 1) * cell, (N - 1) * cell], origin, resolution: N - 1 }))
  .setMaterial(new PbrMaterial({ color: '#4a4038', roughness: 0.9 }));

const weather = new WeatherMachine('snow', { seed: 2 });
const slide = new Avalanche({
  width: N,
  depth: N,
  cellSize: cell,
  origin,
  ground,
  weather,
  cover: 1.2, // metres of snow on the face
  release: { at: [0, 60], size: [40, 25] }, // a slab 80 m across and 50 m down the slope
  releaseDepth: 1.2,
  releaseTime: 2, // film seconds
});
applyAvalancheSettings(slide, { ...AVALANCHE_LOOKS.dryPowder, releaseTime: 2, releaseDepth: 1.2 });
Snow.attach(engine, { field: slide });
const clouds = Clouds.attach(engine);
engine.onFrame((_, delta) => {
  slide.update(delta);
  slide.drawCloud(clouds);
});
slide.seek(12);
console.log(Math.max(...slide.flowSpeed()), slide.powderCloud().length, slide.budget()); // m/s, parcels, kg
// Plants bending along the flow now: pass these each frame to a TrampledScatter's setInteractors.
console.log(slide.plantPushers().length, slide.plantBend().length / 2); // pushers, samples
```

The rows are `AVALANCHE_SETTINGS` in `margoengine/weather/settings` (23 rows on the shared shape; `wind` and
`windDirection` null follow the weather and a value overrides it; `releaseDepth`, `step`, `density` and `coverDensity`
start it again), with the looks `weather`, `dryPowder`, `wetSlide` and `slowMotion`. `voellmySpeed(slope, h)` and
`voellmyRunout(speed, h)` are the analytic cases the solver is tested against (the steady speed to 3 percent).
`examples/test-pages/avalanche.html` is a whole mountain scene that checks the budget, a step against a seek and the
field Snow reads.

## Volcanic eruption columns

`Eruption` from `margoengine/weather/eruption` is an eruption column over film time with no physics engine. The vent
jets a hot mix of gas and ash; the dense gas-thrust region slows until the air it takes in and heats makes it lighter
than the air, then it rises as a buoyant plume (Morton, Taylor and Turner 1956; Woods 1988), bent over by the wind
(Woodhouse et al. 2013), to a height that follows Mastin et al.'s (2009) fit of real eruptions within its 50 percent
band. Too slow or gas-poor a jet collapses as a fountain (`column().collapse`). Its top rises over film time; at the
level of neutral buoyancy the umbrella cloud spreads as a gravity current (Woods and Kienle 1994; Suzuki and Koyaguchi
2009) and drifts with the wind; each grain size of the ash leaves the column where it can no longer be carried (Carey
and Sparks 1986), falls through the wind (Bonadonna et al. 1998, 2005) and lands, so `ashThickness`, `ashGrid` and
`visibility` grow downwind over time and `ashEvent()` hands the whole fall to `GroundChange` of
`margoengine/terrain/ground-change` as an ash cover. Lightning flashes in the plume and at the vent, more as it is
stronger; `flashLightning(sky)` fires each strike once through the sky's `Weather`, so its light, the cloud deck and
the thunder follow the sky's own lightning link. `drawPlume` puts the column and the umbrella into a `Clouds` of
`margoengine/vfx/clouds`. `seek` to any time gives the same eruption however it got there.

```ts
import { Engine } from 'margoengine/core';
import { Clouds } from 'margoengine/vfx/clouds';
import { WeatherMachine } from 'margoengine/weather';
import { Eruption } from 'margoengine/weather/eruption';
import { ERUPTION_LOOKS, applyEruptionSettings } from 'margoengine/weather/settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [-40000, 4000, -30000], target: [0, 9000, 0], near: 10, far: 300000 },
});
const weather = new WeatherMachine('clear', { seed: 3 });
const eruption = new Eruption({ vent: [0, 1500, 0], weather });
applyEruptionSettings(eruption, { ...ERUPTION_LOOKS.plinian, start: 2, wind: 12, windDirection: 60 });
const clouds = Clouds.attach(engine);
engine.onFrame((_, delta) => {
  eruption.update(delta);
  eruption.drawPlume(clouds);
});
eruption.seek(1800);
const column = eruption.column();
console.log(column.steadyTop, column.neutral, eruption.umbrella()?.radius); // metres above the vent
console.log(eruption.ashThickness(20000, 12000), eruption.ashEvent().thickness); // metres of fallen ash
// Ground: groundChange.add(eruption.ashEvent()). Sky: each frame, eruption.flashLightning(skyWeather).
```

The rows are `ERUPTION_SETTINGS` in `margoengine/weather/settings` (25 rows on the shared shape; `wind` and
`windDirection` null follow the weather and a value overrides it; `height` null takes `massRate`, a value takes
Mastin's rate for that height), with the looks `weather`, `plinian`, `weakPlume` and `strongPlume` (Costa et al.
2016's test eruptions), `collapsing` and `slowMotion`. `mastinRate(height)`, `mastinHeight(rate)`,
`standardAtmosphere(z)` (ICAO Doc 7488 and ISO 2533, re-exported from `@margoengine/math/atmosphere`, the one implementation the engine shares) and `ashFallSpeed(d, rho, air)` are exported too.

## Boundary-layer wind and turbulence (the physics framework's wind)

`BoundaryLayerWind` (`@margoengine/weather/boundary-layer`) gives the velocity in m/s, density in kg/m³ and
temperature in kelvin at a world-local position and time through `sample(x, y, z, t, out?)`.
Set `speed` at `referenceHeight` above `ground` (defaults 10 m/s at 10 m, ground 0 m), and `roughness` in metres
(default 0.0002 for open sea). The air is still at and below the roughness height. Set `obukhovLength` in metres
to a positive value for stable air or a negative value for unstable air. Positive infinity gives the neutral
log law and is the default. `direction` is radians toward the wind's destination. The default
`directionConvention: 'cartesian'` starts at +X toward +Z. Use `'heading'` for +Z toward +X.
The scalar source uses cell [0, 0, 0]. The standard atmosphere uses `altitude` above sea level (default 0 m) plus local
height, with `seaLevelTemperature` (default 288.15 K).

Mann's spectral box supplies gusts, with default along-wind standard deviation 2.5 times the friction
velocity. It travels at the mean speed of the sampled height. A one-cell taper at the roughness height and
the top makes the velocity continuous there and prevents vertical repetition. The horizontal axes still
tile. Set `turbulence: false` for just the mean. Pass `wind.profile` to the optional Physics
`BoundaryLayerSolver` to publish a native grid on the same world clock.

```ts
import {BoundaryLayerWind} from '@margoengine/weather/boundary-layer';

const wind = new BoundaryLayerWind({speed: 12, roughness: 0.0002, turbulence: {cells: [64, 16, 16], size: [1024, 256, 256]}});
const air = wind.sample(0, 30, 0, 5); // 30 m up, 5 s into the shot
console.log(wind.meanSpeed(30).toFixed(2), air.density.toFixed(3)); // 13.22 1.221
```

`new MannBox({cells, size, lengthScale, shear, sigma, seed})` synthesises the box synchronously. Its default box
uses 512 × 32 × 32 cells across 4,096 × 256 × 256 m. Each cell count is a product of 2, 3 and 5. The
`u`, `v` and `w` planes are its along-wind, across-wind and upward fluctuations. `sample(x, y, z)` reads
them trilinearly, repeating past the box edges. A box should span several length scales to resolve large
eddies. At 12 m/s the default repeats after 5.7 minutes.

Use `MannBox.create(options)` to load a Rust Wasm SIMD FFT on demand. It makes the same seeded tile and accepts
`threads` (1 by default, or 2–3 for separate component workers) and an optional `AbortSignal`. The returned
box exposes the executed transforms, complex values and SIMD twiddle products in `fftWork`.

`travellingGust(base, options)` places a one-cosine front on any `Wind` field. Give the leading-edge
`speed` (m/s), the full `length` (m), and the added peak velocity `amplitude` ([x, y, z], m/s).
`origin` defaults to [0, 0, 0] in the base field's starting cell, and the leading edge crosses it at
`start` (default 0 s). `direction` defaults to 0 radians (+x toward +z). Set `cellSize` to the physics
world's cell side (default 4,096 m). An optional `height: [bottom, top]`, in metres above the origin,
tapers the perturbation to zero at both vertical boundaries. The base field still supplies density and temperature.

```ts
import {BoundaryLayerWind} from '@margoengine/weather/boundary-layer';
import {MannBox, travellingGust} from '@margoengine/weather/turbulence';

const box = await MannBox.create({cells: [24, 12, 10], size: [192, 96, 80], threads: 2});
const wind = new BoundaryLayerWind({speed: 4, turbulence: box});
const gust = travellingGust(wind, {speed: 4, length: 8, amplitude: [6, 0, 0]});
const base = wind.sample(0, 2, 0, 1);
const crest = gust.sample(0, 2, 0, 1);
console.log((crest.velocity[0] - base.velocity[0]).toFixed(1)); // 6.0 m/s at the front's crest
```

## Rain, snow, graupel and hail (the physics framework's precipitation)

`PrecipitationField` (`@margoengine/weather/precipitation`) is the precipitation every solver of the physics framework reads: one `Precipitation` of `@margoengine/math/fields`, sampled at any point and time on the world clock with `sample(x, y, z, t, out?)`. It gives the total `rate` in mm/h of liquid water and, for each of `rain`, `snow`, `graupel` and `hail`, its own `rate`, its exponential size distribution N(D) = `intercept` exp(-`slope` D) (particles per m^3 per m of size), its mass-weighted `fallSpeed` relative to the air, the `impactRate` (particles per m^2 per s on level ground, for rings and splashes), the `energyFlux` it brings down (W/m^2) and its `waterContent` (kg/m^3), plus the `velocity` of the falling water over the ground. Fall speeds come from each particle's physics in the air at that height: a raindrop's from its weight against the drag of an oblate drop (Loftus and Wordsworth 2021), a snow aggregate's from the Best-number method of Heymsfield and Westbrook (2010), graupel's and hail's from Heymsfield and Wright (2014); raindrops follow Marshall and Palmer's sizes and carry exactly the rate asked for, and snow carries the mass and number of the drops it melts into. The share falling as snow follows the air temperature (half at 1.0 C, `snowTemperature`), so the snow line moves with the weather and with height. The rain is set at cloud base (`base`, default 1500 m above `ground`) as a `rate` everywhere (default 4 mm/h, moderate rain, when there are no cells) plus moving exponential `cells` (`centre`, e-folding `radius`, peak `rate`, `velocity`); each size reaches the point from a different distance and time upwind, carried by `wind` (any `Wind`, such as `BoundaryLayerWind`). Rain shafts spread and slant as those different arrival paths cross the layer. Use `cellSize` (default 4096 m) to match the physics world when sampling wind in a shifted origin cell. `source` adds rain made elsewhere, such as `CloudSolver.rainSource()` of `@margoengine/physics/clouds` (the clouds' rain at the ground; give `base` half a cloud cell then). `graupel` and `hail` take a `fraction` of the rate and an e-folding size `scale` (hail from 5 mm, density 900 kg/m^3 unless given). Air density and temperature come from the wind, or from the standard atmosphere at `altitude` plus the height without one.

```ts
import {BoundaryLayerWind} from '@margoengine/weather/boundary-layer';
import {PrecipitationField, rainFallSpeed} from '@margoengine/weather/precipitation';

const wind = new BoundaryLayerWind({speed: 12, turbulence: false});
const rain = new PrecipitationField({
  cells: [{centre: [0, 0], radius: 800, rate: 25, velocity: [6, 0]}],
  rate: 1,
  wind,
  seaLevelTemperature: 280,
});
const deck = rain.sample(1500, 2, 0, 60); // 2 m up, 1.5 km downwind, a minute in
console.log(deck.rate.toFixed(1), Math.round(deck.rain.impactRate)); // 6.0 3332 (mm/h, drops per m^2 per s)
console.log(deck.velocity.map((v) => v.toFixed(1))); // ['10.2', '-4.7', '0.0']: blown along x as it falls
console.log(rainFallSpeed(0.002).toFixed(2)); // 6.24 m/s for a 2 mm drop at sea level
```

`rainFallSpeed(d, air?)`, `snowFallSpeed`, `graupelFallSpeed` and `hailFallSpeed(d, air?, density?)` give one particle's terminal speed (size in m, `air` as `{density, temperature, gravity}`, default the sea-level standard atmosphere), `largestRaindrop(air?)` the largest stable drop (7.2 mm at sea level), and `snowFraction(T)` the share of snow at a temperature. Bulk moments use 64 quadrature sizes for each species. Variable source transport uses 192 midpoint rays per active species and reconstructs the local exponential from its arrived mass rate. Use a coarse grid for a map of the field. A failed source or wind sample leaves a supplied output at its last accepted value.

For individual rain trajectories, pass `rainSphere` to the optional falling solver. Diameter is the volume-equivalent size in metres and restitution defaults to zero. The solver uses the same liquid density and terminal speed as the field. It publishes accepted positions and sizes for rendering and contact coupling.

```ts
import { FallingSolver } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';
import { rainSphere } from '@margoengine/weather/precipitation';

using falling = await FallingSolver.load({ threads: 1 });
const world = new PhysicsWorld({ rate: { num: 240, den: 1 } });
world.add(falling, {
  bodies: [rainSphere({ diameter: 0.001, position: [0, 2, 0] }),
    rainSphere({ diameter: 0.004, position: [0.03, 2, 0] })],
});
world.advance(60);
console.log(falling.pose(0).velocity, falling.pose(1).velocity);
console.log(falling.readNativeWork());
```

## Explosion clouds (instantaneous releases)

`BlastCloud` from `margoengine/weather/eruption` is the mushroom cloud of one or more instantaneous releases (an
ammunition dump, a quarry blast, a buried charge) over film time. Each source is a buoyant thermal (Morton, Taylor and
Turner 1956): the heat it puts into the air makes a hot, light cloud that accelerates hard (its momentum is its own
small mass plus the air it pushes aside, Escudier and Maxworthy 1973; it entrains at (rho / rho_a)^(1/2) of the cool
rate, Ricou and Spalding 1961), then spreads as b = alpha z (Scorer 1957, alpha 0.25) and slows in the stable standard
atmosphere until it stops at a height that scales as B^(1/4) N^(-1/2), where its cap spreads sideways into an umbrella
(an intrusion, Benjamin 1968). Caps that overlap merge into one (Kaye and Linden 2004). The rise is held to measured
clouds: the Halifax cloud of 1917 (about 2.9 kt, peak measured at 3,600 m; the model gives 3,465 m) and the 1 Mt cloud
of Glasstone and Dolan's table 2.12 (the model 10 to 20 percent low in the first minute). The cap and stem are
cauliflower heaps of puffs at three scales (Bouthors and Neyret 2004), each puff coloured, with the fire glowing inside
the base of the cap and the stem while it burns. `draw(clouds, fire?)` lays every source's cap, stem and base surge in
one cloud of a `Clouds` from `margoengine/vfx/clouds`, so the cap shades its own underside and the stem; give that
Clouds `relief: 1` and a `density` near 0.35 so each puff shades as a rounded lobe. An optional second `Clouds`
(`shading: 'unlit'`, attached first) takes small fire puffs at the base. `thermals(t)` gives each cap's centre,
radius, spread, thickness, speed, buoyancy, density and merge. `seek` to any time gives the same cloud however it got
there.

```ts
import { Engine } from 'margoengine/core';
import { Clouds } from 'margoengine/vfx/clouds';
import { BlastCloud } from 'margoengine/weather/eruption';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [-2500, 40, -900], target: [0, 700, 0], near: 5, far: 200000 },
});
engine.scene.background = '#c9cbcc';
// Two releases 2 s apart, about 1,600 and 500 tonnes of TNT, thrown up at 45 and 35 m/s.
const blast = new BlastCloud({
  sources: [
    { at: 0, tnt: 1.6e6, speed: 45 },
    { at: 2, tnt: 5e5, position: [70, 0, 15], speed: 35 },
  ],
  wind: 4,
  windDirection: 60,
});
const fire = Clouds.attach(engine, { limit: 400, shading: 'unlit' });
const smoke = Clouds.attach(engine, { limit: 8000, relief: 1, lightDirection: [-0.3, 1, -0.2], ambient: 0.6, density: 0.35 });
engine.onFrame((_, delta) => {
  blast.update(delta);
  blast.draw(smoke, fire);
});
blast.seek(30);
const [first] = blast.thermals();
console.log(first.height, first.radius); // about 730 m up, a cap radius near 320 m
```

Options (every one optional): `sources` (1 to 8 of `{ at, position, tnt, radius, speed }`; `radius` defaults to
tnt^(1/3) m, `speed` to 0), `altitude` (0), `heatShare` (0.4 of the charge's energy heats the air), `entrainment`
(0.25), `addedMass` (0.5), `fireTemperature` (2,000 K, the hot start's temperature), `airTemperature` (288.15 K), `tropopause` (11,000 m), `stability` (null follows the ICAO
atmosphere; a value holds N^2), `wind` (0 m/s at 10 m) and `windDirection` (0 degrees, toward +Z), `horizon` (900 s
solved), `fireDuration` (4 s), `fireballTemperature` (3,000 K, the fireball's light at the release, 1,000 to
5,000), `fireGlow` (6, the glow's brightness at that temperature), `color` (soot grey-black [0.16, 0.16, 0.165]: TNT's
oxygen balance of -74 percent leaves free carbon), `stemColor` ([0.12, 0.117, 0.113]), `fireColor` (null: a
blackbody at each puff's temperature), `jets` (16 dark trails of thrown earth out of the fireball, 0 to 64) and
`jetLife` (6 s, 1 to 30), and `seed`. The fire's outline shrinks as it burns down and its temperature carries only
the rest of the power drop (power ~ area T^4), so a fresh fireball draws white-hot, far over display white.
`draw`'s third argument sets the puff counts (`cap` 2,040, `stem` 1,020, `fire` 60 per source); while the jets show
they take a quarter of the stem's puffs, so a draw never goes over its counts. The cap is laid as trees of 21 puffs
over three sizes on an even spiral over its face, each tree's first lobes in a ring, so the face is lobes all over.
The cloud's light is summed over every pair of puffs on the CPU, so 3,500 puffs cost about 0.1 s a frame. `airStability(z)` and
`thermalTop(B, N2)` are exported too.

## Lava flows, fountains and bombs

Use `LavaSurface` to draw a `LavaSolver` grid at the accepted physics time. It draws the wet or
solidified surface on the same terrain grid, with emission from skin temperature and reflected
basalt material from crust coverage. WebGPU and WebGL2 share the depth test and scene lighting.
`glow` defaults to one, and `name` defaults to `lava-surface`.

```ts
import { Engine } from '@margoengine/core';
import { LavaSolver } from '@margoengine/physics/lava';
import { PhysicsWorld } from '@margoengine/physics/world';
import { LavaSurface } from '@margoengine/weather/lava';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const lava = await LavaSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(lava, {
  cells: [16, 16],
  spacing: 0.5,
  bed: 0,
  vents: [{ cell: [8, 8], flow: 0.08, start: 0.5, end: 2 }],
});
LavaSurface.attach(engine, { source: () => lava.surfaceSource() });
world.advance(60);
```

`LavaFlow` from `margoengine/weather/lava` is lava from one vent over film time. The flow runs down your ground by the
path of steepest descent (Favalli et al. 2005, with a small jitter so it is not locked to a grid; it fills a shallow
hollow and spills over its rim) as a sheet with a yield strength: its thickness carries the supply and its speed
follows Jeffreys (1925) with Hulme's (1974) plug correction. Its core cools down the channel by radiation and
convection from a crust and a share of hot cracks (Harris and Rowland 2001; Crisp and Baloga 1990), gaining latent heat
as it crystallises, so it slows as its viscosity and yield strength rise (Dragoni 1989). The heat budget is FLOWGO's
(Harris and Rowland 2001): the crust covers 0.9 exp(-0.16 u) of a surface moving at u m/s (`crackSpeed`), the hottest
exposed lava is 120 K below the core (`hotOffset`), and the base conducts to the ground through a basal crust a tenth of
the sheet (`baseCrust`, `baseTemperature`). The sheet keeps its depth at the vent and widens as it slows (mass
conservation, Q = w d u), so it spreads where the slope breaks onto a flat, up to `maxWidth`. It stops:
`'cooled'` where its Graetz number u d_e^2 / (kappa x) falls to 300 (Pinkerton and Wilson 1994) or its core reaches the solidus,
`'ponded'` on flat ground (the pond then spreads as Huppert 1982, and `lavaEvent()` carries it to `GroundChange` as
a `pond` that keeps the volume the vent feeds past the end of the path), `'stalled'`, or at `maxLength`. The front advances
as the vent supplies it (`start`, `rise`, `duration`, `wane`) and stops when the supply is spent. Lengths fit mapped
flows within 2 times (the test): Mauna Loa 1984 at 400 m^3/s runs 27.5 km (mapped 25 to 27), Pu'u 'O'o 1997 at 30 m^3/s
3.5 km (4), Etna 1998 at 7 m^3/s 0.70 km (0.755), and Etna flows of 1 to 30 m^3/s grow as TADR^0.49 against Calvari and
Pinkerton's (1998) 10^3.11 TADR^0.47 m, at about 0.7 of it. After the vent stops, `coreTemperature(i, t)` cools the
stagnant sheet by conduction, its top at the air and its base at the lava-ground contact temperature (`slabCore`,
Carslaw and Jaeger 1959): a 2 m sheet's middle falls below the crust isotherm in about 10 days, and the cracks' glow
follows it.

Levees rise behind the front: the margins stop and cool, and a Bingham sheet holds still where it is thinner than
Hulme's (1974) h_c = tau / (rho g sin theta), so `leveeShare(i, t)` is h_c at the yield strength (Dragoni 1989) of the
margin's cooling crust over the sheet's thickness, up to `leveeMax` (0.35; never above 1, the sheet's own height). It
only grows with time and stands higher on gentle slopes. `lavaEvent(points, t)` carries the levees as they stand at `t`;
set the event again as film time runs to grow them.

The flow splits where the ground offers a second way down past a divide (Dietterich and Cashman 2014: flows part round
ground they cannot overtop, Favalli et al. 2005): a local maximum of the drop 45 degrees or more off the steepest, at
least `branchShare` (0.7) of it, with a drop under half its own between them, at most `maxBranches` (8) times and two
widths apart. The flux is shared by the drops (at one thickness the flux per width goes as the slope), so a branch is
thinner, cools sooner and runs shorter. Arms that part round an island run together again where the ground brings
them back (Dietterich and Cashman 2014 map channels that split and rejoin): an arm that comes within `joinDistance`
(1; 0 never) times their half-widths summed of another, after being clear of every other, ends there (`stop`
'joined', `joins` naming the arm and point), and the other is solved again from that point carrying both fluxes at
their flux-weighted temperature, so it runs on further. An arm that comes alongside another instead, moving within 45
degrees of its way with its top below the other's levee crest (`leveeMax` over that sheet), runs beside it, braided:
the levee between keeps them apart, so it never steps further over the other's edge than where it came alongside, and
each carries its own lava on. Two 12 m channels in troughs 11 m apart run 1.8 km side by side; with no levees
(`leveeMax` 0) the second ends in the first. `endFlux(k)` is the lava reaching an arm's end (its flux, less
its branches, plus what runs into it); over the arms not `joined` these always sum to the effusion rate. `branches()`
lists the arms (the trunk, `path()`, first), each with its parent, split point, flux, path, stop and join, and
`lavaEvents()` gives one ground event per arm.

On ground gentler than `tubeSlope` (4 degrees; 0 for none) a channel the vent still feeds `tubeTime` (a day) after
its front passed roofs over into a lava tube (Peterson et al. 1994): `roofTime(i)` and `tubed(i, t)` say when, the
hot cracks no longer show, and `coreTemperature(i, t)` is the tube's, `tubeTemperatures()`: inside, the lava loses
heat only by conduction, up through a roof as thick as the crust grown in `tubeTime` and down into the ground heated
for as long (Carslaw and Jaeger 1959). A Kupaianaha-like tube (4 m^3/s down 3 degrees, 4 m wide) cools 1.3 K/km
against 0.6 K/km measured by Helz et al. (2003) and about 1 K/km by Keszthelyi (1995); the same open channel cools
7 K/km.

A front that cools to a stop runs on once the tube behind it is roofed (Calvari and Pinkerton 1998: tube-fed flows on
Etna reached 3 km past the longest channel-fed one; Keszthelyi 1995): it waits at its stop until the last roof behind
it closes (`front()` says `cooled`, speed 0), then flows on with the tube's lava, `tubeTemperatures()` at the mouth,
its surface fresh and its Graetz length counted from the mouth, at most `maxRunOns` (16; 0 never) times. Each point's
`wait` (supply seconds the front waited behind it) and `opened` (when its lava came into the open) say where. 1 m^3/s
in a 4 m channel down 1 degree stops at 7.1 km in the open and runs to 35 km fed by its tubes.

A front that stalls while still fed can also break out (`breakoutHeight`, metres of inflation, 0 by default: off).
The supply spreads under the crust of the sluggish stretch behind the front (Graetz under twice `stopGraetz`) and lifts
it by Q t / area (Hon et al. 1994 measured pahoehoe sheets inflating by injection under their crust; Hoblitt et al.
2012); at that height the levee ruptures where the ground one width outside it lies lowest, through the roof where the
stretch has roofed, and all the lava leaves from there as a new arm (`breakout: true` in `branches()`), its surface
fresh and its core the fluid core fed under the crust: the channel's core at the head of the sluggish stretch, less only
what conducts through the crust grown since the front passed (as in a tube), not the stalled lava's. A tube that would
feed the front on sooner wins. The same 1 m^3/s flow with no tubes and 2 m of inflation breaks out 7.3 km down 32
hours after the vent opens at 1,273 K (the stalled lava there is 1,261 K), and a lobe runs 1.2 km beside it, against
the 0.7 to 0.8 km a breakout lobe of Kilauea's June 27th flow ran in January 2015 before it stalled (USGS HVO; Poland et
al. 2016).

With breakouts on, a stalled front also blocks the tube behind it. The supply backs up: the lava's level rises over
the front's top as the sluggish stretch lifts, filling the tube's head room (Kauahikaua et al. 1998), and the first
closed roof whose hold it beats bursts, the weight of a roof d thick plus its strength as a beam clamped at the levees,
rho g d + 2 `roofStrength` d^2 / w^2 (1 MPa by default). The lobe leaves with the tube's lava, far hotter than the
stalled front's. The 1 m^3/s flow with tubes and a levee that holds 20 m bursts a day-old roof 320 m behind its front
about 21 hours after it stalls, at 21 kPa over the roof, and a 6.4 km lobe runs from there. The ground draws the
roofs: `lavaEvent()` carries each point's `roofTime` as `roofs`, and GroundChange grows a crust in from the levees
over the channel from the front's arrival until it closes level with their crests, with no glow under it. Skylights,
holes where the roof fell in or never closed (Kauahikaua et al. 1998), open about every `skylightSpacing` (200 m; 0
for none) and show the stream fresh until the tube drains: `drains` gives the second the supply's end passes each
point, after which the stream under a skylight crusts like open lava.

```js
import { LavaFlow } from 'margoengine/weather/lava';

const lava = new LavaFlow({ vent: [0, 1000, 0], ground: (x, z) => 1000 - 0.0175 * z, effusionRate: 1, width: 4, maxWidth: 4, duration: 1e7, step: 10 });
const mouth = lava.path().findIndex((p, i) => i > 0 && p.wait > lava.path()[i - 1].wait);
console.log(lava.length, lava.arrival(mouth) / 86400); // tube-fed length, metres; the day the front starts again
```

The surface's crust is solved by conduction under a radiating, convecting surface with the latent heat released to the
solidus: `crustThickness(age)` stays within 30 percent of Hon et al.'s (1994) 0.0779 sqrt(hours) metres and
`surfaceTemperature(age)` falls below 1,150 K in a minute. `radiance(i)` is the glow of each path point (hot cracks at
the core's temperature plus the crust at its own, through Planck's law and the CIE observer), `lavaGlow(kelvin)` the
colour and luminance of any temperature. `lavaEvent()` hands the flow to `GroundChange` of
`margoengine/terrain/ground-change` as a lava event with its path, arrival times, widths, thicknesses and glow, so the
ground draws the sheet, its levees and its glowing cracks growing down the slope. A fountain throws clots up to
`fountainHeight` (Wilson and Head 1981) and bursts throw bombs on drag-slowed ballistic paths through the ICAO air
(Mastin 2001); `clots()`, `bombs()`, `drawClots(instances)` and `drawBombs(instances)` give or draw them, and
`impacts(from, to)` or `takeImpacts()` give each landing for dust and sound. `glowLights()` turns the glow into point
lights over the fountain and along the flow, which `update` writes into `lights` (a `LightGroup` of
`margoengine/clustered/groups`), so the lava lights the ground at night. `seek` to any time gives the same lava however
it got there.

```ts
import { Engine, PbrMaterial } from 'margoengine/core';
import { Clustered } from 'margoengine/clustered';
import { LightGroups } from 'margoengine/clustered/groups';
import { sphereGeometry } from 'margoengine/geometry';
import { toGeometry } from 'margoengine/geometry/utils';
import { Material, createInstancedMesh } from 'margoengine/materials';
import { heightfieldGeometry } from 'margoengine/terrain';
import { GroundChange } from 'margoengine/terrain/ground-change';
import { WeatherMachine } from 'margoengine/weather';
import { LavaFlow } from 'margoengine/weather/lava';
import { LAVA_LOOKS, applyLavaSettings } from 'margoengine/weather/lava-settings';

const engine = await Engine.create(document.querySelector('canvas')!, {
  camera: { position: [0, 160, -300], target: [0, 40, 150], near: 1, far: 5000 },
});
const ground = (x: number, z: number) => 100 - 0.12 * z + 3 * Math.sin(x * 0.03);
const grid = { size: [600, 600] as [number, number], origin: [-300, -300] as [number, number], resolution: 300 };
const mesh = engine.createMesh().setGeometry(toGeometry(heightfieldGeometry(ground, grid)));
mesh.setMaterial(new PbrMaterial({ color: '#3a3634', roughness: 0.95 }));
const lights = LightGroups.attach(engine, Clustered.attach(engine));
const weather = new WeatherMachine('clear', { seed: 3 });
const lava = new LavaFlow({ vent: [0, ground(0, -250), -250], ground, weather, lights: lights.group('lava') });
applyLavaSettings(lava, { ...LAVA_LOOKS.strombolian, start: 1, effusionRate: 30 });
const change = GroundChange.attach(engine, mesh, { grid, events: [lava.lavaEvent()] });
const blobs = createInstancedMesh(engine, sphereGeometry(1, 12, 8), new Material({ shading: 'basic' }), 4000);
engine.onFrame((_, delta) => {
  lava.update(delta);
  change.setTime(lava.time);
  lava.drawBombs(blobs.instances);
});
lava.seek(600);
console.log(lava.front().distance, lava.stop, lava.crustThickness(3600)); // metres, why it stops, metres of crust
console.log(lava.takeImpacts().length, lava.glowLights().length); // bombs landed so far, glow lights
```

Set the event again after changing a flow or supply row (`change.clear(); change.add(lava.lavaEvent())`; for a flow
that splits, `change.clear(); for (const e of lava.lavaEvents()) change.add(e)`). The rows are
`LAVA_SETTINGS` in `margoengine/weather/lava-settings` (59 rows on the shared shape, every one live; `wind` and
`windDirection` null follow the weather and a value overrides it), with the looks `weather`, `hawaiian`,
`strombolian`, `aa`, `vulcanian` and `night`. `binghamSpeed`, `binghamThickness`, `pondRadius`, `airDensity`,
`planck`, `lavaGlow` and `SUN_LUMINANCE` are exported too. After the ground under the same `ground` object changes
(sculpted or streamed terrain), call `invalidate()`.
`examples/test-pages/lava.html` is a whole flow at night that checks a step against a seek (front and ground events),
the arms' fluxes, the levee cap and the tube against the open channel.

## Drive Sky from a synoptic simulation

`synopticDrive` samples the regional atmosphere at the camera, including the actual cloud water and surface
precipitation. Advance the physics world on the film clock. WeatherDrive uses the sampled state without advancing
its own preset machine.

Pass finite positive droplet radii and moisture scale heights in metres. Invalid values produce a
remedy at [synoptic errors](https://margoengine.com/errors#synoptic).

```ts
import { Engine } from '@margoengine/core';
import { SynopticWeather } from '@margoengine/physics/synoptic';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Sky } from '@margoengine/sky';
import { Weather } from '@margoengine/sky/weather';
import { WeatherDrive } from '@margoengine/weather/drive';
import { synopticDrive } from '@margoengine/weather/synoptic';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const solver = await SynopticWeather.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, { cloud: 0.015, hydrometeors: 0.4 });
const sky = Sky.attach(engine, { hours: 13 });
const precipitation = Weather.attach(engine, { fadeSeconds: 0 });
WeatherDrive.attach(engine, {
  weather: synopticDrive(solver, () => [0, 20, 0]),
  sky,
  precipitation,
  advance: false,
});
world.advance(60);
engine.render({ delta: 1 / 60 });
```

Return the camera position relative to the synoptic solver's cell. The adapter defaults to a 10 μm cloud droplet
radius and a 2400 m moisture scale height for display opacity and humidity. It uses the existing rain-to-snow phase
transition. For exact precipitation rates and flow in physics, use `solver.rainSource()` and `solver.wind` directly.

## Weather in different places

`WeatherRegions` from `margoengine/weather/regions` gives a map weather that differs from place to place: a `base`
weather, `fronts` that sweep across it and leave other weather behind, and `cells` (a storm, a fog bank, a snow squall)
that drift. It is a pure function of place and time, so every player sees the same weather and a replay repeats it.

```ts
import { WeatherMachine } from 'margoengine/weather';
import { WeatherRegions } from 'margoengine/weather/regions';

const map = new WeatherRegions({
  base: 'partlyCloudy',
  // A cold front 5 km to the west, moving east at 8 m/s: rain behind it, a squall on it.
  fronts: [{ origin: [-5000, 0], direction: Math.PI / 2, speed: 8, width: 2000, behind: 'rain', along: 'thunderstorm' }],
  // A fog bank drifting north at 1 m/s.
  cells: [{ center: [800, 300], radius: 400, weather: 'fog', velocity: [0, -1] }],
});
const camera = new WeatherMachine('clear');
map.update(60); // a minute on
map.apply(camera, 0, 0); // the weather where the camera stands, with its ground wetness and wind
console.log(map.arrival(map.fronts[0], 0, 0), 's until the front arrives');
```

A front is the line through `origin` at time 0 moving toward `direction` (radians, 0 toward +Z and pi/2 toward +X, as
`windDirection`) at `speed` (8 m/s); weather changes across `width` (2,000 m), from `ahead` (default the weather beneath)
to `behind`, with `along` on the line if given. A cell is whole within `radius` and fades over `falloff` (default the
radius) outside it, moves at `velocity` (`[x, z]` m/s) and, with `life: [from, to]`, grows in and dies out over a tenth
of that span at each end. Fronts apply in order over the base and cells over the fronts. `stateAt(x, z, t)` samples
any place and time; `apply(machine, x, z)` sets a machine there (call it every frame before `machine.update`) so its
wind, ground wetness and snow follow the place; `arrival(front, x, z)` gives the seconds until a front arrives
(negative once it has passed). `storms` (or `addStorm`) lays storms whose weather varies across them over the cells:
anything with `weatherAt(x, z, t)` returning a partial state and its `weight` there (0 to 1), such as `Hurricane` from
`@margoengine/sky/hurricane`, whose wind, gusts, rain, cloud and lightning follow its calm eye, its eyewall and its
spiral bands, or `Tornado` from `@margoengine/sky/tornado`, whose turning wind, inflow and rear-flank rain follow
the vortex along its path (the sky package's README has both models and their sources). A storm wind over 60 m/s counts as 60, and
fields left out keep the weather beneath. `addFront`, `addCell` and `addStorm` return removers. A partial `behind`, `ahead`, `along` or cell `weather` takes its missing fields from the map's base, and setting `map.base` fills them again from the new one. Bad input throws `TypeError` or `RangeError`.

## Weather you can hear

`WeatherAudio` from `margoengine/weather/audio` plays rain, wind and thunder through `@margoengine/audio`, following a
weather state. Rain and wind are looping noise that it generates itself, so it needs no sound files; thunder is one
rumble per strike, as loud and as long as the strike, for example from the sky `Weather`'s `onThunder`.

```ts
import { AudioListener } from 'margoengine/audio';
import { WeatherMachine } from 'margoengine/weather';
import { WeatherAudio } from 'margoengine/weather/audio';
import { Engine } from 'margoengine/core';
import { Weather } from 'margoengine/sky/weather';

const engine = await Engine.create(document.querySelector('canvas')!);
const listener = AudioListener.attach(engine); // resumes on the first click or key press
const weather = new WeatherMachine('thunderstorm');
const sky = Weather.attach(engine, { lightning: {} });
const sounds = WeatherAudio.attach(engine, listener, { weather, volume: 0.8 }); // follows the weather every frame
engine.onFrame((_, delta) => weather.update(delta));
sky.onThunder((strike) => sounds.thunder(strike)); // a rumble when the thunder arrives
```

The rain's volume is `rain` (0.6) times the rain to the power 0.7, hail adding half its share, through a low-pass that
opens from 2.5 to 8 kHz with the hail; the wind's is `wind` (0.5) times (speed / 25) to the power 1.5, gusts lifting it
by up to a third, through a band-pass that rises from 250 Hz by 30 Hz per m/s; `volume` (1) scales everything and
`thunder` (1) a strike at loudness 1. `rainSound` and `windSound` are the `Audio` objects, for routing further.
`buffers: {rain, wind, thunder}` plays your own recordings instead (a thunder recording is played faster or slower to
fit the strike's length). `weatherAudioMix(state)` gives the levels alone and `weatherNoise(rate, seed)` the generated samples; every seed (0 included) gives its own rain, wind and thunder, and no two seeds share a sound's noise.
`new WeatherAudio(listener, options)` and `update()` work without an engine; `dispose()` stops everything and removes attached sounds from their scene.

## Real weather: METAR reports

`margoengine/weather/data` reads METAR and SPECI reports, the aerodrome weather observations that every airport
publishes every half hour, and turns one into a weather state, so a visualisation or a flight simulator can show the
weather that is really there. It follows the code form of WMO-No. 306 (FM 15 and FM 16) and ICAO Annex 3, and the
United States variant (statute miles, inches of mercury, `CLR`, remarks).

```ts
import { WeatherMachine } from 'margoengine/weather';
import { parseMetar, metarState } from 'margoengine/weather/data';

const report = parseMetar('METAR EGLL 071150Z 24015G27KT 4000 -SHRA BKN014 SCT025CB 12/09 Q1003 NOSIG');
console.log(report.wind, report.visibility, report.clouds, report.temperature, report.pressure);
const weather = new WeatherMachine('clear');
weather.transitionTo(metarState(report), { seconds: 60 }); // blend into what the airport reports
```

`parseMetar(text)` returns the station, day and UTC time, `auto` and `corrected`, the wind (the direction it blows
from in degrees, speed and gusts in m/s, the variable sector; a speed written with P, such as `P99KT` for 100 kt or more,
reads as its least value, 100 kt), the visibility in metres (`10000` for 10 km or more,
`CAVOK` included), present weather groups (intensity, descriptor, phenomena), cloud layers (cover and base in metres,
CB or TCU), vertical visibility, temperature and dew point in degrees Celsius, pressure in hectopascals (from QNH or
the altimeter setting), recent weather, the trend and the remarks as written. A group it does not know goes to
`unknown` rather than throwing; a text with no station and time throws `SyntaxError`.

`metarState(report, {north})` maps it: rain, snow and hail 0.3, 0.6 and 0.95 for light, moderate and heavy (drizzle,
snow grains and small hail at half, ice pellets as half rain and half snow); lightning 0.6 for a thunderstorm, 0.9
heavy, 0.3 in the vicinity; cloud the greatest layer's oktas over 8 (FEW 1.5, SCT 3.5, BKN 6, OVC 8, a full sky under
vertical visibility); wind the mean, gust the gust's excess over the mean, and the direction it blows toward with north
at -Z (`north` turns it for a world laid out otherwise); fog from the visibility by Koschmieder's law (extinction 3 /
visibility, the 5 percent contrast that defines visibility), so `fogDensity` of the state gives that extinction back.
`weatherFromMetar(text)` does both in one call.

## Driving the sky

`skyWeather(state, wind?)` returns the sky `Weather` settings for a state: `Object.assign(weather.options, skyWeather(state))`. It includes `rainRate` (mm/h, from `rainRate(state)`), from which the sky draws the rain's drop size and fall speed (Gunn and Kinzer 1949; Marshall and Palmer 1948), so a storm's rain falls faster and leans more in the same wind than a drizzle. `hailSettings` does the same for `Hail`. `fogDensity(state)` gives an exponential-fog density per metre (0.0002 clear to 0.02 thick).

### Clouds and fog from the state, automatically

Give the drive nothing but the weather and it finds its targets among the scene's plugins by name and shape: the sky
(`sky`), the cloud layer (`sky:volumetric-clouds`), the fog volume (`volumetric-fog`), the rain and snow (`weather`) and
`hail`, and every sea (`water:N`, a `Water` built without `waves`: with or without a `wind` option) to which it gives `setWind` the state's mean wind when it changes; a sea that also has `setRainRate` (a `Flood` from `@margoengine/water/flood`) is given the state's rain rate in mm/h when that changes, unless its rain was set by hand (`holdFromWeather(flood, 'rain')`). A target you hand in wins, and `auto: false` turns the search off. A cloud layer that draws a storm (a `hurricane` option, or `type: 'hurricane'`)
gets the weather only: its cover, density and turning cloud are the storm's, so the drive takes back the coverage,
density and drift it wrote there (a value held by hand stays).

```ts
import { WeatherMachine, beaufort, rainRate, visibility } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { Engine } from 'margoengine/core';
import { Sky } from 'margoengine/sky';
import { VolumetricClouds } from 'margoengine/sky/volumetric-clouds';
import { Weather } from 'margoengine/sky/weather';

const engine = await Engine.create(document.querySelector('canvas')!);
const sky = Sky.attach(engine, { hours: 15 });
VolumetricClouds.attach(engine, { sky });
Weather.attach(engine);
const weather = new WeatherMachine('storm');
WeatherDrive.attach(engine, { weather }); // the whole wiring: sky, clouds and rain follow the storm
const { wind, rain, fog, snow } = weather.state;
console.log(beaufort(wind), rainRate({ rain }), visibility({ fog, rain, snow })); // force, mm/h, metres
```

One physics for every package: `beaufort(U)` is the Beaufort force of a wind speed (WMO table), `windProfile(U10, z)` the
wind at height z, `rainRate(state)` the rain rate in mm/h (80 rain^3: drizzle 0.6, rain 17, storm 69) and
`visibility(state)` the metres at which a black object keeps 2 percent contrast (Koschmieder: 3.912 over the air's
extinction): 23 km in clear air, about 200 m at fog 1, 1.3 km in 25 mm/h rain (Marshall and Palmer 1948), 350 m in heavy
snow (Federal Meteorological Handbook No. 1). Sources: Koschmieder 1924 and WMO-No. 8; Hsu, Meindl and Gilhousen 1994
(doi:10.1175/1520-0450(1994)033<0757:DTPLWP>2.0.CO;2) for the 1/7 profile.

`WeatherDrive` from `margoengine/weather/drive` does that wiring for you every frame: it steps the weather and writes
its cloud and fog into the sky's cloud sheet and fog, `VolumetricClouds` layers, `@margoengine/environment`'s `Fog` and
`VolumetricFog`, and its rain, snow and hail into the sky's `Weather` and `Hail`. Give it only the targets you have.

```ts
import { WeatherMachine } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { Engine } from 'margoengine/core';
import { Sky } from 'margoengine/sky';
import { VolumetricClouds } from 'margoengine/sky/volumetric-clouds';
import { Fog } from 'margoengine/environment';

const engine = await Engine.create(document.querySelector('canvas')!);
const weather = new WeatherMachine('partlyCloudy');
// Attach the drive first, so the targets draw this frame's numbers.
const drive = WeatherDrive.attach(engine, { weather });
const sky = Sky.attach(engine, { hours: 15, clouds: { coverage: 0.45 } });
drive.options.sky = sky;
drive.options.clouds = VolumetricClouds.attach(engine, { sky });
drive.options.fog = Fog.attach(engine, { color: '#c0c4c8' });
weather.transitionTo('storm', { seconds: 120 }); // clouds close in and the fog thickens on their own
```

Cloud cover is the state's `cloud`; a cloud layer's density rises from 0.02 to 0.08 per metre with the strongest of
rain, snow, hail and lightning, and it drifts with the wind field's own direction at the wind of its base height, the
1/7 power law U10 (z / 10)^(1/7) (`windProfile`): 2.05 times the ground wind at 1,500 m (`windAloft` gives a plain factor
over the ground wind instead). Fog: an exponential fog and a fog
volume get `fogDensity` as their extinction; a squared fog (environment `Fog`, the sky's default fog) gets that over
the square root of 3, which leaves the same 5 percent of contrast at the same distance. A sky's cloud sheet and fog are
set only when the sky has them. The wind for rain and hail is the machine's wind field at `listener.position` (or
`position`). With `advance: false` you step the weather yourself. `driveSettings(state)` gives the numbers alone.

Fog volumes given as `fogWind` get that wind too, as `[x, 0, z]`, so their noise streams past with the gusts: blowing
snow in a blizzard, mist driven across a moor. A volume in `fogWind` but not in `fogVolumes` keeps the density the
scene gives it (thicker than the drive's 196 m for a whiteout, say); a volume in neither keeps its own `wind`.

```ts
import { WeatherMachine } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { Engine } from 'margoengine/core';
import { Weather } from 'margoengine/sky/weather';
import { VolumetricFog } from 'margoengine/environment/volumetric';

const engine = await Engine.create(document.querySelector('canvas')!);
const weather = new WeatherMachine('blizzard');
WeatherDrive.attach(engine, {
  weather,
  precipitation: Weather.attach(engine, { precipitation: 'snow' }),
  fogWind: VolumetricFog.attach(engine, { density: 0.04, height: 1, heightFalloff: 0.1, noise: 0.6 }),
  listener: engine.camera,
});
```

Scatter and grass bend with the same wind. `scatter` (every `Scatter`, found by its `scatter:N` name, built with a `wind` option or not: a scatter doubles its culling reach while any wind is set) gets `scatterWind(wind)`: the direction the wind blows toward, `windBend(U)` = (U / 20)^2, at most 1, as the strength, because the force of the air on a blade grows with the square of its speed, and the speed U itself (at most 100 m/s), from which the scatter runs its sway `U / 5.4` times as fast past Beaufort 3, so grass and trees thrash in a gale (`windClockRate` of `@margoengine/scatter`). A creative `GrassField` (`grass-field:N`) gets `grassWind(wind)`: its `windDirection`, a `windStrength` of twice that bend (0 to 2) and a `windSpeed` of 0.15 per m/s. The direction stays within 5 degrees of the field's; dead calm keeps the last direction at strength 0. Without a wind field the drive leaves them alone.

Particle effects lean with it too: every `VFX` (`vfx:N`, which includes the flames, embers and steam of a `Fire`) gets the field's `[x, z]` as its `wind` option, so smoke rising at w in a wind U leans atan(U / w) (`vfx` hands targets in; `auto: false` leaves them alone). An effect given a wind of its own (anything but unset or `[0, 0]` that the drive did not write, such as the `wind.x` and `wind.z` rows of `@margoengine/vfx/settings`) keeps it: a value overrides the weather.

The weather is the master of every target, and a value set by hand is an override. The settings appliers (`applyEnvironmentSettings`, `applyVfxSettings`, `applySmokeSettings`, `applySandSettings`, `applyWaterSettings`) mark each option they set with `holdFromWeather` (`packages/shared/settings.js`), and the drive never writes a marked option (sky and cloud numbers, fog density and colour, fog volume wind, scatter and grass wind, rain, hail, sea wind, blown-sand wind and fog); null in the row releases it and the weather writes it again on the next frame. A fog volume built with a `visibility` is left alone. To override a target of your own, call `holdFromWeather(target, 'density')`, and `holdFromWeather(target, 'density', false)` to hand it back.

```ts
import { scatterWind, grassWind, windBend } from 'margoengine/weather';
console.log(windBend(10), windBend(5)); // 0.25 and 0.0625: twice the wind, four times the bend
console.log(scatterWind([3, 4])); // [0.6, 0.8, 0.0625, 5]
console.log(grassWind([0, 10])); // { windDirection: [0, 1], windStrength: 0.5, windSpeed: 1.5 }
```

## Hail

`Hail.attach(engine, options)` (from `margoengine/weather/hail`, WebGPU only) draws stones that fall at `fallSpeed` (default 18 m/s), hit the ground at `groundY`, bounce twice (`restitution` 0.2) and stop. Every position is a closed-form function of time and the stone's index, so only one uniform block is uploaded per frame; stones are depth-tested against the scene and fade at the edge of the box that follows the camera. Options: `intensity`, `fadeSeconds`, `wind`, `groundY`, `radius`, `height`, `particles` (6,000 at intensity 1), `fallSpeed`, `restitution`, `stoneRadius`, `color`, `brightness`, `opacity`, `seed`, `lit` and `splashes`; all are read each frame from `hail.options` and validated.

Stones are lit (`lit`, default true) as small ice balls by the engine's light (`engine.lighting`: the sun's direction, strength and colour, and the ambient light): Lambert diffuse on the side toward the sun, a glint of it, and the far side in the stone's own shadow, lit only by the ambient; `lit: false` keeps the flat `color`. Where a stone first lands, `splashes` ice chips (4, at most 8) burst out at 0.6 to 1.8 m/s and 1 to 2.5 m/s upward and fall back under gravity, fading over `SPLASH_SECONDS` (0.35 s); like the stones they are a closed-form function of time, drawn in the same instanced draw. `stoneState(tau, options)` is the same height and speed formula in JavaScript. Without an engine, `new Hail(options)` and `update(delta)` still ease `amount`.

### Hail from a physics world

Set `Hail`'s `source` to draw world-stepped stones. `hailSphere` supplies the measured size-dependent
fall law for the local air. Add the scene's fixed colliders to the same coordinate frame as the
solver, then use `fallingBoundaryFromPhysics` to make the stones sweep and rebound off that geometry.
`hailFromFalling` supplies the positions, velocities and actual radii to the WebGPU draw. The world
owns the time, so seeking restores the stones. The world-stepped path draws a fixed batch without
camera-centred recycling or procedural splash chips.

```js
import { Physics } from '@margoengine/physics';
import { FallingSolver, fallingBoundaryFromPhysics } from '@margoengine/physics/falling';
import { PhysicsWorld } from '@margoengine/physics/world';
import { Hail } from '@margoengine/weather/hail';
import { hailFromFalling, hailSphere } from '@margoengine/weather/hail-physics';

await Physics.load();
using scene = new Physics(null);
scene.addBody(null, {
  type: 'fixed', position: [0, 0.5, 0],
  colliders: { shape: 'box', halfExtents: [1, 0.5, 1] },
});
const falling = await FallingSolver.load();
const world = new PhysicsWorld({ rate: { num: 60, den: 1 } });
world.add(falling, {
  bodies: [
    hailSphere({ diameter: 0.012, position: [-0.2, 3, 0] }),
    hailSphere({ diameter: 0.046, position: [0.2, 3, 0] }),
  ],
  boundary: fallingBoundaryFromPhysics(scene),
});
const source = hailFromFalling(falling);
using hail = new Hail({ source, intensity: 1, fadeSeconds: 0 });
world.advance(60);
hail.update(0);
console.log(hail.count, falling.pose(0).position);
```

On a WebGPU engine, use `Hail.attach(engine, { source })` with that source. Advance the world to the
desired film frame before rendering.

## Rain on the lens

`LensDrops.attach(engine, options)` (from `margoengine/weather/lens`, WebGPU or the WebGL2 compatibility layer, needs `@margoengine/post`) refracts drops and downward streaks over the finished picture as a stage of the scene's `PostStack`. A scene that already has a `PostStack` (bloom, water, a camera effect) gets the lens as one more HDR stage, after its last HDR effect; a scene without one gets a stack that goes when the lens does. `lens.dispose()` takes the lens out of the stack. Options: `wetness` (0 to 1, default 0.6), `radius`, `speed`, `distortion`, `streaks`, `seed`, `enabled` and `time`. On a `TransparentCanvas` a drop's glint over an empty pixel covers it by the light it adds.

```ts
import { Engine } from 'margoengine/core';
import { PostStack } from 'margoengine/post/stack';
import { Bloom } from 'margoengine/post/bloom';
import { LensDrops } from 'margoengine/weather/lens';

const engine = await Engine.create(document.querySelector('canvas')!);
PostStack.attach(engine, [new Bloom()]); // the scene already has a stack
const lens = await LensDrops.attach(engine, { wetness: 0.8 }); // joins it
lens.dispose(); // leaves it; the bloom stays
```

## Film time: seeking weather to a cut

A film rendered scene by scene starts each scene in a fresh process, and every weather clock adds up frame deltas: the
machine's blend, schedule, random walk, wetness and snow cover (`WeatherMachine`), the hail clock and amount (`Hail`),
the rain rings (`Puddles`, `GLTFWeather`), the lens drops (`LensDrops`) and the map time of `WeatherRegions`. Each has
`advanceTime(delta)`, the CPU part of its frame update, and a `time` getter (seconds on its clock); its `onPreUpdate`
(or `update`) runs the same steps. `WeatherDrive.advanceTime` steps its weather with `advanceTime` and writes the same
targets, so `seek` from `@margoengine/cutscene/seek` replays a run's steps and the next frame draws what a run started at
0 draws there, bit for bit (`tests/seek.test.js` field for field to 54,000 steps; `tests/seek-check.mjs` pixel for pixel
on WebGPU and the WebGL2 compatibility layer).

```ts
import { Engine } from 'margoengine/core';
import { WeatherMachine } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { Hail } from 'margoengine/weather/hail';
import { Puddles } from 'margoengine/weather/puddles';
import { Weather } from 'margoengine/sky/weather';
import { seek } from 'margoengine/cutscene/seek';

const engine = await Engine.create(document.querySelector('canvas')!, { backend: 'webgpu' });
const weather = new WeatherMachine('overcast', { seed: 7 });
weather.schedule([{ to: 'thunderstorm', seconds: 60, hold: 120 }, { to: 'hail', seconds: 20, hold: 30 }]);
// The drive first: a seek replays plugins in attach order, as the engine updates them.
const drive = WeatherDrive.attach(engine, { weather, listener: engine.camera });
drive.options.precipitation = Weather.attach(engine);
drive.options.hail = Hail.attach(engine);
Puddles.attach(engine, { weather });
// This scene starts 95 s into the film: the storm, the wet ground, the stones and the rings are where a run from 0 had them.
const { unseekable } = await seek(engine, 95, { fps: 30 });
engine.render({ delta: 1 / 30 });
console.log(weather.time, weather.wetness, unseekable);
```

- A replayed step calls no `on` listener: the live frame after the seek hears what the continuous run heard on that
  frame. A listener that changes the weather (`set`, `stop`) is not replayed; put such changes in the schedule, or make
  them from film code on the same step.
- `WeatherDrive.time` is its weather's `time`. A machine stepped by a drive needs nothing more; a machine you step
  yourself and `WeatherRegions` are not plugins, so pass them to `seek` in `extra`.
- `LensDrops` replays its own clock; an `options.time` you set still wins. `GLTFWeather` snow has no clock (it follows
  its weather).
- `WeatherAudio` and `PrecipitationCover` have no clock: the sound follows the state, and the cover map is drawn from
  the scene each frame. They show in the seek's `unseekable` list and need nothing.
- The events `Avalanche`, `SnowDrift` and `Eruption` are stepped by your frame code, not by the engine, so pass them
  to `seek` in `extra`: each has `advanceTime(delta)`, the same as its `update(delta)` (an eruption's `timeScale`
  included), and a `time` getter. The seek makes the same calls a continuous run made, so the slab, the drifts and the
  column at the cut equal that run's bit for bit (`tests/seek-events.test.js`, 1, 600 and 5,400 steps).

```ts
import { Eruption } from 'margoengine/weather/eruption';
import { SnowDrift } from 'margoengine/weather/snow-drift';
import { seekSync } from 'margoengine/cutscene/seek';

const world = { scene: { plugins: new Map() } }; // or your engine: its plugins step first, then `extra`
const eruption = new Eruption({ rise: 1, wind: 8, timeScale: 10 });
const ground = new Float32Array(32 * 32);
const drift = new SnowDrift({ width: 32, depth: 32, ground, initialDepth: 0.3, wind: 14, snowfall: 2, timeScale: 60 });
// This scene starts 40 s into the film: the column and the drifts are where a run from 0 had them.
seekSync(world, 40, { fps: 30, extra: [eruption, drift] });
console.log(eruption.time, drift.simulated); // about 400 film seconds of eruption and 2,400 simulated seconds of snow
```

Several cuts in one process: `resetTime()` puts each weather clock back as a fresh one with the same options has it
(`resetClocks` from `@margoengine/cutscene/seek` calls it on the engine's clocks and on `extra`), so a later `seek`
gives what a fresh world seeked there gives (`tests/reset-time.test.js`: each clock, and a whole weather world run,
reset and seeked against a fresh one, field for field).

- `Hail`, `LensDrops`, `Puddles`, `GLTFWeather` and `WeatherRegions` put their clocks (and the hail's faded-in amount)
  back to 0; fronts, cells and storms stay.
- `WeatherMachine` goes back to where it stood when time first moved: its state, its blend, its schedule or random
  walk (the walk's seed at its start) and its wetness and snow cover. Calls made after time moved (`set`,
  `transitionTo`, `schedule`, `randomWalk`, `stop`) are dropped, as a fresh machine set up the same way never saw them:
  make them again from film code. No listener is called; listeners stay.
- `WeatherDrive` resets the weather it steps (with `advance`, the default) and starts its fuel moisture again.
- `Eruption` and `LavaFlow` go back to film second 0 and give their lightning and bomb impacts again from the start.
  `Avalanche` and `SnowDrift` run their `reset()`, and their `version` grows so the views upload the snow; an
  avalanche reads the snow of its `snow` source as it stands then, so reset that first (`resetClocks` takes `extra` in
  the order given).

```ts
import { Eruption } from 'margoengine/weather/eruption';
import { resetClocks, seekSync } from 'margoengine/cutscene/seek';

const world = { scene: { plugins: new Map() } };
const eruption = new Eruption({ rise: 1, wind: 8, timeScale: 10 });
seekSync(world, 40, { fps: 30, extra: [eruption] });
// The next cut starts 90 s into the film: back to 0, then seek.
resetClocks(world, { extra: [eruption] });
seekSync(world, 90, { fps: 30, extra: [eruption] });
console.log(eruption.time); // about 900 film seconds
```

## One panel for the whole weather: settings

`@margoengine/weather/settings` lists the weather's master controls as one table for sliders and tools: wind speed
(m/s, with its Beaufort force in `about`), wind direction, gust, rain rate (mm/h), snow, hail, visibility (m), fog, cloud
cover, lightning, dust and a storm level. `WEATHER_SETTINGS` has 13 rows, each with `name`, `group`, `kind`, `default`, `min`,
`max`, `step`, `unit`, `about` and `live`; the row shape is the one every package's settings share
(`packages/shared/settings.js`, the model is `@margoengine/sky/settings`). Every row is `live`: writing it only changes
the weather state, so a film can key it over a shot, and `applyWeatherSettings` makes no pipeline, buffer or texture
(`tests/dust.test.js` pins each bound of the dust: the visibility against the published relations, dust 0 changing nothing bit for bit, the colour, the saltation threshold, the sand's wind within 5 degrees of the field's; `tests/settings-check.mjs` counts 60 frames of every row and compares displayed frames byte for byte: the default rows draw the `clear` preset's frame and `WEATHER_LOOKS.storm` the `storm` preset's, native and on the WebGL2 layer).

`storm` is the storm level, 0 the `clear` preset, 0.5 the `rain` preset and 1 the `storm` preset, with the numbers
between them blended. Every other row except `windDirection` has a null default and follows the storm level until it is
given a value (`nullable`, `weather: 'storm'`); give `wind: 30` and only the wind leaves the level. `rainRate` is the
state's `rain` as mm of water an hour (`rain = (R / 80)^(1/3)`); `visibility` is Koschmieder's distance and sets the fog
that leaves it, in the rain and snow set (`fogForVisibility`), and wins over `fog`: 23,000 m is clear air and about
200 m the thickest fog, and rain or snow already in the air can leave less than the visibility asked.

`applyWeatherSettings(machine, values)` jumps the machine to the state of those values (a name left out takes its
default), ends any transition and returns the state. A `WeatherDrive` on the same machine pushes it every frame into
every package it finds (the sky's clouds and fog, the sea, the rain and snow, hail, the fog volume, scatter, grass, smoke
and fire), so moving the one wind slider moves the sea, grass, scatter, rain, smoke, fire and fog together; a package
row that is `nullable` with `weather` set follows these rows while it is null, and overrides them when it is given a
value (`tests/settings.test.js` is the vane test: with every package at its default, each follows the wind within 5
degrees of the field's, with its own law for the size). A name not in the table throws a `TypeError`, a value outside
its row's range or kind a `RangeError`.

### Dust: haze, sandstorm, haboob

`dust` (0 to 1, a field of the state and a row of the panel) is dust in the air. Its mass concentration is
`dustConcentration(dust)`, 3,000 dust^2 micrograms of PM10 per cubic metre, and the visibility it leaves is the
published relation PM10 = 485.67 V^-0.776 (V in km; Jugder et al. 2014, tabulated in Camino et al., Aeolian Research 16,
2015) inverted, `dustVisibility`: 0.2 leaves about 6 km of dust haze, 0.5 about 570 m (a sandstorm), 0.9 about 130 m and 1
about 95 m. The relation is not valid over 10 km of visibility (Camino et al.), so thinner dust adds extinction in
proportion to its concentration and the haze fades to nothing with no step. `airExtinction`, `visibility`,
`fogForVisibility` (so the `visibility` row) and `fogDensity` all include `dustExtinction`; with `dust` 0 each is the
value it was before, bit for bit. The row follows the storm level at null, which holds no dust: a storm at sea has none.
`WEATHER_LOOKS` gains `dustHaze`, `sandstorm` and `haboob`.

A `WeatherDrive` also does three things for sand and dust, all of them package calls:

- **Wind over sand raises the dust.** While a `BlownSand` (`@margoengine/vfx/blown-sand`) is in the scene, the wind
  above its threshold raises the state's dust by the saltation flux (`dustFromWind`: Owen's flux over the threshold,
  up to 0.5), so a gale over a desert makes a sandstorm with no dust set by hand; `dustFromSand: false` turns it off, and
  a dust the state holds itself is never lowered.
- **The fog turns dust coloured.** While dust is most of the air's extinction, the sky fog's colour is `dustColor()`
  (a yellow-brown from the single-scattering albedo of desert dust, Dubovik et al. 2002) times `dustLight` (default 1),
  lit by the night's light once the sun sets (see "The fog and the sun"). The colour the fog had comes back when the
  dust clears.
- **The sand follows the weather.** Each `BlownSand` takes the state's wind speed, direction and gustiness as its `wind`
  while its wind is unset or `{speed: 0}` (a speed above 0 on the layer overrides), and the air's extinction as its `fog`
  while that is unset.

### Smoke: haze, wildfire smoke, a black day

`smoke` (0 to 1, a field of the state and a row of the panel) is smoke in the air. Its PM2.5 concentration is
`smokeConcentration(smoke)`, 5,000 smoke^2 micrograms per cubic metre, and its extinction is 4 m2/g of that mass (Reid
et al. 2005: 3.6 m2/g of scattering and about 0.5 of absorption), `smokeExtinction`; the visibility is Koschmieder's
3.912 over it as for fog and dust: 0.15 leaves about 6.3 km of haze, 0.35 about 1.5 km, 0.5 about 760 m and 1 about 190 m.
`airExtinction`, `visibility`, `fogForVisibility` and `fogDensity` all include it; with `smoke` 0 each is the value it
was before, bit for bit. The row follows the storm level at null (no smoke). `WEATHER_LOOKS` gains `smokeHaze`,
`wildfireSmoke` and `blackDay`.

A `WeatherDrive` does three things for it, all package calls:

- **The sun dims and reddens.** The sky's `atmosphere.sunColor` is multiplied by `smokeSunTransmittance(smoke, elevation)`,
  exp(-tau (lambda / 550 nm)^-1.8 / sin elevation) over a 2 km layer (the Angstrom exponent 1.8 of smoke, Eck et al.
  1999), read at the sun's height in `sky.sun`: 0.2 smoke leaves the noon sun a red 0.33 / 0.20 / 0.09 of its light, and a
  black day none. A sky with a `look`, or one that takes it (`sky.airControls`, true for the root `Sky`), and no
  `atmosphere` gets one; any other sky is left alone, and with no smoke nothing is written. The colour it had comes back
  when the smoke clears.
- **The sky is the layer's glow.** `sunColor` takes the dome down with the sun, and the light the smoke, ash and spray
  scatter down, `hazeLight` less the direct share times the sine of the sun's height, goes in the sky's
  `atmosphere.scatteredLight`: the layer lit from above shines evenly over the sky, so under a thick load the dome, its
  reflections, the light it gives the scene and a `VolumetricFog`'s ambient are a dim glow, not the clear sky
  (KB-AIR-SKYLIGHT1). Under the ash fall look the sky reads 19, 26, 33 against 215, 220, 228 in clear air.
- **The night is seen through the layer.** The drive also writes the sky's `atmosphere.layerTransmittance`, the
  direct share straight up (`sunTransmittance(state, Math.PI / 2)`): the stars, the moon, twilight and the clouds above
  are seen through it along each ray, so a starry sky goes out under a thick pall (KB-SKY-NIGHTPALL1). The moon and
  twilight light the layer from above as the sun does (each through the load at its height, over `lighting.intensity`),
  and the fires light it from below: it sends `hazeReflectance(state)` of their `fireHazeLight` back down (the
  two-stream slab's reflectance, Meador and Weaver 1980; 0.34, 0.31, 0.27 for a smoke of 0.6). The moon's and
  twilight's share, and that of fires which do not say where they burn, go in `scatteredLight`, even over the dome.
  Cleared as `sunColor` is.
- **The fog takes the smoke colour.** While dust and smoke together are most of the air's extinction, the sky fog's colour
  is `smokeColor()` (a grey brown from the single-scattering albedo of smoke, 0.84 to 0.89) times `smokeLight`, or the
  mix of dust and smoke colours by their share of the extinction.
- **The haze below the eye is darker.** While it colours the fog the drive also writes the fog's `lightDecay`,
  `hazeLightDecay(state, extinction)`: how fast the light inside the haze falls with depth below the eye, the two-stream
  diffusion exponent sqrt(g1^2 - g2^2) of the load's albedo and asymmetry (Meador and Weaver 1980), mixed by
  extinction with the clean rest of the air. A far ground the haze hides fully then darkens with the angle it is seen
  at, redder in smoke, instead of taking the horizon's one colour (KB-SKY-HAZEBELOW1). About 0.44, 0.49, 0.55 for smoke
  alone; 0 with no load. What the fog had comes back when the load leaves.

```js
import { hazeLightDecay } from 'margoengine/weather';

// Smoke alone: its light halves every 1.4 or so of optical depth below the eye, blue fastest.
const [red, green, blue] = hazeLightDecay({ smoke: 0.5 });
console.log(red < green && green < blue, green.toFixed(2));
```

- **A fire front makes smoke.** Each `FireFront` in the scene (found as `fire-front:N`, or the `fires` option) reports its
  `smokeEmission` in grams of PM2.5 a second (the fuel it burns times `smokeYield`, 15 g/kg, Akagi et al. 2011); the
  drive raises the state's `smoke` to `smokeFromEmission(grams, wind, smokeWidth)`, the box model Q / (U H W) over a
  crosswind width of 2 km (`smokeWidth`) and the 2 km layer. `smokeFromFire: false` turns it off, and a smoke the state
  holds itself is never lowered. The drive also hands each front its wind every frame (`setWind`, the 10 m wind at the
  front), so a fire given as `fires` spreads in the weather's wind (KB-FIRE-DRIVEWIND1).
- **The fire lights its smoke from below.** A front also reports its flames' `radiantPower` in watts (the radiant 0.3
  of its heat release, the share its smoke columns glow with); the light on the sky fog gains
  `fireHazeLight(watts, smokeWidth)`: half that power going up, the share an isotropic source on the ground sends through
  a disc of the box's area (`smokeWidth` squared) at the middle of the 2 km layer, spread over it, as a share of the noon
  sun's 1,000 W/m^2 in the flames' orange (`FIRE_LIGHT_COLOR`). So a valley burning under its smoke pall glows orange at
  night instead of going black, and the moon's light adds to it (KB-WEATHER-FIREHAZE1). A 45 GW blowup (a smoke of
  about 0.6 in a 5 m/s wind) lights the haze at 0.56, 0.24, 0.07 of the noon sun. `fireLight` scales it (default 1, 0
  off); a fire that reports no `radiantPower` gives the haze no light. A front that takes a `noon` (`FireFront.noon`)
  is given the sky's `lighting.intensity` each frame, so its columns' glow is referred to the same noon sun as the haze
  (KB-VFX-GLOWUNITS1). A front that takes an `air` (`FireFront.air`) is given the fires' light on the pall over it, the
  spots' light below at its heat-weighted centre plus the even light, so its smoke columns glow with the pall round
  them instead of reading dark against it at night (KB-VFX-COLUMNAMBIENT1). One that also takes an `airReflectance`
  (`FireFront.airReflectance`) is given its haze's reflectance (`hazeReflectance`) with it, so the columns take that
  light from below and the pall's share of it from above (KB-VFX-SMOKEFLAT1).
- **The glow is brightest over the fires.** A fire that also says where it burns (`segments()`, as `FireFront` has:
  `x`, `y`, `z` and `heat` each) lights the sky and the haze as spots over its sources instead of evenly
  (KB-SKY-PALLFALLOFF1). The drive shares each fire's `radiantPower` among its segments by heat and clusters all of
  them into at most eight sources by weighted k-means (Lloyd, IEEE Trans. Inf. Theory 28(2), 1982,
  https://doi.org/10.1109/TIT.1982.1056489), seeded by power times squared distance (the D^2 weighting of Arthur and
  Vassilvitskii, "k-means++", SODA 2007, taken at its maximum, as the farthest-point traversal of Gonzalez, Theoretical
  Computer Science 38, 1985), no two seeds within 500 m, so the same fires give the same sources. Each source's
  `fireLayerLight(power, spread, distance)` is the light of an isotropic source's upward half on a plane 1 km up,
  P h / (4 pi (h^2 + s^2 + r^2)^1.5) as a share of the noon sun (the cosine law over the squared distance, Modest,
  "Radiative Heat Transfer", 2013), whose mean over the box's disc is `fireHazeLight`. The drive writes the sky's
  `atmosphere.fireSpots` (that light times `hazeReflectance(state)`), `atmosphere.fireSight` (2 / the sky fog's density, or 2 / extinction with no fog) and
  `fog.fireSpots` (that light in the haze's own colour). They are cleared as the other values are.

```js
import { fireLayerLight } from 'margoengine/weather';

// A 3 GW stretch of front spread 350 m: the light on the smoke over it and 3 km away, red channel.
const over = fireLayerLight(3e9, 350)[0], away = fireLayerLight(3e9, 350, 3000)[0];
console.log(over.toFixed(3), away.toFixed(4), 'of the noon sun');
```

```js
import { WeatherMachine, fireHazeLight } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';

// The haze over a 45 GW blowup: the light on it, red green blue, as a share of the noon sun.
console.log(fireHazeLight(1.34e10).map((t) => t.toFixed(2)).join(' '), 'of the noon sun on the smoke');
const fire = { options: {}, smokeEmission: 36000, radiantPower: 1.34e10 };
const drive = new WeatherDrive({ weather: new WeatherMachine('clear'), fires: fire, fireLight: 1 });
console.log(drive.update(0).smoke.toFixed(2), 'smoke');
```

```js
import { WeatherMachine } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { WEATHER_LOOKS, applyWeatherSettings } from 'margoengine/weather/settings';
import { smokeSunTransmittance, smokeVisibility, smokeConcentration } from 'margoengine/weather';

const weather = new WeatherMachine('clear');
const drive = new WeatherDrive({ weather });
const state = applyWeatherSettings(weather, WEATHER_LOOKS.wildfireSmoke);
drive.update(1 / 60);
console.log(Math.round(smokeVisibility(smokeConcentration(state.smoke))), 'm of smoke visibility');
console.log(smokeSunTransmittance(state.smoke, Math.PI / 2).map((t) => t.toFixed(2)).join(' '), 'of the noon sun, red green blue');
```

```js
import { WeatherMachine } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { WEATHER_LOOKS, applyWeatherSettings } from 'margoengine/weather/settings';
import { dustVisibility, dustConcentration } from 'margoengine/weather';

const weather = new WeatherMachine('clear');
const drive = new WeatherDrive({ weather });
const state = applyWeatherSettings(weather, WEATHER_LOOKS.sandstorm);
drive.update(1 / 60);
console.log(state.dust, Math.round(dustVisibility(dustConcentration(state.dust))), 'm of dust visibility');
```

### Ash and sea spray: ash fall, darkness at noon, sea haze and the surf

`ash` and `spray` (0 to 1 each, fields of the state and rows of the panel) are volcanic ash and sea spray in the air.
Both are coarse grains, much larger than the wavelength of light, so each removes twice its geometric cross section at
every wavelength (van de Hulst 1957): `coarseExtinction(micrograms, radius, density)` is 3 C / (2 rho r), the same law
`Eruption.visibility` uses for each grain class. They dim the sun grey, without reddening it (an Angstrom exponent of 0,
where smoke's is 1.8). `airExtinction`, `visibility`, `fogForVisibility` and `fogDensity` all include them; with both at
0 each is the value it was before, bit for bit. The rows follow the storm level at null (none). `WEATHER_LOOKS` gains
`ashfall` (about 930 m, the direct sun gone), `ashDarkness` (under 200 m), `seaSpray` (about 13 km) and `surfHaze` (about 3 km).

- **Ash.** `ashConcentration(ash)` is 100,000 ash^2 micrograms per cubic metre of grains 1.75 micrometres across in
  effective radius (the coarse mode of the 2010 Eyjafjallajokull plume, Waquet et al. 2014) and 2,500 kg/m3: ash 1
  leaves about 114 m, and Ansmann et al.'s (2011) distal peak of 1,500 micrograms is ash 0.12, about 7 km.
  `ashColor()` is a neutral grey from the single-scattering albedo of ash, 0.94 to 0.95 (Toledano et al. 2012).
  `ashForExtinction` inverts the extinction.
- **An eruption makes ash.** Each `Eruption` attached with `Eruption.attach(engine, options)` (named `eruption:N`; it
  steps itself each frame), or handed in as `eruptions`, gives the drive its falling ash at the camera: the extinction
  3.912 / `eruption.visibility(x, z)` less the clear air becomes the state's `ash`, so the drive's visibility there is
  the eruption's own. `ashFromEruption: false` turns it off; an ash the state holds itself is never lowered.
- **Sea spray.** `seaSalt(wind, distance)` is the dry sea-salt load over the open sea, exp(0.16 U + 1.45) micrograms per
  cubic metre (Lovett 1978, 1,821 samples from North Atlantic weather ships), times 1 + 29 exp(-d / 2 km) at a distance
  d downwind of breaking surf (one to two orders of magnitude more beside the surf zone, de Leeuw et al. 2000; 30 is
  the geometric middle). A sea-salt particle at 80 percent humidity has twice its dry radius (Lewis and Schwartz 2004),
  so `sprayExtinction` is 4 times the dry grains'. The open sea in a 10 m/s wind leaves about 19 km; the surf zone in a
  gale under 1 km. `sprayColor()` is white (sea salt does not absorb).
- **The sea makes spray.** With a `Water` in the scene (`water:N`, or the `water` option) the drive raises the state's
  `spray` to `sprayFromWind(wind)`, thicker near the breakers: a `Water` given `terrain.heights` reports its own
  breaker line (`water.breakerLine()`), which the drive reads when `surf` is unset; `surf` (`[x, z]` points joined in
  order) gives one by hand and overrides it. `sprayFromSea: false` turns it off.
- **The fog and the sun.** While dust, smoke, ash and spray together are at least half the air's extinction, the sky
  fog's colour is their colours mixed by their share of it, each times its own light (`dustLight`, `smokeLight`,
  `ashLight`, `sprayLight`); one alone gives its own colour exactly. Under smoke, ash or spray that colour is lit by
  `hazeLight(state, elevation)`, the light that still reaches the air: the direct sun through the layers plus the rest
  they scatter times what a two-stream slab passes down (Meador and Weaver 1980). So the haze, and the ground behind it,
  darken as the load thickens: a black day or an ash darkness is dark at noon. As the sun sets the haze hands that
  sunlight over to the night's by the sky's own blend (`sky.nightFactor`, 0 with the sun 4.6 degrees up, 1 at 6.9
  degrees down): at night it is lit by the moon under the clouds and the twilight sky (`sky.moonUnderClouds`,
  `sky.twilightLight`), each through the load at its own height, over the sky's `lighting.intensity`, so a moonlit
  haze is as much dimmer than the noon haze as the moonlit ground is than the noon ground, and bluer
  (KB-WEATHER-NIGHTHAZE1). A dust haze takes the same handover. A sky with no night lights gives a black haze at
  night. A `VolumetricFog` the drive writes
  (`fogVolumes`, or found as `volumetric-fog`, with no `visibility` of its own) takes the load's colour too: each load's
  colour by its share of the volume's extinction, the rest of the air white, so ash greys it and smoke browns it; it is
  lit by the scene's lights, so no haze light is put on it. A colour held by the `air.color` row of
  `@margoengine/environment/settings` is never written; with no load the colour it had comes back. The sky's `atmosphere.sunColor` is multiplied by
  `sunTransmittance(state, elevation)`: the smoke's reddening times the grey exp(-tau / sin elevation) of the ash over a
  3 km layer and the spray over 500 m.

```js
import { WeatherMachine, visibility, sunTransmittance, hazeLight, sprayFromWind } from 'margoengine/weather';
import { WeatherDrive } from 'margoengine/weather/drive';
import { Eruption } from 'margoengine/weather/eruption';

const weather = new WeatherMachine('clear');
weather.set({ ...weather.state, wind: 12, windDirection: 0 });
// An eruption 40 km south, its ash blown north; a coast whose breakers run along z = 60.
const eruption = new Eruption({ vent: [0, 0, -40000], weather });
eruption.seek(5400);
const drive = new WeatherDrive({ weather, eruptions: eruption, surf: [[-3000, 60], [3000, 60]], position: [0, 5, 0] });
const air = drive.update(0);
console.log(air.ash.toFixed(2), 'ash and', air.spray.toFixed(2), 'spray:', Math.round(air.visibility), 'm of visibility');
console.log(sunTransmittance(air, Math.PI / 3).map((t) => t.toFixed(2)).join(' '), 'of the sun, red green blue');
console.log(hazeLight(air, Math.PI / 3).map((t) => t.toFixed(2)).join(' '), 'of the light on the haze');
console.log(Math.round(visibility({ fog: 0, rain: 0, snow: 0, spray: sprayFromWind(10) })), 'm over the open sea at 10 m/s');
```

### Humidity, temperature and the fuel of a fire

`humidity` (relative humidity at 2 m, 0 to 1) and `temperature` (degrees Celsius at 2 m, -80 to 60) are fields of the
state and rows of the panel; at null they follow the storm level. The presets hold 15 C (the ICAO standard atmosphere at
sea level) except snow (-2 C), blizzard (-8 C) and sleet (1 C), since snow falls mostly below about 1 C (Dai 2008);
fog is saturated air (1), rain and drizzle 0.95, a fair day 0.5. A METAR's temperature and dew point set them
(`weatherFromMetar`, the Magnus form of Alduchov and Eskridge 1996). Nothing that draws reads them, so every picture is
as it was; they set the dead fuel moisture of a fire.

`equilibriumMoisture(humidity, temperature)` is the moisture dead wood settles to in that air, Simard's (1968)
regressions as the US National Fire-Danger Rating System gives them (Cohen and Deeming 1985). `fuelLevelAir` warms and
dries the air at the fuel bed in daylight by the cloud cover (add 25, 19, 12 or 5 F and scale the humidity by 0.75, 0.83,
0.92 or 1). `FuelMoistureModel` steps the 1, 10 and 100 hour dead fuel toward that target by Fosberg's timelag response
(m += (target - m)(1 - exp(-dt / tau)), tau 1, 10 and 100 hours); while it rains the 1 and 10 hour fuels go toward 35
percent and the 100-hour fuel toward 0.5 d + 41 percent after d hours of rain. A `WeatherDrive` with a `FireFront` in the
scene runs one and writes each fire's `moisture`, `moisture10` and `moisture100` while they are unset (a value a
person set wins; `fuelMoistureFromWeather: false` turns it off; `fuelTimeScale` runs the fuel clock faster, for a film
that shows an afternoon in a minute). The look `redFlag` (32 C, 15 percent humidity, 9 m/s) dries fine fuel in the sun to
about 2 percent; a fair day leaves about 7.

```js
import { FuelMoistureModel, WeatherMachine, equilibriumMoisture } from 'margoengine/weather';
import { WEATHER_LOOKS, applyWeatherSettings } from 'margoengine/weather/settings';

const weather = new WeatherMachine('clear');
const state = applyWeatherSettings(weather, WEATHER_LOOKS.redFlag);
console.log((equilibriumMoisture(0.3, 30) * 100).toFixed(1), 'percent in 30 percent air at 30 C'); // 5.8
const fuel = new FuelMoistureModel({ start: { moisture: 0.35, moisture10: 0.35, moisture100: 0.35 } });
for (let hour = 0; hour < 3; hour++) fuel.step(state, 3600); // three dry hours after rain
console.log(fuel.moisture); // the 1-hour fuel is nearly dry, the 100-hour fuel has hardly moved
// WeatherDrive.attach(engine, { weather }) writes these into every FireFront in the scene while its moisture rows are null.
```

The named looks are `calm`, `breeze`, `gale`, `storm`, `hurricane`, `fog`, `drizzle`, `downpour`, `dustHaze`, `sandstorm`, `haboob`, `smokeHaze`, `wildfireSmoke`, `blackDay`, `blizzard`, `redFlag` and `animatedFeature`; each
is only values of the rows, so a look is a starting point a slider can move on from.

```ts
import { WeatherMachine, beaufort } from 'margoengine/weather';
import { WEATHER_LOOKS, WEATHER_SETTINGS, applyWeatherSettings, weatherSettingDefaults, weatherStateOf } from 'margoengine/weather/settings';

const machine = new WeatherMachine('clear', { seed: 7 });
// The panel's state: every row at its default, then a look to start from.
const values: Record<string, number | null> = { ...weatherSettingDefaults(), ...WEATHER_LOOKS.gale };
console.log(beaufort(weatherStateOf(values).wind)); // 8, a gale
// One slider per row, built from the table; null puts a row back on the storm level.
for (const row of WEATHER_SETTINGS) {
  const slider = Object.assign(document.createElement('input'), { type: 'range', title: row.about, min: String(row.min), max: String(row.max), step: String(row.step) });
  slider.value = String(values[row.name] ?? row.min);
  slider.oninput = () => {
    values[row.name] = Number(slider.value);
    applyWeatherSettings(machine, values); // every frame is fine: it only writes the state
  };
  document.body.append(slider);
}
applyWeatherSettings(machine, values);
// WeatherDrive.attach(engine, { weather: machine }) then carries it to the sea, rain, fog, fire, smoke, scatter and grass.
```

Lying snow has two tables on the same row shape. `SNOW_SETTINGS` (8 rows) is `Snow`'s look: `cover` follows the
weather's snow cover while null, then `depth`, `variation`, `drift`, `grain`, `roughness`, `color` and the field's
`band`; `applySnowSettings(snow, values)` writes them, and a set `cover` wins over the weather until it is set back to
null. `SNOW_DRIFT_SETTINGS` (33 rows) is every `SnowDrift` option: `wind`, `windDirection`, `snowfall`, `temperature`
and `humidity` follow the weather while null; `step`, `initialDepth` and `initialDensity` are not live (they replay from
0); the wind, slope, cornice and slide rows are live. `applySnowDriftSettings(drift, values)` writes them (`inflow`
'snowfield' or 'bare'), `SNOW_DRIFT_LOOKS` has `weather`, `filmDay`, `powder`, `windSlab` and `blizzard`, and
`snowSettingValues(target, drift?)` reads a panel's starting state back.

## Limits

- While rain and snow both fall (a rain-to-snow blend, or the `sleet` preset) `skyWeather` gives the sky's `Weather` `precipitation: 'sleet'`, their sum as `intensity` (at most 1) and the snow's part of it as `snowShare`, so the rain thins as the snow thickens; the sky draws each kind with its share. Hail is drawn alongside either.
- Lit hail stones are shaded as balls by the engine's one sun and its ambient light: they cast no shadows and are not
  shaded by the scene's shadows (a stone under a roof is lit as in the open); a splash is four chips per stone, not a
  bounce off the surface it hits. The box around the camera is at most 400 m across; stones outside it do not exist.
- Puddles stand in the low spots of a procedural relief, not of your geometry, and on every flat core and Material
  mesh, roofs included unless a `PrecipitationCover` shelters them; there is no flow. They draw on core meshes and
  `margoengine/materials` meshes; glTF PBR models take them through `GLTFWeather`, and other packages' own shaders not
  at all. Rings tilt the normal only; the water has no depth, refraction or reflection
  of its own beyond the scene's lighting.
- Snow's shadows draw the unlifted shape, and a vertex stage another package replaced keeps its shape. Without a
  `PrecipitationCover` nothing is sheltered.
- `SnowDrift` is a height field: a cornice is a separate mesh (`corniceGeometry`), not part of the ground, and nothing
  tunnels or overhangs in the snow itself. The wind over the terrain is MicroMet's weighting and Winstral's shelter, not
  a flow solution, so there are no eddies and no lee vortex; snow in motion is a flux, not drawn particles. The snow does
  not settle or melt after it lands (a layer keeps its density). The slide state marks where a slab would release; the
  avalanche itself is another feature. It runs on the CPU, about 0.15 microseconds per cell per step on the dev PC
  (a 96 x 8 grid, 1,080 steps in 123 ms, the shelter search every 6 steps included); a seek back replays from 0. The field draws on core meshes and
  Material meshes (WebGPU and the WebGL2 layer), not glTF PBR models.
- Region fronts are straight and move at a constant speed, cells are circles at a constant velocity; none bends,
  stalls or forms by itself. They are authoring shapes, not a forecast model.
- Weather audio is one rain and one wind loop heard everywhere at once (no louder rain on a roof, no wind direction)
  and a generated rumble per strike; give `buffers` for recorded sound.
- METAR reading is one observation at a time: trends and remarks stay text, TAF forecasts are not read, and the
  state keeps the greatest cloud cover, three precipitation intensities and fog from the visibility alone.
- The presets and the climate chain are design choices, not weather data. Wind speed is a mean at one height with simple noise, not a boundary-layer model.
- This package draws no clouds or fog of its own: `WeatherDrive` feeds `cloud` and `fog` to the sky's and the
  environment's.
- Hail needs WebGPU; on a WebGL engine `attach` throws `MargoError` `'unsupported'`. Everything else runs anywhere, Node included.

Apache-2.0. Optional, tree-shakable package; no core dependency in the root entry (only `./hail`, `./puddles` and `./snow` import core; `./snow-drift` is plain JavaScript; `./avalanche` imports core's extension runtime only for `AvalancheScatter`).

Build and unit tests: npm test --workspace @margoengine/weather

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

`PrecipitationCover` refuses the small preview in its own setup through the shared `requireWebGPU` (`PrecipitationCover needs WebGPU`, code `unsupported`, help link), after its `disposed` and `attached` checks and before it sets up the WeatherFX capture. Before 2026-11-10 it relied on the capture to refuse, which the preview-contract gate cannot see, so `npm run verify` failed. Two unit fixtures in `tests/cover.test.js` gained `gpu: {}` on their fake engine, because a cover now needs a GPU engine to attach; their assertions are unchanged. Regression: the new preview test in `tests/cover.test.js`.
