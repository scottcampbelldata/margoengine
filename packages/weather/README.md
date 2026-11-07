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

## Driving the sky

`skyWeather(state, wind?)` returns the sky `Weather` settings for a state: `Object.assign(weather.options, skyWeather(state))`. `hailSettings` does the same for `Hail`. `fogDensity(state)` gives an exponential-fog density per metre (0.0002 clear to 0.02 thick).

## Hail

`Hail.attach(engine, options)` (from `margoengine/weather/hail`, WebGPU only) draws stones that fall at `fallSpeed` (default 18 m/s), hit the ground at `groundY`, bounce twice (`restitution` 0.2) and stop. Every position is a closed-form function of time and the stone's index, so only one uniform block is uploaded per frame; stones are depth-tested against the scene and fade at the edge of the box that follows the camera. Options: `intensity`, `fadeSeconds`, `wind`, `groundY`, `radius`, `height`, `particles` (6,000 at intensity 1), `fallSpeed`, `restitution`, `stoneRadius`, `color`, `brightness`, `opacity`, `seed`; all are read each frame from `hail.options` and validated. `stoneState(tau, options)` is the same height and speed formula in JavaScript. Without an engine, `new Hail(options)` and `update(delta)` still ease `amount`.

## Limits

- The sky's `Weather` draws one precipitation at a time. During a rain-to-snow blend the heavier one is drawn and the switch happens where they are equal; sleet is shown as whichever of the two is heavier. Hail is drawn alongside either.
- Hail stones are camera-facing streaks with no lighting or shadows and no splash where they land. The box around the camera is at most 400 m across; stones outside it do not exist.
- The presets and the climate chain are design choices, not weather data. Wind speed is a mean at one height with simple noise, not a boundary-layer model.
- `cloud` and `fog` are numbers for you to feed to your sky and fog; this package does not draw clouds or fog.
- Hail needs WebGPU; on a WebGL engine `attach` throws `MargoError` `'unsupported'`. Everything else runs anywhere, Node included.

Apache-2.0. Optional, tree-shakable package; no core dependency in the root entry (only `./hail` imports core).

Build and unit tests: npm test --workspace @margoengine/weather
