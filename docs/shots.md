# Shots: offline frames for the shorts

`tools/shot` renders a scene offline, frame by frame, for the vertical shorts: 1080 x 1920 at 60 frames per second
by default, on the shot's own clock, so a slow machine gives the same frames as a fast one. Every shot renders twice
and the two renders must be identical, frame for frame. It writes PNG frames and a manifest; encoding them to an MP4
master is the next step (P2 accumulation and P3 masters in the shorts plan). How to run it: `tools/shot/README.md`.

It works on any page of the repository that draws with an engine, with no change to the page: the shot names the
page, its URL options, CSS for a clean frame and where the page keeps its engine. Nothing in it is specific to one
demo.

## The shot file

One JSON file per short. It is a cutscene document of `@margoengine/cutscene` (`format`, `version`, `duration`,
`tracks`, `markers`, `timelines`) with a `shot` header beside them, so the cutscene editor and player open it as they
are. The tracks drive the shot: the first camera track moves the page's engine camera each frame, and the whole
evaluated state goes to the page's `apply` hook when it has one.

| Header field | Default | Meaning |
| --- | --- | --- |
| `format`, `version` | required | `"margo-shot"`, `1` |
| `id` | required | Lower-case letters, digits and dashes; names the output folder and the master file |
| `kind` | `"short"` | What the shot is for: `"short"`, a vertical short, or `"long"`, footage for a long video. It sets the defaults of `size` and `fps` and the length limit |
| `seconds` | required | Length of the shot, a whole number of frames: under 60 for a short (a short is under a minute), under 1,200 for a long shot |
| `seed` | 1 | Seeds `Math.random` in the page (a 32-bit whole number) |
| `size` | `[1080, 1920]`; long `[1920, 1080]` | Width and height in pixels; the canvas must come out exactly this size |
| `fps` | 60; long 30 | Frames per second, a whole number. Long footage at 30 fps renders half the frames of 60 fps |
| `from` | 0 | Seconds of pre-roll: drawn on the shot clock and not kept, so the page's clock and the cutscene's agree |
| `tier` | `"high"` | The quality tier forced on the page (`?quality=` of `@margoengine/quality`): `high` or `low` |
| `msaa` | `null` | MSAA samples of the page's scene passes, 1 or 4, whatever the tier chooses; `null` keeps the tier's own (4 on `high`, 1 on `low`). See Capture |
| `supersample` | 1.5 | The canvas renders at `size` times this (1 to 2; 1620 x 2880 for a vertical short) and each frame is taken down to `size` in linear light. See Capture |
| `subframes`, `shutter` | 1, 0 | Sub-frames averaged into each kept frame, spread over a shutter of `shutter` degrees of the frame interval (P2). See Capture |
| `warmup` | 60 | Frames drawn at the first instant before frame 0, the clock held still: pipelines compile, TAA and other temporal passes settle |
| `probes` | `{}` | Named still frames, name: seconds; each is written to `probes/<name>.png`, goes on the contact sheet and gets the look checks (see Look checks) |
| `lookBounds` | `{}` | Bounds of the look checks, check name: a number (the highest) or `[low, high]`; a check left out keeps its default (see Look checks) |
| `lookFamily` | `null` | A look family of `@margoengine/headless/look` (`natural`, `animatedFeature`): its bounds apply to every check the probes can run, under `lookBounds`, which still win by name (see Look checks) |
| `probeLookBounds` | `{}` | A probe's own bounds, probe name: {check name: bound}; on that probe they replace `lookBounds` for the checks they name (see Bounds) |
| `aovs` | `[]` | Masks written beside every frame (see Masks): names the page gives through `page.aovs`, and `sky` and `water`, which the tool works out |
| `horizon` | `null` | `{y}`: the world height of the water plane that splits `sky` from `water`; needed for either |
| `moving` | `null` | `{depthScale}`: each probe also writes the frame after it and the camera's motion to it (see Moving evidence); `depthScale` is the metres of the page's `depth` mask, which holds exp(-distance / depthScale); needs `depth` in `aovs`, a camera track and probes before the last frame |
| `kit`, `grade`, `endCard` | `null` | Carried in the manifest for the steps that use them: scene kits (P5), the grade (P3) and the end card (P6) |
| `page.path` | required | The page to render, from the top of the repository (served by the repository's Vite dev server) |
| `page.query` | `{}` | URL options for the page (`quality` comes from `tier`) |
| `page.css` | `""` | CSS added before the page's own code runs: hide the page's text and controls, make the canvas fill the window |
| `page.engine` | required | Where the page keeps its engine, as a dotted path from `globalThis` (for example `stormLight.engine`); names only, never code |
| `page.apply` | none | A function in the page, dotted path, called with the evaluated cutscene state and `{ time, kept }` before each frame |
| `page.aovs` | none | A function in the page, dotted path, that returns `{device, textures: {name: GPUTexture}}` for the masks it draws; needed when `aovs` is set |
| `page.ready` | none | A CSS selector that must match after the warm-up, or the shot fails asking for more warm-up |
| `page.canvas` | `"canvas"` | The canvas to copy |

`tests/shot-file.test.js` and `tests/shot-capture.test.js` check every rule; `node tools/shot/cli.mjs <file> --check`
checks one file. `tools/shot/shots/storm-light-tour.json` is the Storm Light tour as a camera track, and
`orrery-dolly.json` an 8 second dolly in to the Orrery's dome at one MSAA sample.

## The shot clock

The tool installs a driver (`tools/shot/driver.js`) in the page before any of the page's own code runs:

- `requestAnimationFrame` callbacks wait in a queue that the tool runs once per frame, each told the frame's time.
  `performance.now()`, `Date.now()` and `new Date()` read the same time. Frame `i` is at `1000 + i * 1000 / fps` ms
  (2026-01-01 for `Date`); the warm-up frames all read the first instant, so the engine's frame step is 0 there.
- `Math.random` is a seeded generator (mulberry32) from the shot's `seed`.
- Work the page starts on the GPU or the network (buffer maps, background pipeline compiles, queue fences, fetches,
  image decodes) is tracked, and after every frame the tool waits until it has all settled, together with what it
  started in turn. A readback started in frame N is always delivered before frame N + 1, and a pipeline asked for in
  frame N is always ready by then, however fast the machine is.
- The canvas is copied in the same task it was drawn in, over black, before the browser presents it. A WebGPU canvas
  is read from its own texture on the GPU (the driver adds `COPY_SRC` to the page's canvas configuration; formats
  `bgra8unorm`, `rgba8unorm` and `rgba16float`, the last clamped to 0 to 1), so a frame never depends on the
  browser compositing the canvas; other canvases (WebGL2) are copied with `drawImage`. `manifest.capture` says
  which (`gpu` or `2d`).

So the frames depend only on the page, the shot file and the machine's GPU and browser. What the driver cannot
control, a page or package must not use for anything it draws: `crypto.getRandomValues`, `setTimeout` or
`setInterval` timing, worker timing, the order atomics finish in on the GPU. The determinism check finds them.

## Capture: MSAA, supersampling, sub-frames and the dither (P2)

The default capture is one render per kept frame at 1.5x supersampling, with whatever motion blur and TAA the page
draws itself; sub-frame accumulation is for the shots that need it (fast sparks, spinning detail).

- **MSAA.** `msaa` forces the scene's samples. Core draws one sample when `globalThis.margoLow` (the light tier's
  pixel-ratio cap) is set and four when it is not, and `@margoengine/quality` sets or deletes it for the tier before
  the engine is made. The driver puts an accessor for it on the window's prototype, which answers every read whatever
  the page sets or deletes, so the count holds from the engine's creation on; the browser's pixel ratio is 1, so a cap
  of 1 changes no size. The render fails if the page draws another count than the shot's (`manifest.render.samples`
  is what core read). Use one sample for a scene with BLEND glass on NVIDIA: 4x MSAA there is not byte-repeatable
  between renders (KB5700f, KB1824, docs/limits.md), and the Orrery's dome is such glass.
