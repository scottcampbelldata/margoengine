# Whiteout Pass

A blizzard at dusk on a mountain pass. Snow streams sideways past a small log hut, the trail's snow stakes fade into
the white one by one, and one window glows warm. Cold outside, warm inside, live in WebGPU. Open
`examples/whiteout-pass/index.html` with the repository's Vite dev server.

## What it shows

- **One kit.** Every value that sets the look comes from `whiteout` (`@margoengine/sky/scene-kits`): the sky, the
  blizzard and its lull as weather states, the snowfall, the snow cover, the fog, the lamp, bloom and the grade. The
  page builds the hut and the pass from primitives (`@margoengine/geometry`) and composes the packages.
- **The storm is weather.** A `WeatherMachine` holds the blizzard and a `WeatherDrive` (`@margoengine/weather`)
  writes it every frame: the amount of snow and the gusting wind at the camera into the falling snow
  (`@margoengine/sky/weather`), and the same wind into the froxel fog (`fogWind`), so the blowing snow near the
  ground streams past with each gust. `storm` blends the blizzard into the lull and back; the fog's density follows
  the kit's visibility for that level (90 m in the storm, 1,200 m in the lull).
- **The window.** The lamp is one shadowed point light (`@margoengine/clustered`) flickering on the `candle` curve.
  The log walls hold its light in, so it leaves only through the window: onto the sill, the snow below and the fog in
  front of it, where it shows as a glow in the storm. One top-down cover map (`WeatherFX` captured by
  `PrecipitationCover`, `@margoengine/weather/cover`) keeps the snow out of the hut; `Snow`
  (`@margoengine/weather/snow`) lays 12 cm of drifting snow on the ground, the roof and the sill.

## Views and layers

| URL option | Effect |
| --- | --- |
| `view=window` (default), `view=close` | the hut small in the storm from the trail, or the lit window from a few steps |
| `storm=0` to `1` | the lull (0) to the blizzard (1, default) |
| `debug=wireframe` | every mesh's edges over the shaded scene (`@margoengine/lines`) |
| `debug=wind` | the wind field the snow and the fog follow, as arrows that swing with the gusts |
| `fog=0`, `snow=0`, `cover=0`, `drift=0`, `lamp=0` | turn one layer off (`drift=0` keeps the fog still), for before and after views |
| `exposure=<seconds>` | the shutter time each snow flake is swept over, so the gale streaks it (default 1/120 s, a 180 degree shutter at 60 fps; the shot files give each sub-frame its share) |
| `ui=0` | no mouse orbit (the shot tool drives the camera) |

## Shots

`tools/shot/shots/whiteout-*.json` render the scene offline for the shorts and the long video (`docs/shots.md`):
`whiteout-window` (one lit window in the whiteout), `whiteout-walk-in` (a slow walk up the trail into the wind),
`whiteout-window-close` (the window from a few steps), `whiteout-clearing` (the storm eases into the lull and the
pines come out of the white, through `whiteoutPass.apply` and a `weather.storm` property track), and for the
breakdown `whiteout-wireframe`, `whiteout-wind` and `whiteout-bare` (no fog and no falling snow). All use one MSAA
sample with 1.5x supersampling; the storm shots average eight sub-frames over a 180 degree shutter, so the flakes the
wind drives at 18 m/s streak.

Those seven are vertical shorts. `whiteout-long-<name>.json` are the same seven as footage for the long video: kind
`long`, 1920 x 1080 at 30 fps, the same camera paths at half again the length, rendered in production mode (one full
render, its probes checked on a second).

```sh
node tools/shot/cli.mjs tools/shot/shots/whiteout-window.json
node tools/shot/cli.mjs tools/shot/shots/whiteout-long-window.json --production --encode
```

## Limits

The flakes are the sky Weather's fixed discs and are not lit by the lamp (lit precipitation is still to come); the
blowing snow near the ground is the fog's noise streaming with the wind, not particles. See `docs/limits.md`.
