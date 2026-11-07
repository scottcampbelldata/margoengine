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
- `schedule([{to, seconds, hold}], {loop})` runs steps in order. `randomWalk(from, {chain, hold, blend, seed})` wanders by a weighted chain (`TEMPERATE` by default; a made-up mild climate), the same way for the same seed.
- `on(listener)` gets `start` and `arrive` events once each per transition. A listener that changes the weather throws `MargoError` `'state'`.
- `update(delta)` moves everything; a long delta (a hidden tab) is applied in pieces of at most 5 s so the ground and the schedule behave as if time had passed normally. `state` is a fresh copy each read.
- `wetness` rises under rain and hail (about 20 s) and dries (about 90 s); `snowCover` builds under snow (about 2 minutes) and melts (about 5 minutes). The time constants match the sky's own `Weather`.
- `using` and `dispose()` end it; use afterwards throws `MargoError` `'disposed'`.

## Wind

`machine.wind` is a `WindField`, kept in step with the state; make your own with `new WindField({speed, direction, gust, turbulence, gustPeriod, scale, seed})`. `sample(x, y, z, t)` returns a velocity: the mean wind scaled by a gust factor (between `1 - gust` and `1 + gust`), a direction that wobbles up to `0.5 * gust` radians, and turbulence that differs from place to place and blows downwind with the mean. It is a pure function of its arguments, so the same call gives the same vector, and its length never exceeds `speed * (1 + gust + turbulence)`. Use it for rain slant, sway of trees and cloth, or a sound's wind layer.

## Wet and snowy surfaces

`wetRoughness`, `wetColor`, `snowWeight` and `surfaceResponse` give a surface's roughness and colour from the ground state: wet is darker (up to 25 percent) and shinier (down to 35 percent of the dry roughness), and snow whitens up-facing surfaces first and steeper ones as the cover grows. `applyWetness(material, dryRoughness, wetness)` sets `material.roughness`. For a shader, paste `surfaceWGSL` ahead of it and call `weather_surface(roughness, color, normalY, wetness, snowCover)`; the real-GPU test checks that WGSL against the JavaScript.

## Puddles and wet ground

`Puddles` from `margoengine/weather/puddles` makes the rain show on every core mesh: surfaces darken and turn shinier
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
Wetness darkens and smooths every surface as `wetColor` and `wetRoughness` do (set `wetSurfaces: false` to draw only
the water, for example when you already call `applyWetness`). Water stands where a procedural relief of puddles about
`size` metres wide (default 3) lies below a water level, on surfaces within about 15 degrees of flat: from wetness
`start` (0.4) the share of flat ground under water grows to `coverage` (0.3, at most 0.8) at wetness 1. Under water a
surface is darker by 30 percent, has roughness 0.03 and no metalness, and its normal turns up and is tilted by rings:
one drop at a time in each `rippleSize` cell (0.35 m) of two offset grids, in a share of the cells equal to the rain,
by up to `rippleStrength` (0.35). `puddleMask`, `puddleSurface`, `puddleRelief` and `puddleLevel` are the same maths in
JavaScript; `puddleWGSL` is the shader for your own materials. A bad option throws `RangeError` or `TypeError`; a
replaced core shader throws `MargoError` `'unsupported'`.

## Snow with depth

`Snow` from `margoengine/weather/snow` lays snow on every core mesh: up-facing surfaces whiten first and steeper ones
as the cover grows, the snow line is patchy, the surface has a fine grain, and the snow has thickness: covered
surfaces are lifted by it, so a step or a kerb fills in and a plate's edge rises. It follows a `WeatherMachine` or the
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
none on walls, varied in drifts `drift` metres wide (4) by up to `variation` (0.4): the vertex stage moves each covered
vertex up by it. `snowAt` and `snowDepthAt` are the same maths in JavaScript; `snowWGSL` is the shader for your own
materials. `Snow` and `Puddles` work together on one scene. A bad option throws `RangeError` or `TypeError`; a replaced
core shader throws `MargoError` `'unsupported'`.

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
(negative once it has passed). `addFront` and `addCell` return removers. Bad input throws `TypeError` or `RangeError`.

## Driving the sky

