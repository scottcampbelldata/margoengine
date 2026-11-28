# Web demos

These are standalone web exhibits built with the Margo Engine. Each folder is a complete page you can open locally. A zip of the same files sits in `downloads/` if you want to take one exhibit with you.

A live gallery of all 236 exhibits is at [demos.margoengine.com](https://demos.margoengine.com/). This folder is the source for that page.

## Run a demo on your machine

From this `demos` folder:

```sh
npx --yes serve
```

Then open a demo, for example http://localhost:3000/the-orrery/. You can also serve one folder directly:

```sh
npx --yes serve the-orrery
```

Any static file server works. The pages do not need a build step.

## Rebuild a demo from its source

Each folder keeps the code it was built from in `source/`. After changing a demo or an engine package it uses, rebuild it from the repository root (packages built first with `npm run build:packages`):

```sh
node scripts/web-demos/build.mjs newtons-cradle
```

That bundles `source/` against this checkout's packages, replaces `index.html` and the hashed files in `assets/`, and refreshes `downloads/newtons-cradle.zip`. Pass several names, or `--all`. Then refresh the gallery card from the real page:

```sh
node scripts/web-demos/thumbnail.mjs newtons-cradle
```

It waits until the exhibit is marked ready, crops the rendered scene to 900 x 579 and writes `thumbs/newtons-cradle.jpg`. Demos use only engine packages: a simulation, model or effect a demo needs belongs in its package, never in `source/`.

### Keep engine code out of `source/`

`npm run check:demo-sources` (part of `check:merge`) scans every `demos/*/source` and fails on engine code that lives in a demo: shader text or raw GPU use (R1), solvers, time-step updates and physical constants (R2), hand-built mesh arrays (R3), local helpers such as `cross`, `normalize`, `mix`, a seeded random or noise (R4), more than 300 lines of JS (R5), and any import that is not `@margoengine/*`, `margo-demo-status` or a relative path (IMP). When it fails, use the package that owns the code; if no package does, build the gap in the package first. Wiring, UI, layout and content data stay in the demo.

`scripts/web-demos/source-allowlist.json` records today's counts per demo and rule. It is a ratchet: a count never rises, a demo that is not listed starts at zero, and after you move code out of a demo you lower its numbers with `node scripts/check-demo-sources.mjs --lower` (the check also fails when a count fell and the file was not lowered). Never raise a number by hand.

To see which package entry points no demo shows yet:

```sh
node scripts/web-demos/coverage.mjs
```

It lists every entry in each `packages/*/package.json` `exports` that no demo's `source/` imports, with the unused and total count per package, then the sorted entries.

### Find dead controls

A slider that moves nothing, or a switch whose dial turns while nothing turns on, is a bug. To find them:

```sh
node scripts/web-demos/controls.mjs newtons-cradle
node scripts/web-demos/controls.mjs --all --resume
```

It opens each page in installed Chrome, one page at a time, on WebGPU and again on the WebGL2 layer (`?backend=webgl2`), waits until the exhibit is marked ready and operates every visible control: sliders and number fields go to their max, min and middle, checkboxes and switches turn on and off, each radio, tab, select option and preset button in a row is chosen (the one already chosen only after another, since choosing it again changes nothing by design), buttons are clicked (a reset button after the view and a slider were moved first) and the scene is dragged when the page invites it. Around every input it compares the canvases and charts and the page's text readouts with what changes when nothing is touched (the page's own motion is the noise floor). A control is dead when neither a picture nor any readout outside its own label changes; dead and unsure controls are tried again on a fresh page with normal motion and a longer wait, then once more after pressing the page's start button, before they are reported. It also reports console and page errors on interaction, controls whose own value label changes while nothing else does, controls covered by another element or off-screen at 1440 x 900 and 390 x 844, pages that scroll sideways at 390 px, and pages that fail to start, stop drawing or hang (every step has a hard timeout; a hung page is closed and Chrome restarted).

Results go to `demos/.reports/controls.json` (not committed; each run updates only the demos it ran; WebGL2 results are filed as `<demo>@webgl2`) and a short list to `private/handoffs/dead-controls.md`. The run exits 1 when a page it checked fails to start, logs an error or has a dead or broken control. Options: `--backends=webgpu` runs one backend, `--resume` skips pages already in the report, `--save-frames` writes the before and after picture of every input to `demos/.reports/frames/` to check a verdict by eye (`--save-frames=flagged` only for inputs that changed nothing), `--no-confirm` skips the second try, `--wait=<ms>` (default 600) and `--confirm-wait=<ms>` (default 1500) set the wait after an input, `--md=<path>` moves the list, `--md-only` judges the JSON again with the current rules and rewrites the list, and `--report=<path>` reads and writes another JSON file. A control that cannot show a change by itself is listed under "Could not tell", not as dead: a brush or tool for the next stroke, a drag handle, a sound control, a speed control while nothing plays, and a grid cell that already holds the value a click puts there. A slider that turns something is not partly dead because -180 and 180 degrees draw the same picture. The comparison rules are in `scripts/web-demos/controls-compare.mjs` and tested by `tests/web-demos-controls.test.js`.

## Exhibits

