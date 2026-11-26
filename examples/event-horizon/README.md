# Event Horizon

A spinning black hole traced through Kerr spacetime, live in WebGPU: the lensed accretion disk, its jet, the light
paths and maps of redshift, beaming, observed temperature and image order. Every pixel is a ray traced back from the
camera, so the shadow, the photon ring and the disk's secondary images come out of the maths. The page composes
`@margoengine/shader/black-hole` (its README section lists the options and the papers it is built from) with bloom
and a tonemap from `@margoengine/post` and `@margoengine/tonemap`. Open `examples/event-horizon/index.html` with the
repository's Vite dev server.

| URL option | Effect |
| --- | --- |
| `ui=0` | no panel and no mouse orbit (the shot tool drives the camera) |

## Shots

`tools/shot/shots/eh-*.json` render the scene offline (`docs/shots.md`). The shot tool drives the camera from each
shot's camera track and the hole through `eventHorizon.apply`, from property tracks on the target `hole`: `spin`,
`accretion`, `turbulence`, `jet`, `view` (0 beauty, 1 redshift, 2 beaming, 3 temperature, 4 image order),
`prefilter` (0 or 1), `paths` (light paths drawn) and `flareAge` (seconds since a hot spot started).
The disk follows the engine shader clock by default. `diskTime` sets external texture time in seconds, and
`diskInflow` specifies radial drift in M per orbital time unit. The beaming view shows moving disk emission
through the stationary observer's Doppler pattern.

Twelve are footage for the long video (kind `long`, 1920 x 1080 at 30 fps, 675 s in all): `eh-long-approach` (in
from 140 r_s), `inclinations` (edge on up towards the pole), `spin` (0 to the 0.998 limit and back to 0.5),
`accretion` (the disk brightens, a hot spot spirals in), `geodesics` (the fan of light paths from the side),
`redshift`, `beaming` (then the observed temperature), `orders` (image order, edge on), `before-after` (the footprint
filter off and on every 10 s), `jet` (down the jet from above the pole), `rim` (skimming the inner rim) and `plunge`
(from 12 to 1.6 r_s). Three are vertical shorts: `eh-short-approach`, `eh-short-fix` (the filter off and on every
6 s) and `eh-short-maps` (beauty, redshift, beaming and temperature). All use one MSAA sample and average four
sub-frames over a 180 degree shutter; the long shots supersample 1.5 times.

`examples/event-horizon/make-shots.mjs` writes the fifteen files; `tests/shot-file.test.js` checks they match it.

```sh
node examples/event-horizon/make-shots.mjs
node tools/shot/cli.mjs tools/shot/shots/eh-short-approach.json --encode
node tools/shot/cli.mjs tools/shot/shots/eh-long-approach.json --production --encode
```

## Limits

On the Radeon 680M under D3D12 a negated division loses its sign in the fragment stage, a compiler fault below Margo
that the shader avoids; see `docs/known-bugs.md` and `docs/limits.md`.
