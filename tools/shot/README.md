# Shot tool

Renders a shot file to PNG frames offline, twice, and checks the two renders are identical: the capture step of the
shorts. The format, the shot clock, the determinism check and the hand-off to encoding are in
[docs/shots.md](../../docs/shots.md).

```sh
npm ci
npm run build:packages
node tools/shot/cli.mjs tools/shot/shots/storm-light-tour.json --seconds 2
# frames, masks (aovs/geometry, depth, sky, water), manifest, probes, contact sheet and the probes' look checks
# (look.md, look.json, look.png) in test-results/shots/<today>/storm-light-tour/
```

Render and encode a short on the dev PC, from the Beelink: one job into the dev PC's render queue, run by the "Margo
Shot Runner" task in the signed-in session (docs/shots.md, Render queue):

```sh
# MARGO_SHOT_REMOTE_QUEUE (or --remote) names the queue folder on the dev PC: its render checkout's .lane/queue
node tools/shot/queue.mjs submit tools/shot/shots/orrery-dolly.json --encode
# outcome in that folder's done/ (or failed/), log in logs/,
# the master beside the frames: .lane/shots/<today>/orrery-dolly.mp4
```

Footage for a long video: a shot with `"kind": "long"` is 1920 x 1080 at 30 fps unless it says otherwise, up to 20
minutes. Render it in production mode, once with its probes checked:

```sh
node tools/shot/cli.mjs tools/shot/shots/orrery-orbit.json --production --encode
```

Encode frames already rendered (ffmpeg from `MARGO_FFMPEG` or the PATH; checks in `<frames>/encode.json`):

```sh
node tools/shot/encode.mjs test-results/shots/2026-11-14/orrery-dolly
```

The master follows YouTube's recommended upload encoding settings (YouTube Help, "Recommended upload encoding settings"):
H.264 High, progressive, CABAC, a closed GOP of half the frame rate (30 at 60 fps, 15 at 30 fps), 2 consecutive
B-frames, BT.709, `+faststart`. The `gop` check reads the keyframe spacing, the B-frames and the x264 settings back with
ffprobe. The masters are silent: the final edited upload carries AAC-LC audio at 48 kHz stereo, which the editor adds.

| Option | Meaning |
| --- | --- |
| `--check` | Only check the shot file |
| `--seconds <s>` | Render the first `s` seconds of the shot; its settings keys are still checked against the whole shot (`shot.fullSeconds`) |
| `--day YYYY-MM-DD` | The day's output folder (default today) |
| `--out <dir>` | Write to this folder instead |
| `--once` | One render, no determinism verdict (a look while editing a shot) |
| `--production` | One full render, its probe frames checked on a second render that stops after the last probe (footage for a video; docs/shots.md, Production renders) |
| `--browser=<name>` | `edge`, `chrome` or `chromium` (default Edge on Windows, Chrome on macOS) |
| `--encode` | Then make and check the MP4 master (`encode.mjs`) |

Exit codes: 0 rendered and identical (and every look check passed and, with `--encode`, a master that passed its
checks), 1 failed (the determinism check names the first differing frame; a master check names itself), 2 a bad
option or shot file, 3 rendered but a look check failed (`look.md` says which; frames and master are kept).

Environment: `MARGO_SHOT_OUT` (the folder that holds the day folders), `MARGO_BROWSER`.

## Files

- `cli.mjs`: the command.
- `shot-file.mjs`: the shot file format, its checks, the frame list and the comparison of two renders.
- `driver.js`: the page side, installed before the page's own code: the shot clock, the seeded `Math.random`, the
  GPU and network settling and the canvas copy.
- `render.mjs`: one render (`renderOnce`) and the double render with its manifest (`shoot`). The browser opens on
  `blank.html` and loads the shot's page once, with its query (`openBrowser` `openPath`), so no load is cut short.
- `pixels.js`: the capture maths (sub-frames summed in linear light, the area filter down from the supersampled
  canvas, the blue-noise dither of the one 8-bit encode); `pixel-script.mjs` installs it in the page.
- `look.mjs`: the look checks of the probes (P4, `@margoengine/headless/look`): `look.md`, `look.json`, `look.png`.
  Each probe in manifest.json carries `light`, the light its frame was shaded with (driver.js `light()`: core's sun and
  the sky's `irradiance()` on level ground, else `lighting.ambient` x `radiance[3]`), so T6 takes its limits from it.
- `encode.mjs`: the master MP4 and its checks (P3); `colour.mjs` (sRGB to CIELAB, CIEDE2000, fine detail) and
  `mp4.mjs` (box order and the `colr` box) for them.
- `queue.mjs`: the render queue (`submit`, `run`; a runner whose code changed under it exits for a fresh one,
  and one whose task was ended exits too);
  `runner-task.ps1` registers its "Margo Shot Runner" task.
- `platform.mjs`: the browser per platform and the output folders.
- `shots/`: shot files. `storm-light-tour.json` is the Storm Light tour as a camera track; `orrery-dolly.json` an 8 s
  dolly in to the Orrery at one MSAA sample (its glass dome is not byte-repeatable at 4x on NVIDIA);
  `orrery-orbit.json` a 60 s orbit round it as long-video footage (`kind: "long"`, 1920 x 1080 at 30 fps).
- `test/`: `npm run test:shot` (WebGPU) renders `test/scene.html` twice and checks the clock, the seed, that a
  page reading `crypto.getRandomValues` fails the check, and the masks (geometry and depth from the page, sky and
  water worked out by the tool), a mask that differs between renders failing it too, and each probe's view-projection.
  `tests/shot-file.test.js` checks the format and `tests/shot-look.test.js` the look checks, with no GPU.

## Making a page shootable

Any page of the repository that draws with an engine works as it is. The shot names the page and its URL options,
CSS that hides the page's text and controls and lets the canvas fill the window, and a dotted path to the engine
(`stormLight.engine`). For scene changes beyond the camera, the page may expose a function, named by `page.apply`,
that takes the evaluated cutscene state. For masks (`shot.aovs`), it exposes a function named by `page.aovs` that
returns `{device, textures: {name: GPUTexture}}`, for example `SceneTargets` outputs; the tool works out `sky` and
`water` itself from `geometry` and `shot.horizon`. A page must draw from its frame loop and the clock it is given: anything
timed by `setTimeout`, workers or other sources the tool does not control fails the determinism check.