- **Supersampling.** The window, so the canvas that fills it, is `size` times `supersample`, each side rounded, at a
  pixel ratio of 1. Each frame is taken down to `size` by the area filter (each output pixel takes every canvas pixel
  by the share of it inside its footprint; Wolberg 1990) in linear light, so a black and white pair makes sRGB 188,
  not 128. Masks are made at the canvas size, `sky` and `water` included, and taken down the same way, so an edge
  pixel of a mask holds the share it covers. Effects sized in pixels (bloom and depth of field radii) see the larger
  canvas.
- **Sub-frames.** With `subframes` N above 1, each kept frame at time t draws N sub-frames at
  t + (k + 0.5) / N x `shutter` / 360 / `fps` for k = 0 to N - 1, the GPU settled between them, and averages them in
  linear light: one mechanism gives motion blur over the open shutter and averages sub-pixel detail (the
  accumulation buffer of Haeberli and Akeley, SIGGRAPH 1990). With `shutter` 0 the sub-frames share the frame's time
  and average only what changes between draws, such as TAA's jitter. Pre-roll frames draw once.
- **One 8-bit encode with a blue-noise dither.** The mean is encoded to sRGB (IEC 61966-2-1) once, adding a dither
  of under half a level from a 64 x 64 blue-noise array made by the void-and-cluster method (Ulichney 1993; blue noise
  for dithering, Ulichney 1988), each colour channel at its own offset in the tile, so slow gradients such as night
  skies keep their mean without bands. An exact 8-bit level never moves. One sub-frame of an 8-bit canvas at the
  shot's own size (`supersample` 1) is kept as its bytes are; `rgba16float` canvases always go through the encode.

