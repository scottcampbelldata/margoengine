# Cabin Hearth

A snowbound log cabin at night. Snow falls past one warm lit window; inside, a fire burns in a stone hearth and a
copper kettle steams on its trivet. Cold outside, warm inside, live in WebGPU. Open `examples/cabin-hearth/index.html`
with the repository's Vite dev server.

## What it shows

- **One kit.** Every value that sets the look comes from `snowNight` (`@margoengine/sky/scene-kits`): the sky, the
  snowfall, the snow cover, the fog, the fire and its light, bloom and the grade. The page builds the cabin from
  primitives (`@margoengine/geometry`), places the spruces with `createTree` (`@margoengine/procedural/tree`: branch
  whorls in the needles' measured colour, shoots and needle fringes within 30 m of the camera and the same shoots coarse
  beyond, the measured spruce stem and butt flare) and composes the packages; it chooses no look of its own. The snow's
  lens is focused on what the view looks at, so flakes passing close to the camera are soft and faint.
- **Snow.** Flakes fall from `@margoengine/sky/weather`. One top-down cover map (`WeatherFX` captured by
  `PrecipitationCover`, `@margoengine/weather/cover`) holds the roof and chimney, so no flake falls and no snow lies
  inside the cabin, while `Snow` (`@margoengine/weather/snow`) lays 12 cm of drifting snow with depth on the ground,
  the roof, the window sill and the spruces.
- **The window.** The fire's light and a lantern hung behind the window are shadowed point lights
  (`@margoengine/clustered`, shadowed by `LocalShadows` from `@margoengine/clustered/shadows`) flickering on the
  `fire` and `candle` curves; the log walls cast their shadows, so light
  leaves the cabin only through the window and the door's gaps. The fire sits low, so its light leaves upward into the
  froxel fog (`@margoengine/environment/volumetric`). The lantern is a kerosene hurricane lantern's, from
  measurements: a 1,900 K flame giving 82 lm (6.5 cd). It is a winter night and the window has frosted over inside
  (`glazing: 'frosted'`): the frosted pane (`generateWindowPane`, `@margoengine/procedural`) stops the lantern's beam,
  and the frost sends its light out diffusely (`openingLight` and `glazingSurface`, `@margoengine/clustered/area`), so
  the window glows milky and lays a soft warm glow on the snow, with no window-bar lines in it (KB-CABIN-EDGE-SOFT2).
  The glass sits 0.2 m into the wall in four lites, its cross of glazing bars (`lites: [2, 2]`, 45 by 50 mm) in the
  glass's plane, so the bars read dark against the frost; the frost glows brightest just under the lantern and
  dimmest in the far corner, as the lantern's inverse square and cosine give it, with the bars' shadows on it
  (KB-CABIN-FROST2).
  Through clear glass (`glazing=clear`) the lantern's beam falls on the snow as a firelight-orange patch crossed by
  the bars' shadows, running out as its inverse square says (KB-CABIN-LANTERN1).
- **The hearth.** One package call, `Fire.attach` (`@margoengine/vfx/fire`), places the kit's fire on the fuel's
  top: flames, embers and kettle steam as GPU particles (`@margoengine/vfx`) prewarmed so the first frame shows a fire
  already burning, and its light, a flickering 0.62 m flame line of two soft-shadowed sphere lights (0.155 m shadows; each sphere as bright as the flames, so the kettle mirrors the fire and never outshines it) at the
  flames' radiance centroid (`@margoengine/clustered` `lineLights`). The hearthstone and jambs are the `hearthstone`
  preset, the firebox back `soot`, the logs `weatheredWood`, the grate `castIron` and the kettle `tarnishedCopper`
  (`@margoengine/materials/presets`); the page sets no light rig, material tuning or particle settings of its own.
  `npm run test:cabin-hearth` (scripts/cabin-hearth-browser-test.mjs) reads the stone's colour from the frame. Moonlight casts shadows
  (`@margoengine/shadows`); TAA, bloom and AgX finish the frame.

## Views and layers

| URL option | Effect |
| --- | --- |
| `view=outside` (default), `view=hearth` | the lit window from the snow, or the fire and the kettle from the room |
| `debug=wireframe` | every mesh's edges over the shaded scene (`@margoengine/lines`) |
| `debug=layers` | one switch per layer (fog, falling snow, lying snow, fire, steam); each reloads the view with that layer off or back on |
| `fog=0`, `snow=0`, `cover=0`, `fire=0`, `steam=0` | turn one layer off, for before and after views |
| `glazing=clear` | the window as before its glass frosted over: no glass, the lantern's beam on the snow (default frosted) |
| `snowfall=light`, `moderate`, `heavy` | the kit's snowfall (default moderate) |
| `ui=0` | no mouse orbit (the shot tool drives the camera) |

## Shots

`tools/shot/shots/cabin-*.json` render the scene offline for the shorts and the long video (`docs/shots.md`):
`cabin-window-snow` (the lit window in falling snow), `cabin-push-in` (a slow push in through the window to the
hearth), `cabin-hearth-kettle` (the fire and the steaming kettle), `cabin-wireframe` and `cabin-bare` (no snow and no
fog) for the breakdown. The `cabin-long-*` files are long-video footage (`kind: "long"`, 1920 x 1080 at 30 fps, about
6 minutes in all): an establishing dolly, a push to the window and through it, an arc round the hearth, the kettle
close, a wireframe pass, a 60 s orbit, the chimney, a final hold, and six layer views from one camera (all on, then
fog, falling snow, lying snow and fire off, then bare). All use one MSAA sample with 1.5x supersampling, since
particles and fog are in view. Render long footage with `--production`.

```sh
node tools/shot/cli.mjs tools/shot/shots/cabin-window-snow.json
```

## Limits

The fire is particles and a light, not a simulated flame (a gas solver is planned in the shorts plan as N1 to N3), and
the steam is particles, not a fluid. The window's frost is one even layer, frosted over, with no fern patterns or condensation (N14).
Snow has no glints yet (N12) and no blizzard gusts (W10).