| Exhibit | What it shows | Live | Zip |
| --- | --- | --- | --- |
| Event Horizon | Orbit a spinning black hole and see light from its accretion disk bend around the shadow. | [Open](https://margo-demos.pages.dev/event-horizon/) | [Download](downloads/event-horizon.zip) |
| Earth From Orbit | Move through a day in UTC and watch sunlight cross the real geography of Earth. | [Open](https://margo-demos.pages.dev/earth-from-orbit/) | [Download](downloads/earth-from-orbit.zip) |
| Cathedral Light | Move the sun through an autumn day and watch its light cross a Gothic nave. | [Open](https://margo-demos.pages.dev/cathedral-light/) | [Download](downloads/cathedral-light.zip) |
| The Night City | Scrub through dusk in a city built and lit in Margo Engine. | [Open](https://margo-demos.pages.dev/the-night-city/) | [Download](downloads/the-night-city.zip) |
| The Million Stars | Explore one million real 2MASS point sources and brush their near-infrared colors to see where they sit on the sky. | [Open](https://margo-demos.pages.dev/the-million-stars/) | [Download](downloads/the-million-stars.zip) |
| The Wrecking Ball | Release a miniature crane's linked pendulum into stacked blocks and compare how much of the tower falls. | [Open](https://margo-demos.pages.dev/the-wrecking-ball/) | [Download](downloads/the-wrecking-ball.zip) |
| The Domino Cascade | Tip one domino and follow the chain through a spiral, up a staircase and across a bridge. | [Open](https://margo-demos.pages.dev/the-domino-cascade/) | [Download](downloads/the-domino-cascade.zip) |
| The Engine Block | Section, inspect and export an exact four-cylinder CAD casting in Margo Engine. | [Open](https://margo-demos.pages.dev/the-engine-block/) | [Download](downloads/the-engine-block.zip) |
| Inside a Heat Pump | Reverse the refrigerant circuit, explore the heat exchangers and take apart a heat pump in Margo Engine. | [Open](https://margo-demos.pages.dev/inside-a-heat-pump/) | [Download](downloads/inside-a-heat-pump.zip) |
| Newton's Cradle | Release one or two polished steel balls and watch a contact pulse cross Newton's cradle. | [Open](https://margo-demos.pages.dev/newtons-cradle/) | [Download](downloads/newtons-cradle.zip) |
| The Analog Integrator | A working wheel-and-disk integrator in Margo Engine. | [Open](https://margo-demos.pages.dev/the-analog-integrator/) | [Download](downloads/the-analog-integrator.zip) |
| The Archimedes Screw | Turn an Archimedes screw and see the water pockets carry water from a lower pool to a raised basin. | [Open](https://margo-demos.pages.dev/the-archimedes-screw/) | [Download](downloads/the-archimedes-screw.zip) |
| The Astigmatism Bench | Slide the image plane of an astigmatic lens and see its spot turn from one line into another. | [Open](https://margo-demos.pages.dev/the-astigmatism-bench/) | [Download](downloads/the-astigmatism-bench.zip) |
| The Bellows | Lift and lower the walnut handle. See the leather bellows fold and its two check valves send air one way. | [Open](https://margo-demos.pages.dev/the-bellows/) | [Download](downloads/the-bellows.zip) |
| The Bimetal Switch | Warm two bonded metals and watch their different expansion open an electrical contact. | [Open](https://margo-demos.pages.dev/the-bimetal-switch/) | [Download](downloads/the-bimetal-switch.zip) |
| The Birefringence Viewer | Load a clear disc between crossed polarizers and see the stress emerge in spectral color. | [Open](https://margo-demos.pages.dev/the-birefringence-viewer/) | [Download](downloads/the-birefringence-viewer.zip) |
| The Cable Span | Move a proof cart across a suspended footbridge. Watch its twin cables and timber deck find a new equilibrium. | [Open](https://margo-demos.pages.dev/the-cable-span/) | [Download](downloads/the-cable-span.zip) |
| The Camera Obscura | Slide the ground glass in a cutaway pinhole camera and watch the inverted harbor grow dimmer. | [Open](https://margo-demos.pages.dev/the-camera-obscura/) | [Download](downloads/the-camera-obscura.zip) |
| The Canal Lock | Take a narrowboat through a working cutaway canal lock and watch the water carry it to the next reach. | [Open](https://margo-demos.pages.dev/the-canal-lock/) | [Download](downloads/the-canal-lock.zip) |
| The Capillary Garden | Watch liquid rise into five glass capillaries and change the wetting angle to see how high each column can climb. | [Open](https://margo-demos.pages.dev/the-capillary-garden/) | [Download](downloads/the-capillary-garden.zip) |
| The Capstan | Wind a rope around a capstan and see how friction lets you hold a heavier load. | [Open](https://margo-demos.pages.dev/the-capstan/) | [Download](downloads/the-capstan.zip) |
| The Chain Fountain | Run a chain fountain and see how contacts in its feed tray push the falling chain upward. | [Open](https://margo-demos.pages.dev/the-chain-fountain/) | [Download](downloads/the-chain-fountain.zip) |
| The Desert Mirage | Heat a desert road and trace the light that makes dry asphalt look like water. | [Open](https://margo-demos.pages.dev/the-desert-mirage/) | [Download](downloads/the-desert-mirage.zip) |
| The Dichroic Splitter | Tilt a thin-film dichroic plate and see how it divides white light between two optical paths. | [Open](https://margo-demos.pages.dev/the-dichroic-splitter/) | [Download](downloads/the-dichroic-splitter.zip) |
| The Differential | See how an open differential lets its wheels turn at different speeds. | [Open](https://margo-demos.pages.dev/the-differential/) | [Download](downloads/the-differential.zip) |
| The Diffraction Ruler | Change the wavelength or groove density to move the diffraction orders across a precision angle scale. | [Open](https://margo-demos.pages.dev/the-diffraction-ruler/) | [Download](downloads/the-diffraction-ruler.zip) |
| The Echo Canyon | Send a sound across a sandstone canyon and compare the delay from each reflected path. | [Open](https://margo-demos.pages.dev/the-echo-canyon/) | [Download](downloads/the-echo-canyon.zip) |
| The Eddy Brake | Spin a copper rotor and watch a magnetic field slow it through eddy currents. | [Open](https://margo-demos.pages.dev/the-eddy-brake/) | [Download](downloads/the-eddy-brake.zip) |
| The Epicyclic Drive | Hold the sun, carrier, or ring and watch three planet gears change motion in a true tooth-count gear train. | [Open](https://margo-demos.pages.dev/the-epicyclic-drive/) | [Download](downloads/the-epicyclic-drive.zip) |
| The Flood Table | Release a reservoir and defend a miniature valley in a live Margo Engine hydraulic simulation. | [Open](https://margo-demos.pages.dev/the-flood-table/) | [Download](downloads/the-flood-table.zip) |
| The Foucault Pendulum | Move a Foucault pendulum from one hemisphere to the other and watch its swing turn with Earth | [Open](https://margo-demos.pages.dev/the-foucault-pendulum/) | [Download](downloads/the-foucault-pendulum.zip) |
| The Fourier Organ | Add odd harmonics to a tone and watch a sine wave take on the shape of a square wave. | [Open](https://margo-demos.pages.dev/the-fourier-organ/) | [Download](downloads/the-fourier-organ.zip) |
| The Fresnel Lens | Move a lighthouse lamp behind a stepped Fresnel lens to see when its rays emerge parallel. | [Open](https://margo-demos.pages.dev/the-fresnel-lens/) | [Download](downloads/the-fresnel-lens.zip) |
| The Geneva Drive | Turn the crank of a four-slot Geneva drive and watch a continuous turn become one precise step. Built in Margo Engine. | [Open](https://margo-demos.pages.dev/the-geneva-drive/) | [Download](downloads/the-geneva-drive.zip) |
| The Gimbal | Tilt a precision gyroscope and see what its gimbals do. Built in Margo Engine. | [Open](https://margo-demos.pages.dev/the-gimbal/) | [Download](downloads/the-gimbal.zip) |
| The Halo Prism | Trace two refractions through a hexagonal ice prism and find the sharp inner edge of the 22 degree halo. | [Open](https://margo-demos.pages.dev/the-halo-prism/) | [Download](downloads/the-halo-prism.zip) |
| The Harmonic Drive | A working strain-wave gear cutaway in Margo Engine. | [Open](https://margo-demos.pages.dev/the-harmonic-drive/) | [Download](downloads/the-harmonic-drive.zip) |
| The Heat Sink | Turn on a fan and follow heat through a working model of an electronics heat sink. | [Open](https://margo-demos.pages.dev/the-heat-sink/) | [Download](downloads/the-heat-sink.zip) |
| The Hele, Shaw Cell | Follow colored dye through a thin glass cell and widen a cylinder to divert the flow. | [Open](https://margo-demos.pages.dev/the-hele-shaw-cell/) | [Download](downloads/the-hele-shaw-cell.zip) |
| The Hydraulic Jump | Speed up water in a laboratory flume and watch shallow flow rise into a deep hydraulic jump. | [Open](https://margo-demos.pages.dev/the-hydraulic-jump/) | [Download](downloads/the-hydraulic-jump.zip) |
| The Hydraulic Ram | Watch a hydraulic ram pump use a falling stream to lift part of its water above the source. | [Open](https://margo-demos.pages.dev/the-hydraulic-ram/) | [Download](downloads/the-hydraulic-ram.zip) |
| The Iridescence Bench | Tune the thickness and angle of a thin film and see white light separate into structural color. | [Open](https://margo-demos.pages.dev/the-iridescence-bench/) | [Download](downloads/the-iridescence-bench.zip) |
| The Jewelry Counter | An interactive study of gold, platinum, and round-brilliant gemstone facets, rendered live by Margo Engine. | [Open](https://margo-demos.pages.dev/the-jewelry-counter/) | [Download](downloads/the-jewelry-counter.zip) |
| The Light Bench | Turn a slotted steel mask and watch a spotlight carve through a plaster sculpture. | [Open](https://margo-demos.pages.dev/the-light-bench/) | [Download](downloads/the-light-bench.zip) |
| The Magnetic Field Mapper | Move two magnets and see a board of compass needles trace their combined magnetic field. | [Open](https://margo-demos.pages.dev/the-magnetic-field-mapper/) | [Download](downloads/the-magnetic-field-mapper.zip) |
| The Marble Sorter | Run a gravity-fed marble sorter and steer the rolling glass into either tray. | [Open](https://margo-demos.pages.dev/the-marble-sorter/) | [Download](downloads/the-marble-sorter.zip) |
| The Michelson Interferometer | Translate a mirror by nanometers and watch a Michelson interferometer count the distance in light fringes. | [Open](https://margo-demos.pages.dev/the-michelson-interferometer/) | [Download](downloads/the-michelson-interferometer.zip) |
| The Moiré Press | Turn one precision screen over another and watch their fine lines form broad moving bands. | [Open](https://margo-demos.pages.dev/the-moire-press/) | [Download](downloads/the-moire-press.zip) |
| The Oldham Coupling | Offset two parallel shafts and watch an Oldham coupling transmit the same rotation as its middle disk orbits. | [Open](https://margo-demos.pages.dev/the-oldham-coupling/) | [Download](downloads/the-oldham-coupling.zip) |
| The Orrery | Run two years through an interactive brass orrery and compare the orbits of Mercury, Venus, Earth and Mars. | [Open](https://margo-demos.pages.dev/the-orrery/) | [Download](downloads/the-orrery.zip) |
| The Paper Bridge | Load two paper spans side by side and see how a crease changes the way a bridge bends. | [Open](https://margo-demos.pages.dev/the-paper-bridge/) | [Download](downloads/the-paper-bridge.zip) |
| The Pelton Wheel | Change the speed of a brass Pelton wheel and watch how its split water jet transfers momentum. | [Open](https://margo-demos.pages.dev/the-pelton-wheel/) | [Download](downloads/the-pelton-wheel.zip) |
| The Pinhole Array | Change three circular pinholes and compare the resolution of their lensless images. | [Open](https://margo-demos.pages.dev/the-pinhole-array/) | [Download](downloads/the-pinhole-array.zip) |
| The Polarizer | Turn the analyzer and watch two polarizers take light from full transmission to extinction. | [Open](https://margo-demos.pages.dev/the-polarizer/) | [Download](downloads/the-polarizer.zip) |
| The Resonance Room | Tune a listening room and see where bass builds up or cancels. An interactive acoustic exhibit | [Open](https://margo-demos.pages.dev/the-resonance-room/) | [Download](downloads/the-resonance-room.zip) |
| The Retroreflector | Move a survey lamp at night and follow the three reflections that send the beam back. | [Open](https://margo-demos.pages.dev/the-retroreflector/) | [Download](downloads/the-retroreflector.zip) |
| The Reuleaux Drive | Turn a Reuleaux triangle inside a square and trace the motion of its moving center. Built in Margo Engine. | [Open](https://margo-demos.pages.dev/the-reuleaux-drive/) | [Download](downloads/the-reuleaux-drive.zip) |
| The Rolling Race | Release a solid disc and hollow ring on the same ramp. See how their mass distribution changes the race. | [Open](https://margo-demos.pages.dev/the-rolling-race/) | [Download](downloads/the-rolling-race.zip) |
| The Rose Engine | Turn a rose-engine lathe and watch its rosette guide a fine engraved pattern on a silver workpiece. | [Open](https://margo-demos.pages.dev/the-rose-engine/) | [Download](downloads/the-rose-engine.zip) |
| The Salt Wedge | Change river discharge and watch the modeled saltwater intrusion retreat beneath the fresh layer of a coastal estuary. | [Open](https://margo-demos.pages.dev/the-salt-wedge/) | [Download](downloads/the-salt-wedge.zip) |
| The Sand Pendulum | Release a brass sand pendulum and draw a pattern from two swinging motions. | [Open](https://margo-demos.pages.dev/the-sand-pendulum/) | [Download](downloads/the-sand-pendulum.zip) |
| The Sarrus Linkage | A fold-out field platform demonstrating a Sarrus linkage in Margo Engine. | [Open](https://margo-demos.pages.dev/the-sarrus-linkage/) | [Download](downloads/the-sarrus-linkage.zip) |
| The Schlieren Bench | Slide a knife edge into a focused beam to reveal otherwise invisible temperature gradients above a heater. | [Open](https://margo-demos.pages.dev/the-schlieren-bench/) | [Download](downloads/the-schlieren-bench.zip) |
| The Scotch Yoke | Turn a crank and watch its roller drive a piston through a straight slot. A live mechanical exhibit | [Open](https://margo-demos.pages.dev/the-scotch-yoke/) | [Download](downloads/the-scotch-yoke.zip) |
| The Seismograph | Tune a tremor, watch the suspended mass and read the trace on a mechanical seismograph rendered in Margo Engine. | [Open](https://margo-demos.pages.dev/the-seismograph/) | [Download](downloads/the-seismograph.zip) |
| The Shadow Calendar | Follow a working bronze sundial through the day and across seasons. | [Open](https://margo-demos.pages.dev/the-shadow-calendar/) | [Download](downloads/the-shadow-calendar.zip) |
| The Siphon | Change the outlet height of a primed siphon and see what drives the water through the glass. | [Open](https://margo-demos.pages.dev/the-siphon/) | [Download](downloads/the-siphon.zip) |
| The Stepping Stones | Shift a stepping stone and watch a digital human shift his weight and plant each foot across the creek. | [Open](https://margo-demos.pages.dev/the-stepping-stones/) | [Download](downloads/the-stepping-stones.zip) |
| The Stroboscope | Sample a turning rotor and see it slow, stop or appear to spin backward. | [Open](https://margo-demos.pages.dev/the-stroboscope/) | [Download](downloads/the-stroboscope.zip) |
| The Tidal Clock | Scrub a day of tides in a miniature harbor and compare the changing waterline on spring and neap tides. | [Open](https://margo-demos.pages.dev/the-tidal-clock/) | [Download](downloads/the-tidal-clock.zip) |
| The Toggle Press | Straighten two hinged links and see how a manual toggle press trades travel for force. Built in Margo Engine. | [Open](https://margo-demos.pages.dev/the-toggle-press/) | [Download](downloads/the-toggle-press.zip) |
| The Venturi Meter | Send water through a transparent Venturi meter. Watch the flow accelerate while the throat pressure falls. | [Open](https://margo-demos.pages.dev/the-venturi-meter/) | [Download](downloads/the-venturi-meter.zip) |
| The Vortex Ring | Launch a ring of dye through a dark water tank and see how circulation changes its rise. | [Open](https://margo-demos.pages.dev/the-vortex-ring/) | [Download](downloads/the-vortex-ring.zip) |
| The Watt Governor | Change the spindle speed to see how a Watt governor uses two spinning weights to close a steam valve. | [Open](https://margo-demos.pages.dev/the-watt-governor/) | [Download](downloads/the-watt-governor.zip) |
| A Thousand Lights | Sweep a thousand colored lights through a basalt hall and watch six of them cast moving shadows. | [Open](https://margo-demos.pages.dev/a-thousand-lights/) | [Download](downloads/a-thousand-lights.zip) |
| Ambient Occlusion | Compare two ambient occlusion methods on a chambered spiral sculpture under the same light. | [Open](https://margo-demos.pages.dev/ambient-occlusion/) | [Download](downloads/ambient-occlusion.zip) |
| Area Lights | Slide a sphere, disc, tube or line light along a rail and see its highlight change on nickel, brass and ceramic. | [Open](https://margo-demos.pages.dev/area-lights/) | [Download](downloads/area-lights.zip) |
| Bend It | Bend a segmented footbridge along an editable spline and drag the guide points in plan. | [Open](https://margo-demos.pages.dev/bend-it/) | [Download](downloads/bend-it.zip) |
| Big Data Points | Turn a real USGS lidar survey of the Kilauea summit and stream up to two million points. | [Open](https://margo-demos.pages.dev/big-data-points/) | [Download](downloads/big-data-points.zip) |
| Bounce Light | Compare direct, screen space and ray traced bounce light in a gallery with colored plaster walls. | [Open](https://margo-demos.pages.dev/bounce-light/) | [Download](downloads/bounce-light.zip) |
| Candlelight | Five candles light a night archive. Freeze the flicker and watch the shadow budget respond. | [Open](https://margo-demos.pages.dev/candlelight/) | [Download](downloads/candlelight.zip) |
| Caustic Glass | Shine light through polished, ground and dispersive glass and compare the caustics on a slate table. | [Open](https://margo-demos.pages.dev/caustic-glass/) | [Download](downloads/caustic-glass.zip) |
| Charts You Can Hear | Listen to a day of Golden Gate tide readings, then explore the same chart with the keyboard or a table. | [Open](https://margo-demos.pages.dev/charts-you-can-hear/) | [Download](downloads/charts-you-can-hear.zip) |
| Cloudscape | Climb from the ground through a volumetric cumulus layer and watch sun shafts and cloud shadows. | [Open](https://margo-demos.pages.dev/cloudscape/) | [Download](downloads/cloudscape.zip) |
| Compute Textures | Run three Gray Scott reaction recipes on a live GPU texture and add reagent with a tap. | [Open](https://margo-demos.pages.dev/compute-textures/) | [Download](downloads/compute-textures.zip) |
| Depth Video | Play a real depth camera recording as a point cloud, switch to camera color and orbit it. | [Open](https://margo-demos.pages.dev/depth-video/) | [Download](downloads/depth-video.zip) |
| Directional Lightmaps | Compare a directional lightmap with an intensity only bake on the same enamel relief. | [Open](https://margo-demos.pages.dev/directional-lightmaps/) | [Download](downloads/directional-lightmaps.zip) |
| Edit and Save BIM | Change a door's properties in an IFC pavilion and download the checked, revised file. | [Open](https://margo-demos.pages.dev/edit-and-save-bim/) | [Download](downloads/edit-and-save-bim.zip) |
| GLSL Welcome | Edit a GLSL fragment shader and watch it run live on a sculpted surface. | [Open](https://margo-demos.pages.dev/glsl-welcome/) | [Download](downloads/glsl-welcome.zip) |
| Golden Hour | Switch between four lighting conditions and three tone mapping looks over the same stone basin. | [Open](https://margo-demos.pages.dev/golden-hour/) | [Download](downloads/golden-hour.zip) |
| GPU NumPy | Run array expressions, Fourier transforms, sorts and matrix products on the GPU. | [Open](https://margo-demos.pages.dev/gpu-numpy/) | [Download](downloads/gpu-numpy.zip) |
| Ground Projection | Switch between a distant skydome and a ground projected photo backdrop with real contact. | [Open](https://margo-demos.pages.dev/ground-projection/) | [Download](downloads/ground-projection.zip) |
| HDR Window | Compare standard and extended highlights in a gallery lit from an EXR, with HDR output where your display supports it. | [Open](https://margo-demos.pages.dev/hdr-window/) | [Download](downloads/hdr-window.zip) |
| Light Probes | Roll a polished sphere through three colored rooms and watch its lighting and reflections change. | [Open](https://margo-demos.pages.dev/light-probes/) | [Download](downloads/light-probes.zip) |
| Long Shadows | Watch local and terrain shadows stretch across a five kilometer Alpine railway valley. | [Open](https://margo-demos.pages.dev/long-shadows/) | [Download](downloads/long-shadows.zip) |
| Many Goals | Give one robot arm three contact targets, change their priorities and measure where each lands. | [Open](https://margo-demos.pages.dev/many-goals/) | [Download](downloads/many-goals.zip) |
| Mesh Booleans | Carve pockets and a tunnel through a lapis specimen with exact triangle mesh subtraction. | [Open](https://margo-demos.pages.dev/mesh-booleans/) | [Download](downloads/mesh-booleans.zip) |
| Model to STEP | Change a flange's bore, export the solid to STEP and import it back to compare. | [Open](https://margo-demos.pages.dev/model-to-step/) | [Download](downloads/model-to-step.zip) |
| Molten Words | Type a word, cast it in hot metal and watch it cool in a foundry bed. | [Open](https://margo-demos.pages.dev/molten-words/) | [Download](downloads/molten-words.zip) |
| Mountain Day | Scrub a full day of sun, clouds, haze and stars over an alpine range. | [Open](https://margo-demos.pages.dev/mountain-day/) | [Download](downloads/mountain-day.zip) |
| Night Storm Sky | Trigger a lightning strike over a rocky inlet and see it light the storm from inside. | [Open](https://margo-demos.pages.dev/night-storm-sky/) | [Download](downloads/night-storm-sky.zip) |
| Paint the Model | Paint a helmet directly on its 3D surface, with an eraser and undo. | [Open](https://margo-demos.pages.dev/paint-the-model/) | [Download](downloads/paint-the-model.zip) |
| Parallax Walls | Inspect parallax occlusion and triplanar mapping on a masonry vault. | [Open](https://margo-demos.pages.dev/parallax-walls/) | [Download](downloads/parallax-walls.zip) |
| Parallel Coordinates | Brush any mix of eight measurements and compare the linked density and scatter views. | [Open](https://margo-demos.pages.dev/parallel-coordinates/) | [Download](downloads/parallel-coordinates.zip) |
| Portals | Move the camera through two stencil portals that open into intersecting chambers. | [Open](https://margo-demos.pages.dev/portals/) | [Download](downloads/portals.zip) |
| Ray Traced Shadows | Compare raster shadow maps with rays traced through a live triangle BVH. | [Open](https://margo-demos.pages.dev/ray-traced-shadows/) | [Download](downloads/ray-traced-shadows.zip) |
| Scene Transitions | Scrub a wipe, a noise dissolve and a chromatic swipe between two scenes. | [Open](https://margo-demos.pages.dev/scene-transitions/) | [Download](downloads/scene-transitions.zip) |
| Shapes From Lines | Draw an outline, offset it, join it to a ring and extrude a beveled solid. | [Open](https://margo-demos.pages.dev/shapes-from-lines/) | [Download](downloads/shapes-from-lines.zip) |
| Shortest Paths | Pick a junction in Washington, D.C. and trace the shortest legal route through its one way streets. | [Open](https://margo-demos.pages.dev/shortest-paths/) | [Download](downloads/shortest-paths.zip) |
| Skin and Wax | Move a light over wax, marble and jade and compare how light scatters beneath each surface. | [Open](https://margo-demos.pages.dev/skin-and-wax/) | [Download](downloads/skin-and-wax.zip) |
| Speed | Set one motion blur shutter for a passing train and a spinning turntable. | [Open](https://margo-demos.pages.dev/speed/) | [Download](downloads/speed.zip) |
| Sweep and Loft | Build a duct by sweeping a profile along a path and a bottle by lofting stacked profiles. | [Open](https://margo-demos.pages.dev/sweep-and-loft/) | [Download](downloads/sweep-and-loft.zip) |
| Temporal Upscaling | Compare native resolution with spatial and temporal upscaling on an alpine cableway. | [Open](https://margo-demos.pages.dev/temporal-upscaling/) | [Download](downloads/temporal-upscaling.zip) |
| Ten Thousand Trees | Fly low over an alpine forest of ten thousand trees and push wind through the canopy. | [Open](https://margo-demos.pages.dev/ten-thousand-trees/) | [Download](downloads/ten-thousand-trees.zip) |
| The AR Card | Turn a model radio and download a real scale USDZ file for AR Quick Look. | [Open](https://margo-demos.pages.dev/the-ar-card/) | [Download](downloads/the-ar-card.zip) |
| The Aurora | Scrub three hours of an Arctic night and watch the aurora, stars and Moon move over a frozen lake. | [Open](https://margo-demos.pages.dev/the-aurora/) | [Download](downloads/the-aurora.zip) |
| The Baked Room | Bake a room's indirect light in the browser and compare denoising settings. | [Open](https://margo-demos.pages.dev/the-baked-room/) | [Download](downloads/the-baked-room.zip) |
| The BIM House | Walk through an IFC courtyard house, inspect its walls and download the IFC4 source. | [Open](https://margo-demos.pages.dev/the-bim-house/) | [Download](downloads/the-bim-house.zip) |
| The Biome Map | Change rainfall and temperature and watch four biomes move across a 3D continent. | [Open](https://margo-demos.pages.dev/the-biome-map/) | [Download](downloads/the-biome-map.zip) |
| The Boolean Bench | Union, subtract or intersect two exact solids and toggle their B-rep edges. | [Open](https://margo-demos.pages.dev/the-boolean-bench/) | [Download](downloads/the-boolean-bench.zip) |
| The Brain Scan | Move three MRI slices through a real head scan and compare them with bone from the matching CT. | [Open](https://margo-demos.pages.dev/the-brain-scan/) | [Download](downloads/the-brain-scan.zip) |
| The Building Checker | Open BCF issue viewpoints in an IFC archive and run its door information checks. | [Open](https://margo-demos.pages.dev/the-building-checker/) | [Download](downloads/the-building-checker.zip) |
| The CAD Format Shelf | Open six real STEP and IGES files and browse the part trees they import. | [Open](https://margo-demos.pages.dev/the-cad-format-shelf/) | [Download](downloads/the-cad-format-shelf.zip) |
| The Cell Microscope | Explore a cryo electron microscopy map of ATP synthase as a surface or a volume. | [Open](https://margo-demos.pages.dev/the-cell-microscope/) | [Download](downloads/the-cell-microscope.zip) |
| The Chart Wall | Explore three decades of exoplanet discoveries in live charts and export your view as SVG. | [Open](https://margo-demos.pages.dev/the-chart-wall/) | [Download](downloads/the-chart-wall.zip) |
| The Cine Lens | Focus a projector room and compare depth of field with tilt shift. | [Open](https://margo-demos.pages.dev/the-cine-lens/) | [Download](downloads/the-cine-lens.zip) |
| The City Generator | Generate a seeded model town with streets, lots and buildings from two eras. | [Open](https://margo-demos.pages.dev/the-city-generator/) | [Download](downloads/the-city-generator.zip) |
| The Climate Globe | Step through 146 years of NASA temperature grids on a globe and inspect any cell. | [Open](https://margo-demos.pages.dev/the-climate-globe/) | [Download](downloads/the-climate-globe.zip) |
| The Climbing Robot | Watch a jointed robot pick collision checked holds up an overhung climbing wall. | [Open](https://margo-demos.pages.dev/the-climbing-robot/) | [Download](downloads/the-climbing-robot.zip) |
| The Color Grader | Compare tone mapping curves and grade a coastal signal room live, then export a LUT. | [Open](https://margo-demos.pages.dev/the-colour-grader/) | [Download](downloads/the-colour-grader.zip) |
| The Contour Map | Read USGS elevation contours on Mount St. Helens and orbit the same terrain in relief. | [Open](https://margo-demos.pages.dev/the-contour-map/) | [Download](downloads/the-contour-map.zip) |
| The Curve Lab | Compare four spline families, measure arc length and follow a moving frame along the curve. | [Open](https://margo-demos.pages.dev/the-curve-lab/) | [Download](downloads/the-curve-lab.zip) |
| The Cut House | Scrub a capped section through an IFC floor plan and inspect wall and room records. | [Open](https://margo-demos.pages.dev/the-cut-house/) | [Download](downloads/the-cut-house.zip) |
| The Dungeon Maker | Generate a two level stone archive and walk through it with real collisions. | [Open](https://margo-demos.pages.dev/the-dungeon-maker/) | [Download](downloads/the-dungeon-maker.zip) |
| The Eclipse | Scrub the April 8, 2024 total solar eclipse as seen from Dallas, Texas. | [Open](https://margo-demos.pages.dev/the-eclipse/) | [Download](downloads/the-eclipse.zip) |
| The Engineering Mesh | Move a section through a heated ceramic sleeve and see its temperature on a tetrahedral mesh. | [Open](https://margo-demos.pages.dev/the-engineering-mesh/) | [Download](downloads/the-engineering-mesh.zip) |
| The Exploded Assembly | Pull apart an eight leaf optical iris and identify each of its 22 parts. | [Open](https://margo-demos.pages.dev/the-exploded-assembly/) | [Download](downloads/the-exploded-assembly.zip) |
| The FFT Lens | Compare a real Webb image with its GPU Fourier reconstruction and drop frequency bands to reveal structure. | [Open](https://margo-demos.pages.dev/the-fft-lens/) | [Download](downloads/the-fft-lens.zip) |
| The Fillet Bench | Compare exact rolling ball fillets and chamfers on the same stock and read the volume. | [Open](https://margo-demos.pages.dev/the-fillet-bench/) | [Download](downloads/the-fillet-bench.zip) |
| The Glass Stack | Rotate glass and smoke and compare three ways of drawing transparency. | [Open](https://margo-demos.pages.dev/the-glass-stack/) | [Download](downloads/the-glass-stack.zip) |
| The Graph Network | Tap a port in an invented archipelago to trace its ferry routes in a GPU graph. | [Open](https://margo-demos.pages.dev/the-graph-network/) | [Download](downloads/the-graph-network.zip) |
| The Heat Haze | Watch heat shimmer rise from a temperature volume over a desert highway. | [Open](https://margo-demos.pages.dev/the-heat-haze/) | [Download](downloads/the-heat-haze.zip) |
| The Hollow Cup | Change a cast cup's wall thickness and mold draft and check the exact solid. | [Open](https://margo-demos.pages.dev/the-hollow-cup/) | [Download](downloads/the-hollow-cup.zip) |
| The Laser Scan | Explore 221,727 USGS lidar returns from Glacier Peak and measure between two points. | [Open](https://margo-demos.pages.dev/the-laser-scan/) | [Download](downloads/the-laser-scan.zip) |
| The Lens Kit | Add flare, streaks and vintage lens effects to a night ferry pier. | [Open](https://margo-demos.pages.dev/the-lens-kit/) | [Download](downloads/the-lens-kit.zip) |
| The Lighting Store | Compare two measured GE floodlight beams on matching walls at real distances. | [Open](https://margo-demos.pages.dev/the-lighting-store/) | [Download](downloads/the-lighting-store.zip) |
| The Living Museum | Guide a visitor through an evening museum and watch the guard notice, follow and search. | [Open](https://margo-demos.pages.dev/the-living-museum/) | [Download](downloads/the-living-museum.zip) |
| The Meadow | Walk through a high meadow and watch the grass bend, flatten and recover. | [Open](https://margo-demos.pages.dev/the-meadow/) | [Download](downloads/the-meadow.zip) |
| The Measuring Room | Click a face, edge or bore on a machined block to measure it directly. | [Open](https://margo-demos.pages.dev/the-measuring-room/) | [Download](downloads/the-measuring-room.zip) |
| The Mesh Workshop | Use five polygon editing tools on an industrial air housing, with undo. | [Open](https://margo-demos.pages.dev/the-mesh-workshop/) | [Download](downloads/the-mesh-workshop.zip) |
| The Mirror Hall | Compare screen space and ray traced reflections side by side in a gallery. | [Open](https://margo-demos.pages.dev/the-mirror-hall/) | [Download](downloads/the-mirror-hall.zip) |
| The Molecule | Orbit the real structure of green fluorescent protein and pick atoms around its chromophore. | [Open](https://margo-demos.pages.dev/the-molecule/) | [Download](downloads/the-molecule.zip) |
| The Murmuration | Send a disturbance through a simulated flock of 16,384 starlings over a dusk marsh. | [Open](https://margo-demos.pages.dev/the-murmuration/) | [Download](downloads/the-murmuration.zip) |
| The Neural Playground | Train a small two class model and plant labeled points to reshape its decision field. | [Open](https://margo-demos.pages.dev/the-neural-playground/) | [Download](downloads/the-neural-playground.zip) |
| The Painting | Compare three painterly filters on a moving coastline. | [Open](https://margo-demos.pages.dev/the-painting/) | [Download](downloads/the-painting.zip) |
| The Path Traced Glasshouse | Compare two spectral path traced renders and inspect a live flint prism ray study. | [Open](https://margo-demos.pages.dev/the-path-traced-glasshouse/) | [Download](downloads/the-path-traced-glasshouse.zip) |
| The Print Shop | Scrub all 30 toolpath layers of a print and download the matching 3MF or G-code. | [Open](https://margo-demos.pages.dev/the-print-shop/) | [Download](downloads/the-print-shop.zip) |
| The Product Studio | Frame a radio receiver, render a still with soft disk light shadows and save it as a PNG. | [Open](https://margo-demos.pages.dev/the-product-studio/) | [Download](downloads/the-product-studio.zip) |
| The Projector | Pass three glass slides through a projector and watch the light fall across a statue. | [Open](https://margo-demos.pages.dev/the-projector/) | [Download](downloads/the-projector.zip) |
| The Reach Test | Drag the target and watch a three link arm reach around a capsule and a block. | [Open](https://margo-demos.pages.dev/the-reach-test/) | [Download](downloads/the-reach-test.zip) |
| The Road Builder | Draw roads with stitched intersections, banking and markings on fitted ground. | [Open](https://margo-demos.pages.dev/the-road-builder/) | [Download](downloads/the-road-builder.zip) |
| The Sculpting Clay | Sculpt a clay study by hand and bake its detail into a downloadable normal map. | [Open](https://margo-demos.pages.dev/the-sculpting-clay/) | [Download](downloads/the-sculpting-clay.zip) |
| The Section Saw | Move a cutting plane through a shaft seal and expose its cut faces and hidden edges. | [Open](https://margo-demos.pages.dev/the-section-saw/) | [Download](downloads/the-section-saw.zip) |
| The Shader Node Editor | Wire shader nodes into a glazed material and read the WGSL it generates. | [Open](https://margo-demos.pages.dev/the-shader-node-editor/) | [Download](downloads/the-shader-node-editor.zip) |
| The Shadow Lab | Change a light's size and see soft shadows, stained glass color and light through leaves. | [Open](https://margo-demos.pages.dev/the-shadow-lab/) | [Download](downloads/the-shadow-lab.zip) |
| The Simplifier | Reduce the triangle count of a limestone owl and compare the levels of detail. | [Open](https://margo-demos.pages.dev/the-simplifier/) | [Download](downloads/the-simplifier.zip) |
| The Sky Clock | See the sky for any date, UTC time and place on Earth. | [Open](https://margo-demos.pages.dev/the-sky-clock/) | [Download](downloads/the-sky-clock.zip) |
| The Sky Survey | Turn an armillary holding 7,195 NASA Fermi gamma ray detections. | [Open](https://margo-demos.pages.dev/the-sky-survey/) | [Download](downloads/the-sky-survey.zip) |
| The Solid Modeler | Build a mounting bracket in four exact B-rep steps and read the volume and mass at each. | [Open](https://margo-demos.pages.dev/the-solid-modeller/) | [Download](downloads/the-solid-modeller.zip) |
| The Sort Race | Race a million key GPU radix sort against your browser's CPU sort and verify both. | [Open](https://margo-demos.pages.dev/the-sort-race/) | [Download](downloads/the-sort-race.zip) |
| The Sound Landscape | Play three clips and follow their audio through live 3D spectrograms. | [Open](https://margo-demos.pages.dev/the-sound-landscape/) | [Download](downloads/the-sound-landscape.zip) |
| The Splat Room | Explore a Gaussian splat scan of the Apollo 11 cabin and recolor or erase splats. | [Open](https://margo-demos.pages.dev/the-splat-room/) | [Download](downloads/the-splat-room.zip) |
| The Streamtubes | Change the tube thickness or isolate either wingtip vortex in a wind tunnel. | [Open](https://margo-demos.pages.dev/the-streamtubes/) | [Download](downloads/the-streamtubes.zip) |
| The Stress Glyphs | Rotate a pull around a circular hole and watch the stress field change. | [Open](https://margo-demos.pages.dev/the-stress-glyphs/) | [Download](downloads/the-stress-glyphs.zip) |
| The Technical Drawing | Orbit a technical drawing of a refractor with dashed hidden lines. | [Open](https://margo-demos.pages.dev/the-technical-drawing/) | [Download](downloads/the-technical-drawing.zip) |
| The UV Unwrapper | Change a model's seams and compare its texture and lightmap UV islands. | [Open](https://margo-demos.pages.dev/the-uv-unwrapper/) | [Download](downloads/the-uv-unwrapper.zip) |
| The Weather Radar | Change a real NEXRAD sweep angle and see the curved beam and reflectivity. | [Open](https://margo-demos.pages.dev/the-weather-radar/) | [Download](downloads/the-weather-radar.zip) |
| The Weigh Station | Pick a part and a metal and read its volume, mass, center of mass and inertia. | [Open](https://margo-demos.pages.dev/the-weigh-station/) | [Download](downloads/the-weigh-station.zip) |
| Toon Town | Change pen, dot and cel shading in an illustrated canal village. | [Open](https://margo-demos.pages.dev/toon-town/) | [Download](downloads/toon-town.zip) |
| Trees From Space | Grow a canopy and roots with space colonization and add barriers to change their path. | [Open](https://margo-demos.pages.dev/trees-from-space/) | [Download](downloads/trees-from-space.zip) |
| Volumetric Fog | Watch dawn fog, mist banks and sun shafts through a forest canopy. | [Open](https://margo-demos.pages.dev/volumetric-fog/) | [Download](downloads/volumetric-fog.zip) |
| Voronoi Shatter Art | Separate a glazed sculpture into its 35 solid Voronoi cells and put it back together. | [Open](https://margo-demos.pages.dev/voronoi-shatter-art/) | [Download](downloads/voronoi-shatter-art.zip) |
| Wind and Flow Painting | Release dye streaks into a computed flow and compare its velocity texture. | [Open](https://margo-demos.pages.dev/wind-and-flow-painting/) | [Download](downloads/wind-and-flow-painting.zip) |
| Wind Over America | Step through eight days of NOAA wind over North America. | [Open](https://margo-demos.pages.dev/wind-over-america/) | [Download](downloads/wind-over-america.zip) |
| 2D Light and Shadow | Carry a survey lamp into an underground river chamber. Move the light to see which rock faces it reaches. | [Open](https://margo-demos.pages.dev/2d-light-and-shadow/) | [Download](downloads/2d-light-and-shadow.zip) |
| Bone Crowds | Follow a caribou migration across a braided river. Every set of hooves moves on its own clock. | [Open](https://margo-demos.pages.dev/bone-crowds/) | [Download](downloads/bone-crowds.zip) |
| Bullet Through Paper | Send two virtual ceramic blocks toward thin rigid dividers. Swept collision changes what happens between samples. | [Open](https://margo-demos.pages.dev/bullet-through-paper/) | [Download](downloads/bullet-through-paper.zip) |
| Character Course | Cross the gauge station on foot. Climb the steps, ride the ferry, then take the ramp to the lower deck. | [Open](https://margo-demos.pages.dev/character-course/) | [Download](downloads/character-course.zip) |
| Compound Shapes | Release two built-up shapes and watch how their mass and shape affect the tumble. | [Open](https://margo-demos.pages.dev/compound-shapes/) | [Download](downloads/compound-shapes.zip) |
| Cutscene Studio | Edit a lighthouse scene in three shots. Move a cut, scrub the dialogue, or render the sequence to a video file. | [Open](https://margo-demos.pages.dev/cutscene-studio/) | [Download](downloads/cutscene-studio.zip) |
| Drone Volume | Send three inspection drones through a conservatory. Their routes can curve around the racks or climb above them. | [Open](https://margo-demos.pages.dev/drone-volume/) | [Download](downloads/drone-volume.zip) |
| Globe Flight | Fly from Earth's limb to the summit of Mauna Kea, then turn the island to follow its volcanic ridges. | [Open](https://margo-demos.pages.dev/globe-flight/) | [Download](downloads/globe-flight.zip) |
| Height Streaming | Fly the bends of Utah's Green River and watch measured terrain load around you as the survey window moves. | [Open](https://margo-demos.pages.dev/height-streaming/) | [Download](downloads/height-streaming.zip) |
| L-System Garden | Rewrite a plant's growth rules and see each generation take shape. | [Open](https://margo-demos.pages.dev/l-system-garden/) | [Download](downloads/l-system-garden.zip) |
| Marching Cubes | Change the wax's surface threshold and watch the lamp's moving forms merge or split. | [Open](https://margo-demos.pages.dev/marching-cubes/) | [Download](downloads/marching-cubes.zip) |
| Path-Traced Voxels | Switch lamps and watch the light reflect off stone and pass through glass. | [Open](https://margo-demos.pages.dev/path-traced-voxels/) | [Download](downloads/path-traced-voxels.zip) |
| Pathfinder | Drag the gold pin. The lead cart finds a route while the other carts make room for each other. | [Open](https://margo-demos.pages.dev/pathfinder/) | [Download](downloads/pathfinder.zip) |
| Pattern Copier | Draw a swatch. The overlapping model grows it into a woven field by matching 3 by 3 neighborhoods. | [Open](https://margo-demos.pages.dev/pattern-copier/) | [Download](downloads/pattern-copier.zip) |
| Pinball | Launch a steel ball into the Aurora cabinet. Strike the bumpers and work both flippers to keep it on the table. | [Open](https://margo-demos.pages.dev/pinball/) | [Download](downloads/pinball.zip) |
| Shape Casts | Sweep a probe across four fittings. Inspect every contacted surface, its distance along the sweep, and the direction it faces. | [Open](https://margo-demos.pages.dev/shape-casts/) | [Download](downloads/shape-casts.zip) |
| Sharp SDF Models | Carve a miniature lightwell by combining two distance fields. Change the channel width and inspect the corners of the regenerated mesh. | [Open](https://margo-demos.pages.dev/sharp-sdf-models/) | [Download](downloads/sharp-sdf-models.zip) |
| Sprite Colliders | Draw a cutout, then drop it. The press traces the solid pixels, including any holes you erase. | [Open](https://margo-demos.pages.dev/sprite-colliders/) | [Download](downloads/sprite-colliders.zip) |
| State Machine Door | Open the vault and switch on the inspection lamp. Hold midway, then resume to see where both states return. | [Open](https://margo-demos.pages.dev/state-machine-door/) | [Download](downloads/state-machine-door.zip) |
| The 2D Buggy | Take a dune crawler across Salt Ridge. Watch its two independent springs follow the trail as the buggy climbs, crests, and brakes. | [Open](https://margo-demos.pages.dev/the-2d-buggy/) | [Download](downloads/the-2d-buggy.zip) |
| The 2D Sandbox | Stack crates at the quarry crossing, build a hinged bridge, then unpin a bank and watch the span fall. | [Open](https://margo-demos.pages.dev/the-2d-sandbox/) | [Download](downloads/the-2d-sandbox.zip) |
| The 2D Skeleton | Raise the keeper's lantern. Reveal the rig to see each joint carry the motion. | [Open](https://margo-demos.pages.dev/the-2d-skeleton/) | [Download](downloads/the-2d-skeleton.zip) |
| The Block Tower | Pull a beam from the stack and see which supports can still carry the load. | [Open](https://margo-demos.pages.dev/the-block-tower/) | [Download](downloads/the-block-tower.zip) |
| The Camera Director | Call a shot at a salt-flat observatory. Follow one survey rover, keep both in frame, or give the antenna camera priority. | [Open](https://margo-demos.pages.dev/the-camera-director/) | [Download](downloads/the-camera-director.zip) |
| The Changing Maze | Slide either wall on the routing table. Only the tiles it touches rebuild, then the shuttle takes the new route. | [Open](https://margo-demos.pages.dev/the-changing-maze/) | [Download](downloads/the-changing-maze.zip) |
| The Conveyor Factory | Start three belts, feed parcels, and watch the chutes sort them into collection bins. Every count comes from a live sensor. | [Open](https://margo-demos.pages.dev/the-conveyor-factory/) | [Download](downloads/the-conveyor-factory.zip) |
| The Coral Garden | Advance a living branching model from its holdfast to a full colony. Turn the current to see how the growth rule leans into the flow. | [Open](https://margo-demos.pages.dev/the-coral-garden/) | [Download](downloads/the-coral-garden.zip) |
| The CRT Arcade | Fly the courier through six inspection rings. Match the lit lane before each crossing. | [Open](https://margo-demos.pages.dev/the-crt-arcade/) | [Download](downloads/the-crt-arcade.zip) |
| The Flow Field | Tap open terrain to move the destination. Twelve thousand moving lights find their way around the ridges. | [Open](https://margo-demos.pages.dev/the-flow-field/) | [Download](downloads/the-flow-field.zip) |
| The Game Menu | Open a tethered ocean survey menu, move through three stations, and keep one tether back to the surface. | [Open](https://margo-demos.pages.dev/the-game-menu/) | [Download](downloads/the-game-menu.zip) |
| The Gear Maker | Cut a fresh set of involute wheels by changing the tooth counts. Turn the input and see both stages mesh at the correct ratio. | [Open](https://margo-demos.pages.dev/the-gear-maker/) | [Download](downloads/the-gear-maker.zip) |
| The Guard | Ring a gallery chime. Watch Rita investigate the sound, search the room, and return to her rounds. | [Open](https://margo-demos.pages.dev/the-guard/) | [Download](downloads/the-guard.zip) |
| The Hex Map | Lead a survey team through a coastal range. Ridges block sight, and every new route fills in the chart. | [Open](https://margo-demos.pages.dev/the-hex-map/) | [Download](downloads/the-hex-map.zip) |
| The Inspector | Slide the lens out, edit the scene tree, then capture the passes that draw the bench. | [Open](https://margo-demos.pages.dev/the-inspector/) | [Download](downloads/the-inspector.zip) |
| The Joint Workshop | Drive two cabinet doors into their mechanical stops and set a jointed pendulum swinging. Show the joint frames to inspect each limit. | [Open](https://margo-demos.pages.dev/the-joint-workshop/) | [Download](downloads/the-joint-workshop.zip) |
| The Marble Maze | Roll the marble from the diamond inlay to the brass-rimmed hole. | [Open](https://margo-demos.pages.dev/the-marble-maze/) | [Download](downloads/the-marble-maze.zip) |
| The Material Factory | Generate a finish, then move the light to see what each of its four maps contributes. | [Open](https://margo-demos.pages.dev/the-material-factory/) | [Download](downloads/the-material-factory.zip) |
| The Meshlet Statue | Slide the gallery wall across a bronze sculpture and see how many triangles Margo submits for the same scene. | [Open](https://margo-demos.pages.dev/the-meshlet-statue/) | [Download](downloads/the-meshlet-statue.zip) |
| The Mocap Theatre | Watch two real walk recordings. Their captured joints move on the left and drive the same performer on the right. | [Open](https://margo-demos.pages.dev/the-mocap-theatre/) | [Download](downloads/the-mocap-theatre.zip) |
| The Noise Lab | Change a single frequency and watch an island, a cloud chamber, and a seamless tile reorganize. | [Open](https://margo-demos.pages.dev/the-noise-lab/) | [Download](downloads/the-noise-lab.zip) |
| The Pixel Platformer | Cross the headland. Collect three prisms and relight the beacon. | [Open](https://margo-demos.pages.dev/the-pixel-platformer/) | [Download](downloads/the-pixel-platformer.zip) |
| The Planner | At the ridge lookout, Nessa needs a hot supper and a rest. Start the rain and watch her plan find dry fuel under cover. | [Open](https://margo-demos.pages.dev/the-planner/) | [Download](downloads/the-planner.zip) |
| The Rewind Button | Roll a brass drum into a stack of ceramic crates. Slide back through the pile-up using the physics engine's saved state. | [Open](https://margo-demos.pages.dev/the-rewind-button/) | [Download](downloads/the-rewind-button.zip) |
| The Rigid Body Rain | Eight hundred blocks and spheres fall into a sculpted basin. Tap any piece to push it. | [Open](https://margo-demos.pages.dev/the-rigid-body-rain/) | [Download](downloads/the-rigid-body-rain.zip) |
| The Sleep Map | Tap a spring bed to wake it. Watch its ceramic beads return to rest. | [Open](https://margo-demos.pages.dev/the-sleep-map/) | [Download](downloads/the-sleep-map.zip) |
| The Snapshot Hall | Walk through a specimen archive. Compare three ways of submitting the same hall to the renderer. | [Open](https://margo-demos.pages.dev/the-snapshot-hall/) | [Download](downloads/the-snapshot-hall.zip) |
| The Streaming City | Fly across a four-sector district and watch building tiles load as they come into view. | [Open](https://margo-demos.pages.dev/the-streaming-city/) | [Download](downloads/the-streaming-city.zip) |
| The Terrain Sculptor | Shape a volcanic basin. Raise the ground, paint a mineral layer, or open the lava tube beneath it. | [Open](https://margo-demos.pages.dev/the-terrain-sculptor/) | [Download](downloads/the-terrain-sculptor.zip) |
| The UI Layout Editor | Drag widgets onto a live Margo screen. Reorder the layers and see the markup update. | [Open](https://margo-demos.pages.dev/the-ui-layout-editor/) | [Download](downloads/the-ui-layout-editor.zip) |
| The Voxel Editor | Shape a working harbor model cell by cell. Paint the signal tower, build a beacon, or select a volume and cut it away. | [Open](https://margo-demos.pages.dev/the-voxel-editor/) | [Download](downloads/the-voxel-editor.zip) |
| Utility Choices | Change the weather in a working orchard. Follow the villagers as they weigh hunger, thirst, and fatigue and book a place to meet each need. | [Open](https://margo-demos.pages.dev/utility-choices/) | [Download](downloads/utility-choices.zip) |
| Voxel World Light | Open the shutter to let amber light reach a corner it can't see. | [Open](https://margo-demos.pages.dev/voxel-world-light/) | [Download](downloads/voxel-world-light.zip) |