`manifest.render` records the canvas size, the supersampling, the samples core read, the sub-frames, the shutter, the
filter and the dither. The maths is `tools/shot/pixels.js`, the same functions in Node (`tests/shot-capture.test.js`)
and in the page (installed by `pixel-script.mjs`). `npm run test:shot` checks a shot that forces one sample over the
high tier, supersamples 2x and averages four sub-frames over a 180 degree shutter: the page's own `sceneSamples()`
reads 1, the canvas is twice the size, every sub-frame lands on its clock time and two renders are identical.

## Moving evidence (shot.moving)

`shimmerMoving` (T4) and `motionBlur` (T8) need the frame after the probe and each pixel's motion to it. With
`"moving": {"depthScale": 200}` each probe writes `probes/<name>.next.png` (the next kept frame, already rendered, so
nothing is drawn twice) and `probes/<name>.motion.f32` (little-endian float32, x then y per pixel, the frame's size), and
the manifest probe gets `moving: {next, motion}`, which `checkShot` reads. The motion is the camera's alone, the world
held still: the page's `depth` mask (8-bit grey, exp(-distance / depthScale), 0 where nothing is drawn) gives each pixel's
distance, `depthFromDistance` walks it along the pixel's ray from the probe's eye (the last sub-frame's camera) to a
world point and projects it, and `reprojectionMotion` takes that point through the next frame's view-projection. A pixel
with no geometry that the `water` mask marks takes the distance to the sea plane (`horizon.y`); any other is a sky
5,000 m away. Rain, sea and cloud change between two frames on their own, so the check keeps a residue there:
`tools/shot/test/moving-check.mjs` (in `npm run test:shot`) renders the Storm Light tour at 270 x 480 with a fast camera
(12.7 px mean motion) and finds 11.2 % of pixels off by over 6 codes warped against 36.1 % unwarped. The depth mask is
8-bit and area filtered with the frame, so a pixel on a silhouette edge mixes its distance with the background's.

## Look masks (penumbra, subject, lit, shadow)

The other masks the clean-frame checks read are page masks by name: list `penumbra`, `subject`, `lit` and `shadow` in
`aovs` and give their textures through `page.aovs`. `SceneTargets` (`@margoengine/post/mrt`) draws them from the sun's
shadow visibility: outputs `{penumbra: 'penumbra', lit: 'litGround', shadow: 'shadedGround', subject: 'subject'}`,
with the subject model added as `targets.add(model, {subject: true})` (its README, "Sun light and the look masks",
has the limits). `penumbra` feeds `penumbra` (T1 grain in soft shadow edges), `subject` feeds `silhouette` and
`silhouetteShape` (T5), and `lit` with `shadow` feed `bounce` and `shadowTint` (T6). `tools/shot/test/look-masks-check.mjs`
(in `npm run test:shot`) renders the test scene with `?aov=look` (Shadows on every mesh, a gltf box as the subject) at
480 x 270 with the moving evidence, and every one of those checks and `shimmerMoving` and `motionBlur` runs on the
shot's own masks: 70,136 lit, 3,476 shaded, 1,773 penumbra and 1,826 subject pixels, the frame darker inside the
shadow mask. Measured there (RTX A6000, supersample 1, default soft shadows and core lighting, no family look applied):
penumbra grain 1.78 codes (animatedFeature bound 0.7), silhouette 37.2 % (80), silhouetteShape 76.6 % (70), bounce
8.85 % (10 to 35) and shadowTint 0.20 b* (at least 3). They are the default look of a test scene, judged on a whole
film's frames, not tuned here. The Storm Light page gives none of these masks yet. A mask that marks no pixel names nothing to
measure (a landscape with no subject in frame, no shadow edge or no shaded ground), so its checks do not run: a shot
that names one of them fails it as missing (`subject pixels (the subject mask is empty)`), and no family bound fails it
(KB-LOOK-EMPTYMASK1; before, an empty subject mask read silhouette 0 % and an empty penumbra mask 0 codes of grain).

`packages/scenes/test/timber-valley-shot.html` is the shot page of the catalogue scene `timber-valley`: its URL takes the
scene's catalogue settings, it gives `geometry`, `depth` (nearness exp(-distance / 2000 m)) and the four look masks
(the terrain added to `SceneTargets`), its `apply` drives the scene's own clock (fire, sky, weather) and its `settings`
writes per-shot rows. `tools/shot/shots/timber-valley-*.json` are the scene's eight shots from `shotFilesFromScene` with
that page. The scene has no subject yet, so its subject mask is empty and the T5 checks do not run on it.

## The determinism check (P8)

Every shot renders twice in one browser, the page loaded fresh each time, and the SHA-256 of each frame's RGBA bytes
must match. A difference fails the shot naming the first frame that differs and how many do, and writes up to three
of the second render's copies to `mismatch/frame_NNNN.b.png` beside `frames/frame_NNNN.png`. A package that reads
the wall clock or orders by an atomic is a bug for its owner, fixed there with a regression test, never by loosening
the check. `npm run test:shot` proves the check catches a page that reads `crypto.getRandomValues`.

Identical frames are expected across two renders on one machine, browser and driver, not across different GPUs.

## Production renders

`--production` (`cli.mjs`, or `queue.mjs submit --production`) is the mode for footage that goes into a video: the
shot renders once in full, frames, masks, probes and look checks as always, and a second render checks the probe
frames only. That second render still draws every frame up to the last probe, each with its sub-frames, because the
page's history (TAA, anything stepped each frame) decides how a probe looks; it reads back, filters and hashes only
the probes and stops after the last one. `manifest.determinism` is then `{runs: 2, check: "probes", checked: [the
probe frames], identical}`, and a probe that differs fails the render as before, naming its frame. A production
render needs probes; one near the end makes the check cover the whole shot. The full double render stays the default
and is what tests and new shots use: a page that goes wrong only between probes is caught there.

`npm run test:shot` (case 6) checks a production render of the test scene: probes 0 and 24 identical, the second
render drawing the warm-up and frames 0 to 24 only, and a page reading `crypto.getRandomValues` still failing on a
probe frame.

## Masks (AOVs)

A shot that lists `aovs` writes one 8-bit grey PNG per mask beside every kept frame, `aovs/<name>/frame_NNNN.png`,
for the look checks (P4): sky clipping is measured inside the sky mask, foam edges inside the foam mask, seams along
the water line. Masks are part of the determinism check: each mask's grey bytes are hashed, and a mask that differs
between the two renders fails the shot (`difference.reason` `"aovs"`, naming the mask) even when the frames match.

- **Page masks.** After each kept frame the tool calls the page's `page.aovs` function, which returns the GPU device
  and a texture per mask, for example `SceneTargets` outputs of `@margoengine/post/mrt`. The tool reads each
  texture's first channel (or its depth, for a depth format) with a blit of its own into an r32float texture, so any
  single-sample 2D float, normalised or depth texture with `TEXTURE_BINDING` usage works, and maps 0 to 1 onto 0 to
  255 (NaN and below 0 are 0). Row 0 is the top of the frame, as in the frame PNGs.
- **`geometry`** is the page's mask of drawn surfaces (1 where a surface is drawn). The sky and water masks need it.
- **`sky` and `water`** are worked out by the tool: a pixel with no geometry (below 128) is `water` when the view
  ray through its centre, from the engine's camera (a perspective camera, vertical `fov` in degrees), meets the plane
  y = `horizon.y` in front of the camera, and `sky` when it does not. Sky, water and geometry split every pixel
  exactly once. The plane is flat: a wave crest above the mean level that hides the sky near the horizon counts as
  sky, which shows in the look checks as a few rows at the horizon at most in a heavy sea.
- **`depth`** and other masks are whatever the page writes; Storm Light's is nearness, exp(-distance / 200) over its
  geometry (1 at the eye, 0 where none is drawn).

Storm Light (`?aovs=1`) gives `geometry` (headland, lighthouse and boat above the sea; rock under the sea counts as
water, since the sea covers it) and `depth` from one `SceneTargets` pass, so its tour shot writes `geometry`,
`depth`, `sky` and `water`. A `foam` mask needs `@margoengine/water` to hand out the foam it draws (its per-view
foam history is private today), recorded in `docs/limits.md`.

Each probe also gets its masks, `probes/<name>.<mask>.png`, and each frame record in the manifest gets `aovs`:
name to `{file, sha256, mean}`, where `mean` is the share of the frame the mask covers (0 to 1).

- **`sky-coverage`** is the sky's own record of where it drew (KB-HEARTH-CLIP1). A shot with probes and no `sky` mask
  switches on `coverage` on the page engine's sky (`@margoengine/sky`, the scene plugin with a `coverageTexture`)
  before its frames are drawn, and reads that texture after each probe frame like a page mask: 1 where the sky shows,
  0 where geometry is in front of it. It is the sky's full-screen draw repeated against the frame's depth with the
  same test, so it holds under a PostStack, which draws the scene into a depth of its own (a view target's depth read
  100 % sky on cabin-window-snow, so that approach was dropped). The frames do not change. Only the probes carry it
  (`probes/<name>.sky-coverage.png` and the probe frame's `aovs`), it is part of the determinism check, and the
  manifest's `skyCoverage` says whether the probes have it. A page with no such sky gets none, and a shot file may not
  list `sky-coverage` itself. Measured on the RTX A6000 (1080 x 1920, 1.5x): cabin-window-snow's sky is 18.1, 15.0
  and 11.6 % of the frame at open, mid and close; the cabin-hearth-kettle probes have no sky in view (0 sky pixels).
  It covers what the sky draws, not what is drawn over it afterwards without depth (snow flakes, glass), and pixel
  gaps in a mesh show as sky because the sky does show through them (the cabin's log seams, seen through its window). `npm run test:shot` checks it on the test scene
  (case 7: the exact complement of the page's geometry mask, the same on both renders) and on the three real shots at
  270 x 480 (tools/shot/test/sky-coverage-check.mjs); `node packages/sky/test/features-check.mjs coverage` checks the
  record itself under a PostStack, WebGPU and the compat layer.

## Scene settings per shot

A shot header may name a catalogue scene and its own settings, so each shot has per-shot control of every package look (Scott, 2026-11-17: "I want to keep per shot control"). `shot.scene` is a name from `@margoengine/scenes`; `shot.settings` is `{target: {row: value | {keys: [{time, value, ease}]}}}`. A target is a name from the scene's `info.targets`, bound to one package settings entry (`weather` to `@margoengine/weather/settings`; an entry that exports more than one `*_SETTINGS` table gives the one named after its package, `WEATHER_SETTINGS` here; write `entry#NAME` for another), and the rows are that package's own, so nothing is copied. A plain value holds for the whole shot; keys are at shot seconds (the shot's own clock starts at `shot.from`) and move a number through the key's ease (`linear`, `in`, `out`, `inOut`), a colour per channel in linear RGB, a gradient stop by stop when both keys have the same stops; a choice, a null and a gradient with other stops step at each key; before the first key and after the last the nearest key holds. Only `live` rows can be keyed; a row that is not live may only be held (its value goes in with the first frame, in the warm-up). `shot.page.settings` names the page function (`margoShot.settings(values, {time, kept})`) that writes `values` through each package's own apply function before `page.apply` each sub-frame, so a row left out is the scene's look and a cut starts the next shot from it again.

`node tools/shot/cli.mjs <shot> --check` and every render check the block first, with the packages' own rules (`checkShotSettings` of `@margoengine/scenes/shot-settings`) against the shot's own length, and refuse with the target and row named: an unknown scene, target or row, a value out of range, a null on a row that is not nullable, a keyed row that is not live, key times that do not rise or leave the shot, an unknown ease. `--seconds` renders the first seconds of a shot and keeps its authored length as `shot.fullSeconds` (`firstSeconds` in `tools/shot/shot-file.mjs`), so the keys are checked against the whole shot and a key past the cut still shapes the rows before it (KB-SHOT-SECONDS-KEYS1; before, a shot keyed past the cut refused). `shotFilesFromScene(info, {page, tracks})` in `tools/shot/scene-settings.mjs` writes one shot file per entry of `info.shots` (length, settings, id), around the camera tracks the caller gives, so a shot is authored once. The per-frame writes on the GPU (cuts, seeks, frame rates, a set row surviving a weather drive) are the scenes plan's push 15.

## Look checks (P4)

After a render whose shot names probes, the tool runs the look checks of `@margoengine/headless/look`
(`tools/shot/look.mjs`, `checkShot`) on each probe: its frame, its masks and the camera core drew it with, against the
shot's `lookBounds`, under the bounds of its `lookFamily` when it names one (`animatedFeature` holds the T1 to T8 clean-frame bounds; a probe can also carry `moving: {next, motion}` for the moving-camera checks, which `shot.moving` makes the tool write, see Moving evidence: packages/headless/README.md, Look checks, lists every check, its unit and default bound). It
writes beside `manifest.json`:

- `look.md`: the table, failures first, one row per probe and check (value, bound, pass).
- `look.json`: the same as data (`format: "margo-look-report"`, `pass`, `probes[].results`).
- `look.png`: a contact sheet of the probes, each framed green or red and labelled with what failed.

Each failing check also prints one line, `look check failed: <probe> <check>: <value> <unit>, bound <low> to <high>`.
A failed look check exits 3 (the frames and the master are kept, for a look by eye); a failed render or master still
exits 1. A check named in `lookBounds` that does not exist, or whose input the tool does not write, fails naming
what it needs. The shot file check refuses both before a render starts: an unknown name, and `nan`, whose float frame
the tool does not write (the Cabin Hearth shots asked for it and failed every probe of all five renders).

- **Camera.** Each probe frame records `viewProjection`, the column-major view-projection core computed for that
  frame at the canvas's aspect (WebGPU depth), in `manifest.probes.<name>`, so `horizonSeam` measures the step at the
  analytic horizon where the `sky` mask meets it (with no sky mask the check is left out: an interior's line runs
  across walls, and Cabin Hearth's mantel read as a 15.8-code seam until 2026-11-14). A shot that averages sub-frames records the last sub-frame's. `npm run test:shot` checks it equals
  the matrix a core `Camera` makes from the cutscene's camera at the probe's time.
- **Masks.** `sky` limits `skyClip`, `grain` and `lights` to the sky and gives `horizonSeam` its columns, and `water` gives `waterSeam` its line. A
  sky mask with no sky in view passes those checks and says so: `pass (measured 0 sky pixels)` in look.md and
  `empty` in look.json. Without a page sky mask `skyClip` measures inside `sky-coverage` when the probe has it, and
  the whole frame when it does not; `grain`, `lights` and `horizonSeam` never read `sky-coverage`. look.md lists under
  its table which mask each probe's `skyClip` measured inside (`sky`, `sky-coverage` or the whole frame), and each
  look.json row has it as `mask`. cabin-hearth-kettle failed `skyClip` 0.5 at every probe over the whole frame (1.29,
  2.16 and 4.78 %: the flames and the kettle's glint) and passes inside its coverage, which holds 0 sky pixels; the
  orrery has no sky, so its rows are unchanged (`skyClip` 0.651, 1.59 and 1.94 %, `lights` 2, 5 and 9). No
  `dark`, `foam`, still, float, compat or reference input is written yet, so `crush` counts the whole frame and those
  other checks are left out (docs/limits.md, Look checks).
- **Bounds.** A shot sets its bounds from its own measured probes, never by guesswork. `orrery-dolly.json` has no
  masks, so its checks read the whole frame: measured on the RTX A6000 (a182e4465), the sun lamp clips 0.65, 1.60 and
  1.94 % of the frame at open, mid and close (`skyClip` 2), the lamp and the lit planets count 2, 5 and 9 discs
  (`lights` [2, 9]) and the unlit ceiling corner at open is 4.07 % black (`crush` 4.1); the other checks pass at
  their defaults (`horizonSeam` measured 0 to 0.51 codes before it needed the sky mask; with no mask it is now left
  out). The Cabin Hearth shots that look into the room (`cabin-push-in`,
  `cabin-hearth-kettle`, `cabin-long-hearth`, `-kettle` and `-through`) count three intended lights, the window
  lantern, the fire and the kettle's glint (3 discs on the push-in's window, through and hearth probes on the A6000),
  so their `lights` bound is [0, 3]. A bound that holds for some probes only goes in `probeLookBounds`, under the
  probe's name; it replaces the shot's bound for that check on that probe, and the other probes keep the shot's.
  Storm Light's tour counts its real lit windows, lamps and lantern: `lights` [2, 4] on climb and west, [1, 4] on
  gallery (one lantern through a lattice), which face them, and [0, 0] on open and strike, which look away from them (0 discs each); one shot-wide [0, 4] would
  let a lost lamp pass. Its other checks keep their defaults. Measured on the RTX A6000 (2026-11-16, with the far-air
  fog): climb 4, west 3 and gallery 1 disc. The gallery's one is the lantern seen through the lantern room's lattice;
  the render before the far-air fog counted 2 there because a lattice bar cut the same glow into two parts (the crops
  are the same to the eye), so the gallery's bound is [1, 4] (coordinator ruling, 2026-11-16 03:15); the shot file
  carries the reason in `probeLookBoundsReason`.

`tests/shot-look.test.js` runs `look.mjs` on made-up probes with no browser: the three files, a crushed flat probe
failing by default and passing once `lookBounds` widens it, the horizon check from a view-projection and an unknown
check name failing, and a probe's own `lookBounds` replacing the shot's for the checks it names on that probe only.

## Limits

A shot renders from its first frame to its last in one run: nothing pauses it and no option limits its time. The queue runner ends a job only as hung, after 12 hours, with its child processes. Each captured frame writes `progress-a.json` and `progress-b.json`, so a render that crashed or hung can be run again with the same command and goes on from its last captured frame. Waiting for a free page has its own limit, and every wait that ends one says what it waited for.

## Output and the hand-off to encoding

Output goes to one folder per day: `<MARGO_SHOT_OUT, else test-results/shots>/<YYYY-MM-DD>/` (`--day` picks the day).
In it:

- `<id>/frames/frame_0000.png` and on: the kept frames at `size`, numbered from 0, 8-bit sRGB, as
  `@margoengine/headless/video`'s `imageSequence` names them.
- `<id>/manifest.json`: `format: "margo-shot-frames"`, the shot header, `size`, `fps`, `seconds`, `frames`, and
  `files` (each frame's `index`, `time`, `file` and `sha256`), the adapter and browser, `determinism`
  (`runs`, `identical`, and `difference` when they were not), `render` (see Capture), `probes` (each `frame`, `file`,
  `aovs` and `viewProjection`), `contact`, `aovs` and `output`.
- `<id>/look.md`, `look.json` and `look.png`: the look checks of the probes (see Look checks).
- `<id>/aovs/<name>/frame_0000.png` and on: the masks of each frame (see Masks), when the shot lists `aovs`.
- `<id>/probes/<name>.png` and `<id>/contact.png`: the probe frames, and a sheet of them at a quarter size (eight
  frames spread over the shot when it names no probes).

The encoder (P3, below) reads `manifest.json`, encodes `files` in order at `fps`, and writes `output.master`
(`<id>.mp4`) in the day's folder: vertical, under 60 s, with no audio track (`output.audio` is false). The variation
system writes `output.caption` (`<id>.txt`: title, caption, hashtags) beside it.

## Master encode, colour and checks (P3)

`node tools/shot/encode.mjs <frames folder>` (or `cli.mjs ... --encode` right after the render) makes the master with
the ffmpeg the machine has, kept outside the repository (`MARGO_FFMPEG`, else `ffmpeg` on the PATH; ffprobe is the
one beside it), and writes its report to `<frames folder>/encode.json`. It refuses a render whose determinism check
failed. The grade is not the encoder's: AgX and the kit's `Grade` run in the page (`@margoengine/tonemap`).

- **The master.** H.264 High in MP4, 1080 x 1920 at the shot's fps, `-crf 12` (near visually lossless; a busy
  short comes out at tens of Mbps), the rest of YouTube's recommended upload settings (YouTube Help, "Recommended upload encoding settings":
  support.google.com/youtube/answer/1722171): progressive, CABAC, a closed GOP of half the frame rate (30 frames for the
  60 fps shorts, 15 for 30 fps long footage; `gopFrames(fps)`) with no extra keyframes at scene cuts, 2 consecutive
  B-frames (`-bf 2`), 4:2:0, no audio track in the master, moov before mdat (`+faststart`). The final edited upload
  carries AAC-LC audio at 48 kHz stereo, which the editor adds: the masters are silent. The RGB frames go to Y'CbCr by the BT.709 matrix at limited range, and the frames
  themselves are tagged BT.709 primaries, transfer and matrix (`setparams`): ffmpeg 9 writes the frames' own tags over
  `-color_primaries` and `-color_trc`, which left both unspecified (2) before.
- **Checks** (each `pass` in `encode.json`; any failure exits 1): `stream` (codec, profile, size, 4:2:0, one stream);
  `tags` (ffprobe: tv range, BT.709 matrix, transfer and primaries); `colr` (the MP4's own `colr` nclx box read by
  `tools/shot/mp4.mjs`: 1, 1, 1, limited range); `faststart` (moov before mdat); `gop` (read back with ffprobe: a keyframe exactly every fps / 2 frames, no more than 2
  B-frames in a row and some present, and the x264 settings string in the stream saying `bframes=2`, `keyint` of fps / 2
  and `open_gop=0`, so closed); `frames` (the decoded frame count, the
  rate `fps/1` and the duration exactly frames / fps); `chart` (a colour chart of 43 flat patches over the RGB cube,
  greys and primaries, encoded with the same settings and decoded back by the BT.709 matrix: mean CIEDE2000 inside the
  patches under 1, so a washed-out or range-shifted encode fails). Sampled frames (the probes and eight spread over the
  shot) are decoded back and compared with their PNGs too (`frameDeltaE`, mean and largest CIEDE2000).
- **Platform proxy check.** The master is re-encoded at 8 and 3 Mbps, what the platforms deliver, and each sampled
  frame's fine detail (the Laplacian of its luma) is projected on the master's: `proxy[].detailKept`, 1 for all of
  it. A frame keeping under half at either rate is listed in `proxyFlags` (rain thinner than 2 pixels, single-pixel
  sparks, fine foam) for a look before upload; it does not fail the master. A shot that names a `lookFamily` is held to
  the family's floor (`detailKeptFloor` of `@margoengine/headless/look`: 0.6 for `animatedFeature`) and fails the master
  with a `detailKept` check when a frame keeps less at either rate (T7). Projection, not energy: blocking and
  ringing a re-encode adds would otherwise count as detail.

`npm run test:shot-encode` encodes 70 made-up frames (a night gradient with moving single-pixel sparks) and needs every
check to pass and the sparks to be flagged at 3 Mbps; it fails, never skips, without ffmpeg.
`tests/shot-encode.test.js` checks CIEDE2000 against the published test pairs, the MP4 reader, the arguments and that the
GOP read-back fails the old settings (a GOP of 30 at 30 fps, x264's 3 B-frames, none at all).

## Render queue (the dev PC)

Over SSH on Windows the browser starts in session 0, the Services session with no desktop, where Edge now and then gets
no WebGPU adapter (docs/known-bugs.md). Such a launch fails with code `no-webgpu-adapter` and reason
`windows-session-0`, which names the session. The queue runs renders in the signed-in desktop session instead:

- `node tools/shot/queue.mjs submit tools/shot/shots/orrery-dolly.json --encode` (on the Beelink) writes a job and
  copies it into the dev PC's queue, the render checkout's `.lane/queue` there, over `scp` to the SSH host `dev`
  (`--host` picks another). `--remote` names the queue folder on that machine, default the
  `MARGO_SHOT_REMOTE_QUEUE` environment variable, so no machine's folders are written into the repository; with
  neither, submit stops before copying. Options: `--seconds` (under 1,200), `--day`, `--once` or `--production`
  (see Production renders), `--encode`.
- The runner, `node tools/shot/queue.mjs run --watch --queue <dir>`, takes jobs one at a
  time in name order: it moves a job to `running/`, runs the shot tool under a 12 hour hang limit, and
  writes `logs/<job>.log` and the outcome to `done/<job>.json` or `failed/<job>.json` (exit code, minutes; a failed
  look check, code 3, lands in `failed/` with its frames, `look.md` and master kept). Frames and
  masters go where the shot tool writes them. One runner per queue (`runner.pid`).
- The runner never runs a job on stale code. At its start it takes a stamp of its own code: a SHA-256 over every
  `.mjs` and `.js` file of `tools/shot` and the checkout's commit (`git rev-parse HEAD`). Before it claims each job,
  and at every poll, it takes the stamp again; once it differs (the checkout moved, or a file was edited) it claims
  nothing more, logs "the runner's code changed", removes its `runner.pid` and exits, and the scheduled task starts a
  runner on the new code within 5 minutes. A job that is running when the checkout moves finishes on the code it
  started with; the next job waits in the queue for the new runner. The bug this closes: on 2026-11-14 the dev PC's
  runner, started before the production mode landed, failed every `--production` job with "production is not a job
  field" after its checkout had moved on.
  Why exit and restart rather than a fresh child process per job: each job's shot tool is already a new process, but
  the runner itself (the queue walk, the claim, the job check, the hard limit and the outcome records) would still be
  the code it loaded at its start, so any change there would stay stale. An exit leaves no runner code behind; the
  cost is a wait of up to 5 minutes after a move, while the queue keeps its jobs.
  What starts the next runner: the task's second trigger, a time trigger that repeats every 5 minutes with no end
  (`runner-task.ps1`, the `$again` trigger, `-RepetitionInterval 5 minutes`; in the task's XML a `TimeTrigger` with
  `<Repetition><Interval>PT5M</Interval>` and no `<Duration>`). `schtasks /Query /V` lists the logon trigger first
  ("Repeat: Every: N/A") and this one second ("Repeat: Every: 0 Hour(s), 5 Minute(s)"). While a runner runs, a start
  is ignored (`MultipleInstances IgnoreNew`); once it has exited, the next 5-minute start runs a new one.
- The runner exits when the task is ended. `schtasks /End` (or Task Scheduler's End) ends only the process the task
  started, the PowerShell wrapper, and Windows leaves the node runner under it running on its own: on 2026-11-14 the
  dev PC's runner (pid 47156) outlived its ended task, and its `runner.pid` turned away the runner the next start
  made. The runner therefore checks every 5 seconds that the process that started it still runs; once it is gone it
  ends a running job's shot and browser (the job lands in `failed/` with `stopped: true`), claims nothing more,
  removes its `runner.pid` and exits. A runner started by hand from a shell ends with that shell the same way.
- `tools/shot/runner-task.ps1 -User <domain\name> [-FFmpeg <ffmpeg.exe>]` registers the scheduled task "Margo Shot
  Runner": at that user's logon, and every 5 minutes while they stay signed in, it starts the runner in their session
  (a second start while one runs is ignored). Logon type Interactive: it runs only while the user is signed in and
  stores no password. Naming another account than your own needs an administrator. `-Remove` removes it.

`tests/shot-queue.test.js` runs the queue with a stand-in shot tool: done, failed, malformed and timed-out
jobs, name order, the single runner, and a runner whose code changed under it (while a job ran, or while idle in
`--watch`) claiming nothing more and exiting, and a runner whose wrapper was ended alone (as `schtasks /End` does)
stopping its job and exiting.

## Platforms

The tool runs on Windows and macOS with the repository's Playwright: Edge on Windows (Chrome with
`MARGO_BROWSER=chrome`), Chrome on macOS, Playwright's Chromium elsewhere; `MARGO_BROWSER` or `--browser=` picks
another (`tools/shot/platform.mjs`). Paths and cleanup use Node only, no shell.

Over SSH on Windows (the dev PC's render runs) the browser starts in a session with no desktop. There Edge gets no
WebGPU adapter unless its GPU process runs outside the sandbox: set `BROWSER_ARGS=["--disable-gpu-sandbox"]` for the
run (`scripts/browser.js` reads it). The GPU then draws normally, but the composited canvas reads back black, which
is why WebGPU frames are read from the canvas texture.