`skyWeather(state, wind?)` returns the sky `Weather` settings for a state: `Object.assign(weather.options, skyWeather(state))`. `hailSettings` does the same for `Hail`. `fogDensity(state)` gives an exponential-fog density per metre (0.0002 clear to 0.02 thick).

### Clouds and fog from the state, automatically

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
rain, snow, hail and lightning, and it drifts with the wind times `windAloft` (3). Fog: an exponential fog and a fog
volume get `fogDensity` as their extinction; a squared fog (environment `Fog`, the sky's default fog) gets that over
the square root of 3, which leaves the same 5 percent of contrast at the same distance. A sky's cloud sheet and fog are
set only when the sky has them. The wind for rain and hail is the machine's wind field at `listener.position` (or
`position`). With `advance: false` you step the weather yourself. `driveSettings(state)` gives the numbers alone.

## Hail

`Hail.attach(engine, options)` (from `margoengine/weather/hail`, WebGPU only) draws stones that fall at `fallSpeed` (default 18 m/s), hit the ground at `groundY`, bounce twice (`restitution` 0.2) and stop. Every position is a closed-form function of time and the stone's index, so only one uniform block is uploaded per frame; stones are depth-tested against the scene and fade at the edge of the box that follows the camera. Options: `intensity`, `fadeSeconds`, `wind`, `groundY`, `radius`, `height`, `particles` (6,000 at intensity 1), `fallSpeed`, `restitution`, `stoneRadius`, `color`, `brightness`, `opacity`, `seed`, `lit` and `splashes`; all are read each frame from `hail.options` and validated.

Stones are lit (`lit`, default true) as small ice balls by the engine's light (`engine.lighting`: the sun's direction, strength and colour, and the ambient light): Lambert diffuse on the side toward the sun, a glint of it, and the far side in the stone's own shadow, lit only by the ambient; `lit: false` keeps the flat `color`. Where a stone first lands, `splashes` ice chips (4, at most 8) burst out at 0.6 to 1.8 m/s and 1 to 2.5 m/s upward and fall back under gravity, fading over `SPLASH_SECONDS` (0.35 s); like the stones they are a closed-form function of time, drawn in the same instanced draw. `stoneState(tau, options)` is the same height and speed formula in JavaScript. Without an engine, `new Hail(options)` and `update(delta)` still ease `amount`.

## Limits

- While rain and snow both fall (a rain-to-snow blend, or the `sleet` preset) `skyWeather` gives the sky's `Weather` `precipitation: 'sleet'`, their sum as `intensity` (at most 1) and the snow's part of it as `snowShare`, so the rain thins as the snow thickens; the sky draws each kind with its share. Hail is drawn alongside either.
- Lit hail stones are shaded as balls by the engine's one sun and its ambient light: they cast no shadows and are not
  shaded by the scene's shadows (a stone under a roof is lit as in the open); a splash is four chips per stone, not a
  bounce off the surface it hits. The box around the camera is at most 400 m across; stones outside it do not exist.
- Puddles stand in the low spots of a procedural relief, not of your geometry, and on every flat core mesh, roofs
  included: there is no cover (water stands under a roof too) and no flow. They draw on core meshes, not glTF-pro
  models or other packages' own shaders. Rings tilt the normal only; the water has no depth, refraction or reflection
  of its own beyond the scene's lighting.
- Snow lifts each vertex by its own normal, so a mesh whose faces share no vertices (`box()`) opens a slit as deep as
  the snow along its top edges; smooth meshes (terrain, shared normals) stay closed. Snow has no cover from roofs and
  no wind drift, and shadows draw the unlifted shape. A vertex stage another package replaced keeps its shape.
- Region fronts are straight and move at a constant speed, cells are circles at a constant velocity; none bends,
  stalls or forms by itself. They are authoring shapes, not a forecast model.
- The presets and the climate chain are design choices, not weather data. Wind speed is a mean at one height with simple noise, not a boundary-layer model.
- This package draws no clouds or fog of its own: `WeatherDrive` feeds `cloud` and `fog` to the sky's and the
  environment's.
- Hail needs WebGPU; on a WebGL engine `attach` throws `MargoError` `'unsupported'`. Everything else runs anywhere, Node included.

Apache-2.0. Optional, tree-shakable package; no core dependency in the root entry (only `./hail`, `./puddles` and `./snow` import core).

Build and unit tests: npm test --workspace @margoengine/weather
