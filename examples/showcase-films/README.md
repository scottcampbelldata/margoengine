# Margo Engine showcase films

Original 90-second films for the Margo Engine showcase series. Build the engine packages from the verified public main base for playback and export.

## The Robot Cell

The first shot shows the passage through the gauge. The film then returns to pickup, lifting, path verification, passage, seating and the gauge confirmation. The original arm links and joints use the same transforms as the `Robot` collision model. The Margo planner checks the motion between all waypoints against the two gauge jaws. At the housing's 340 mm design width and the 388 mm throat, the nominal gap is 24 mm per side. The gripper is wider and has its own conservative swept envelope.

The cast shells, servo covers, drilled housing and machine cell are original scene geometry. The design used [ABB's IRB 2600 range](https://one.robotics.abb.com/en/Robots/p/IRB-2600) for industrial proportions and mounting context.

## Last Tram

A three-section tram follows a curved twin-rail route into North Yard. Shots cover the headlight reflections, rails and wheel, pantograph, cabin through the windows, braking, and door release. The moving headlights light the terminus as the tram brakes. Margo computes the rain, puddle response, light, screen-space reflections and bloom.

The original tram and depot geometry use [Siemens' low-floor tram portfolio](https://www.mobility.siemens.com/uk/en/portfolio/rolling-stock/trams-and-light-rail.html) as a reference for vehicle proportions and articulation.

Each cabin seat and platform bench has four supports that meet its floor or platform. The cabin seat backs recline about 2.6 degrees from vertical. The destination signs sit in raised bezels on the front and rear cabs. The lens face clears the outer cab bevel, which previously competed with its depth in the moving shots. See the [Khronos OpenGL guide to coplanar surfaces](https://opengl.org/archives/resources/faq/technical/polygonoffset.htm).

North Yard's service depot and four neighboring industrial buildings use the CC0 [Modular Factory Facade](https://polyhaven.com/a/modular_factory_facade) by James Ray Cock. The 12.3 MB retiled GLB uses the original 1K material maps. Margo's PBR glTF importer draws the repeated facade pieces through GPU instancing. To rebuild it, download the 1K glTF asset with its dependencies and run `node examples/showcase-films/assemble-north-yard.mjs <kit-directory> examples/showcase-films/assets/north-yard/industrial-buildings.glb`.

## Above the Treeline

A single rising camera move starts in bunchgrass and pulls back to show the forest thinning above a Rocky Mountain valley. The Biomes alpine placement graph brings shorter firs into sheltered pockets. The fixed terrain anchor holds the ridges through the pullback, and the far forest takes its height from the rendered terrain triangles. The volumetric clouds and aerial haze are rendered with the terrain.

The firs use the CC0 [Fir Tree 01](https://polyhaven.com/a/fir_tree_01) stem meshes and photographs by Rico Cilliers and Rob Tuytel. The Procedural package arranges the photographed needle sprays with a shared branch layout and one set of 1K surface maps for the distance levels. The Sky package reads the post stack's current scene depth, which includes the terrain and masked foliage.

The film uses an 8,192 m square elevation grid centered at 40.314° N, 105.672° W. `assets/continental-divide-dem.u16` stores a 1,025 by 1,025 north-to-south grid with little-endian 16-bit samples. The value in metres is 2,000 plus 0.1 times the sample. The grid was resampled from the public-domain [USGS 3DEP elevation tile n41w106](https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/n41w106/USGS_13_n41w106.tif). The [National Park Service's subalpine ecosystem guide](https://www.nps.gov/romo/learn/nature/subalpine_ecosystem.htm) informed the change in vegetation.

## The Kiln Shift

A hinged firing door opens onto glowing refractory brick and hollow ceramic vessels. The light changes with the door angle through the chamber opening. Embers are depth-faded particles, and a plume at the opening drives Margo's heat refraction. The hinge releases, swings and seats on frames matched to the mechanical sound cues.

The workshop, kiln and ceramic vessels are original models. The [Nabertherm Arts and Crafts kiln catalog](https://nabertherm.com/sites/default/files/2024-04/artscrafts_english_0.pdf) informed the front-loading chamber, insulation, controls and refractory construction.

## Inside a Turbofan

The camera follows blue bypass air, teal core air, a gold fuel feed and orange exhaust. Margo's `FlowPath` from `@margoengine/lines/flow` drives the pulses and endpoint fades from film time, so a frame looks the same when rendered in sequence or when seeking. The flow routes and speeds illustrate the sequence described in [NASA Glenn's turbofan overview](https://www.grc.nasa.gov/www/k-12/airplane/aturbf.html) and [combustor guide](https://www.grc.nasa.gov/www/BGH/burner.html). The moving streamline treatment draws on [Bruno Jobard and Wilfrid Lefer, *Unsteady Flow Visualization by Animating Evenly-Spaced Streamlines*, 2000](https://doi.org/10.1111/1467-8659.00395).

The [Innerscene quarter-cutaway turbofan](https://www.innerscene.com/tools/library/3d-parts/turbofan-quarter-cutaway-e0184203) is CC0. The inspection cover takes its cross section and finish directly from that nacelle, with capped edges and a narrow joint. The fan and housing share a service lift, so the fan stays behind the narrower intake lip throughout the move. The remaining modules separate using Margo's Machinery package. Clearance checks bound the actual mesh triangles against the moving envelopes, following the continuous collision-checking principle in [Stéphane Redon, Abderrahmane Kheddar and Sabine Coquillart, *Fast Continuous Collision Detection between Rigid Bodies*, 2002](https://doi.org/10.1111/1467-8659.t01-1-00587). The sequence illustrates disassembly of the teaching model.

Run `node examples/showcase-films/author-turbofan-cover.mjs --check` to verify the mating profiles, fan and housing clearance, and the generated asset. To regenerate the cover, run the same command without `--check`. The workshop and trolley are original. The support saddles are native B-rep solids with bored fastener holes, exported as STEP by `author-turbofan-fixture.mjs` and imported in the film by the CAD package.

## Inside the Concert Hall

Cedar Hall is an original shoebox hall with raked stalls, a rear balcony and a recessed stage. The camera moves from the house into a capped section that exposes the roof framing, catwalks and ducts. The IFC package imports 60 original IFC4 products from `cedar-hall.ifc`, including 34 duct sections. `author-concert-hall-ifc.mjs` regenerates the model. The acoustic layout draws on [Kahle Acoustics and Altia's Philharmonie de Paris acoustic brief](https://kahle.be/articles/AcousticBrief_PdP_2006.pdf).

The [Innerscene grand piano](https://www.innerscene.com/tools/library/3d-parts/grand-piano-open-lid-b0c88240) and [Poly Haven's Wooden Floor 01 maps](https://polyhaven.com/a/wooden_floor_01) are CC0. The hall's piano motif and room sound and the turbofan's mechanical sounds are original stereo mixes made by `author-technical-audio.py`.

## The Solar Field

The camera starts beside the panel glass, moves under a tracker to show its drive housing and torque tube, then pulls back over the whole field as the panels tilt into the afternoon. The original field layout, trackers and inverter cabinets are set on a fixed terrain clipmap. Margo calculates the sun direction for western Antelope Valley and renders the clouds through the Sky package. The [Argonne utility-scale solar visual study](https://web.evs.anl.gov/solarvis/) and [Mission Springs tracker photo](https://mccmeetings.blob.core.usgovcloudapi.net/mswdca-pubu/MEET-Packet-fef858c0c28e4f75831b3f2817ca363a.pdf) informed the scale and drive assembly. The near ground uses the CC0 [Gravelly Sand surface from Poly Haven](https://polyhaven.com/a/gravelly_sand).

The fixed camera looks along the torque tubes between 19 and 31.9 seconds. The time-lapse advances the simulated sun from late morning into early afternoon during that shot, so the changing panel angle is visible against the fixed posts. The panels tilt east to west around a north–south axis, following the single-axis geometry described in the [System Advisor Model Photovoltaic Model Technical Reference](https://www.nrel.gov/docs/fy18osti/67399.pdf) by Paul Gilman et al. (2018).

Input folder `test-results/four-demos-inputs/solar-v2` holds the Antelope Valley survey. Export the WGS84 bounds `[-118.505, 34.697, -118.341, 34.864]` from [USGS 3DEP](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer) as a 1,025-square F32 TIFF, subtract the centre sample from every elevation and store the row-major grid as little-endian `antelope.f32`. Export the same bounds from [The National Map orthoimagery](https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer) as `antelope.jpg`, 2,048 square. The aerial color blends in outside the modeled field.

## The Scanned Workshop

The daylight potting bench combines a photographic [cactus capture by steam studio / 3D SCAN STUDIO iris](https://www.innerscene.com/tools/library/3d-parts/cactus-spz-b02130a8) with a second [CC0 succulent splat](https://www.innerscene.com/tools/library/3d-parts/potted-plant-splat-e5fe29cf) trained from a Poly Haven mesh. Margo imports SPZ and SPLAT, then renders the two objects with the original bench, garden tools and ceramics. The [Studio Garden panorama by Sergej Majboroda](https://polyhaven.com/a/studio_garden) is CC0.

Save the two captures as `cactus.spz` and `plant.splat` in `test-results/four-demos-inputs/studio`. Resize the tonemapped Studio Garden panorama to 4,096 by 2,048 and save it as `studio-garden.jpg` beside them.

## City to Street

Nine moving shots follow Grant Park from an architectural detail to a 7.5-second establishing view, then to the bridge pylon, globe lantern, rail cut, Blackstone Hotel, sidewalk, and park. The buildings are photogrammetry reconstructed from Matthew Guertin's [Chicago / Grant Park Aerial Photogrammetry Dataset](https://github.com/Matt1Up/chicago-photogrammetry-dataset), CC BY 4.0. The mesh material preserves the photographed light and color. Camera registration used 425 input photographs, with 399 registered in the largest RealityScan component. The location reference also uses the [City of Chicago's building footprints](https://data.cityofchicago.org/resource/tf32-rk4u.geojson) and [USGS NAIP orthoimagery](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer). The orthophoto ends at Michigan Avenue.

The viaduct and track beds are separate meshes, informed by the [Grant Park National Register nomination](https://www.tclf.org/sites/default/files/2024-09/92001075_compressed.pdf) and the [American Concrete Institute's photograph of Balbo Avenue Bridge](https://www.concrete.org/Portals/0/Files/PDF/ACI_S10_Convention_Notable_Concrete.pdf#page=16). The road uses [Asphalt 02](https://polyhaven.com/a/asphalt_02), the sidewalks use [Concrete Floor 02](https://polyhaven.com/a/concrete_floor_02), and the rail ballast uses [Gravelly Sand](https://polyhaven.com/a/gravelly_sand), all CC0. The [CC0 street oaks](https://www.innerscene.com/tools/library/3d-parts/oak-street-tree-detailed-leaves-a273fef9) replace warped scan foliage in two planting beds. Their trunks share the ground grade used by the beds. Perspective-corrected crops from `First_Flight_-9.jpg` fill the missing east-facing surfaces of the Blackstone, its annex and the adjacent Spertus building. Upper roof and side coverage still comes from the aerial scan and remains incomplete in places.

With the RealityScan GLB and its image sidecars exported into `test-results/four-demos-inputs/chicago`, run

```powershell
$city = 'test-results/four-demos-inputs/chicago'
python examples/showcase-films/prepare-chicago-scan.py "$city/grant-park-covered.glb" "$city/tiles" --footprints test-results/four-demos-inputs/chicago-buildings.geojson --trees "$city/oak-street-tree.glb" --facade "$city/source-photos/First_Flight_-9.jpg"
```

The preparer removes unsupported triangles using the registered footprints and writes the tile in the local metric frame. Put the 3,072-square NAIP image for WGS84 bounds `[-87.638, 41.863, -87.609, 41.884]` at `$city/grant-park-naip.jpg`.

## The Observatory Dome

The rolling shutter follows two parallel rails over the crown. Its 2.68 m opening stays the same width across the dome, following the rectangular aperture described in [Georgia State's CHARA dome report](https://chara.gsu.edu/files/chara_technical_reports/tr34.pdf). The dome and telescope align with Jupiter in the Kitt Peak sky on December 9, 2026. Margo's astronomical sky follows the observer's coordinates and time using [CDS V/50, the Yale Bright Star Catalogue](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50). The film increases rendered starlight so faint stars survive video encoding. The original building and telescope are set on CC0 [Rocky Terrain 02](https://polyhaven.com/a/rocky_terrain_02) and [Concrete Floor 02](https://polyhaven.com/a/concrete_floor_02).

The interior shot holds the concrete pier in frame while the fork turns around the azimuth bearing and the tube tilts between the trunnions. Both axes move on screen from 35.15 to 46.5 seconds and then track Jupiter. The independent enclosure axis and altitude–azimuth mount follow the designs described by the European Southern Observatory in [Very Large Telescope Enclosure](https://www.ls.eso.org/sci/facilities/paranal/telescopes/ut/enclosure.html) and [ELT Main Structure](https://elt.eso.org/telescope/structure/).

## The final four showcase films

All four have 90-second shot files and share `showcase-final-four.html?film=<id>`. The original movie slate leaves the
physics-based Precision Run on hold. The four films here have their own stereo scores and sound effects, synthesized
locally by `author-final-four-audio.py` without sampled or licensed tracks. Run that script with the film ID and
`test-results/showcase-<id>.wav`, then capture and export as below.

- **The Village That Builds Itself.** Three worker-solved Wave Function Collapse layouts keep the gate, approach
  and plaza pinned. Matched road edges determine where neighboring tiles connect. The modular buildings draw on the
  parapets and projecting vigas documented in the [National Park Service's *Preservation of Historic Adobe Buildings*](https://www.nps.gov/orgs/1739/upload/preservation-brief-05-adobe.pdf).
  The sand maps are Poly Haven's [Gravelly Sand](https://polyhaven.com/a/gravelly_sand), CC0.
- **Lantern Courier.** Original pixel tiles, a hand-authored eight-frame sprite atlas, two parallax backgrounds and a
  moving `Lighting2D` lantern form a dusk route. The walking cycle triggers separate footfall cues. The close of the
  route lights the repairer's door to acknowledge the delivery.
- **The Voxel Night Shop.** An original 114 × 62 × 89 voxel workshop uses the engine's resampled emissive path tracer,
  with separately timed sign and bench lights and a glazed side window. The camera moves through a permanent cutaway
  wall. The miniatures were built from the room's floor plan and the practical light positions.
- **The Paper Aviary.** Original origami-inspired mesh panels hinge from the crane's creases, then the crane flies
  around a print gallery and lands on a second stand. The wings interpret a folded crane for animation. Ink hatching
  follows the [real-time hatching work by Praun et al.](https://gfx.cs.princeton.edu/pubs/Praun_2001_RH/).

## Running the films

Build packages with `npm run build:packages` from the verified public main base. With the repository examples server running, open `/examples/showcase-films/<film>.html` using the matching `*.shot.json` filename without its extension. The interactive player is silent. The exported films have individually edited stereo mixes.

From the repository root, build each H.264/AAC master and its phone copy. On Windows, install Chrome and put FFmpeg on PATH. The capture scripts render every frame with Margo and use the browser's H.264 encoder.

```powershell
$film = 'above-the-treeline'
$folder = 'test-results/showcase-exports'
node scripts/run-with-timeout.mjs --max=9 -- node examples/showcase-films/capture.mjs "examples/showcase-films/$film.shot.json" "test-results/showcase-$film.h264"
node examples/showcase-films/mix.mjs $film "test-results/showcase-$film.wav"
node examples/showcase-films/export.mjs $film $folder
node examples/showcase-films/export.mjs $film $folder phone
```

Both versions contain 2,160 frames at 24 fps and 90 seconds of stereo audio. The closing card is drawn inside the Margo canvas.

For `inside-turbofan` and `inside-concert-hall`, use `python examples/showcase-films/author-technical-audio.py $film "test-results/showcase-$film.wav"` in place of `mix.mjs`. Python needs NumPy. The hall loads the repository's optional web-ifc runtime from `node_modules/web-ifc`.

For `the-solar-field`, `the-scanned-workshop`, `city-to-street` and `the-observatory-dome`, use `python examples/showcase-films/author-environment-audio.py $film "test-results/showcase-$film.wav"`. These mixes follow the camera and mechanical motion.

## Sound sources

The recording ledger is in `audio-sources.json`. The recordings use [CC0](https://creativecommons.org/publicdomain/zero/1.0/). Each ambience bed uses a continuous recording. Original servo, electrical drive and impact cues follow individual motion events. The master gain is set separately for each film to keep the transient peaks below clipping.

## Showcase films 12–15

These four films run for 90 seconds each. Their shared player is
`examples/showcase-films/showcase-12-15.html?film=<id>`. Rendered scenes,
captions and closing cards come from the native Margo canvas. The opening
shots show a macro view of the specimen, four hooves in motion, the feed
reel, and opening-night arrivals. Each scene has its own camera cuts and
stereo mix. Keep the source assets outside the tracked tree under
`test-results/showcase-12-15-inputs`.

### Inside a Meteorite

[NASA Astromaterials 3D’s EET 79001,2 dataset](https://ares.jsc.nasa.gov/astromaterials3d/sample-details.htm?sample=EET79001-2)
supplies the public-domain photogrammetry, color map, and registered X-ray
CT data for this Martian shergottite. The display uses Margo's scientific
volume renderer, an axial slice, and two GPU isosurfaces. The thresholds
refer to the display PNG attenuation values, with no mineral
classification inferred from a threshold. The grid measures
131 × 185 × 176 samples after reducing an original 1310 × 1854 × 1758
stack with 67.5 µm scanner spacing.

Download the registered web OBJ and JPG from NASA's
[`EET79001-2` dataset](https://ares-a3d.s3.us-gov-east-1.amazonaws.com/samples/EET79001-2/EET79001-2_A3D_EXPLORER_metadata.json)
in `2b_EET79001-2_SFM_Web-Resolution-Model_Coordinate-Registered`.
Save them as `meteorite/sample.obj` and `meteorite/sample.jpg`. From
`4a_EET79001-2_XCT_Web-PNGs_XY`, save every tenth
`EET79001-2_XY_NNNN.png` beginning at 0000 and ending at 1750 as
`meteorite/NNNN.png`. Run
`python examples/showcase-films/prepare-meteorite-volume.py test-results/showcase-12-15-inputs/meteorite`.

### Horse at the Ridge

The bay mesh was generated and remeshed in Tripo Studio as private paid-plan
content. The Blender source binds it to a 26-joint horse armature with
separate scapulae, fore pasterns, pelvis and tail. Each scapula carries its
upper arm and the shared pelvis holds the two hip sockets. The hind-leg
solve couples stifle and hock motion through the walk restart and push-off.
The torso shifts to keep each limb within its reach while the authored hoof
contacts follow the trail grade. Margo renders the skin with dual quaternion deformation.

The reference for conformation was [Oregon State Extension's Horse Hoof and
Leg Anatomy](https://extension.oregonstate.edu/sites/extd8/files/documents/9121/osu-version-horse-hoof-leg-anatomy.pdf).
Walk support and swing draw on the [Hodson, Clayton and Lanovaz forelimb
study (2000)](https://pubmed.ncbi.nlm.nih.gov/10952376/) and their [hindlimb
study (2001)](https://doi.org/10.2746/042516401776767485).
The shoulder follows the role of scapular rotation described by
[Lawson and Marlin (2010)](https://doi.org/10.1111/j.2042-3306.2010.00289.x).
Foreleg load and release follow the carpal and fetlock phases reported by
[Back et al. (1995)](https://doi.org/10.1111/j.2042-3306.1995.tb03029.x).
Hind-leg swing follows the stifle-to-tarsus coordination described by
[Back et al. (1995)](https://doi.org/10.1111/j.2042-3306.1995.tb03030.x).
The diagonal trot poses were compared with [Eadweard Muybridge’s plate 597 (1887)](https://www.nga.gov/artworks/167016-plate-number-597-hansel-trotting-bareback).

Terrain and grass heights share a ground function. The dirt track uses a
spline and a terrain-conforming shoulder. Terrain surfaces use
Poly Haven's CC0 [Rocky Terrain 02](https://polyhaven.com/a/rocky_terrain_02)
and [Gravelly Sand](https://polyhaven.com/a/gravelly_sand). Ground stones use seeded fieldstone geometry from
`@margoengine/procedural` and the dry granite preset in `@margoengine/terrain/rock-surface`.

Save the remeshed Tripo asset as `ridge-bay-tripo.glb` under the inputs
directory. Run Blender 4.5 from the repository root to make the performance,
the corresponding hoof contact schedule and the reusable rig.

```powershell
$inputs = (Resolve-Path 'test-results/showcase-12-15-inputs').Path
blender --background --factory-startup --python-exit-code 1 --python examples/showcase-films/prepare-ridge-performance.py -- "$inputs/ridge-bay-tripo.glb" $inputs "$inputs/ridge-bay-performance.blend"
node scripts/run-with-timeout.mjs --max=2 -- node examples/showcase-films/inspect-showcase-motion.mjs horse-at-the-ridge
python examples/showcase-films/author-showcase-12-15-audio.py horse-at-the-ridge test-results/showcase-horse-at-the-ridge.wav
```

The standalone `ridge-bay-horse.glb` embeds the coat textures and the
`Idle`, `Walk` and `Trot` clips. In a scene, translate along local +Z at
1.50 m/s for `Walk` and 3.22 m/s for `Trot` at normal playback speed.
The clips loop in place on level ground. The matching Blender file has
the same three editable actions and packed textures.

### The Projectionist and Opening Night

The [Microsoft Rocketbox avatar and animation library](https://github.com/microsoft/Microsoft-Rocketbox)
is MIT-licensed. Keep its license and original directory structure in
`test-results/showcase-12-15-inputs/rocketbox`. Use the source character
directories `Assets/Avatars/Professions/Business_{Male_01,Male_02,Male_05,Male_07,Female_01,Female_02,Female_03,Female_04}`
and the four neutral idle and walk FBXs in
`Assets/Animations/all_animations_max_motextr_{static,xy}`.
Run the original preparation script with Blender 4.5 in background mode.
Blender converts and rigs the models. Margo renders the final scenes.

```powershell
$inputs = (Resolve-Path 'test-results/showcase-12-15-inputs').Path
blender --background --factory-startup --python-exit-code 1 --python examples/showcase-films/prepare-showcase-cast.py -- $inputs
node scripts/run-with-timeout.mjs --max=2 -- node examples/showcase-films/inspect-showcase-motion.mjs opening-night
```

The 35 mm projector is original scene geometry. Film routing, the pressure
gate, and take-up follow the
[Christie CineX35 manual](https://www.christiedigital.com/globalassets/resources/public/christie-cinex35-user-manual.pdf)
and the [Library of Congress film projection guidelines](https://www.loc.gov/programs/national-film-preservation-board/preservation-research/film-preservation-plan/film-projection-guidelines/). The projector lens illuminates localized Margo fog volumes through the projection port. The scattering implementation is described in the environment package and follows [Sun, Ramamoorthi, Narasimhan and Nayar, 2005](https://publications.ri.cmu.edu/a-practical-analytic-single-scattering-model-for-real-time-rendering) and [Kulla and Fajardo, 2012](https://onlinelibrary.wiley.com/doi/10.1111/j.1467-8659.2012.03148.x).
The operator's motion is authored around the machine's hand-contact
points. The countdown is drawn into the moving scene.

Aster Hall has three navigable entrances, 96 visitors, and eight rigged
characters. Margo's navigation mesh, crowd avoidance, and skinned
instancing carry the walkers through actual openings and around planter
islands. See [van den Berg et al., reciprocal collision avoidance](https://gamma-web.iacs.umd.edu/RVO/).

### Audio and export

Use `python examples/showcase-films/author-showcase-12-15-audio.py $film "test-results/showcase-$film.wav"`
with the capture and export commands above. Python needs NumPy, and FFmpeg
must be on PATH. Save the following CC0 recordings by the displayed
local names under the inputs folder.

- `hooves.mp3`, [Horses.WAV by Ornery](https://freesound.org/people/Ornery/sounds/233345/).
  Individual hoof strikes are taken from the recording and timed to the animated contact events.
- `crowd.mp3`, [Medium Crowd Chatter by thetrain1919](https://freesound.org/people/thetrain1919/sounds/182738/).
  Opening Night uses one continuous recording across the film.
- `lobby.mp3`, [Busy Room Ambience by Breviceps](https://freesound.org/people/Breviceps/sounds/457043/).
  The auditorium scene uses a short excerpt.
- `projector.mp3`, [Cinema-Projector by Dr. Macak](https://freesound.org/people/Dr.%20Macak/sounds/253758/),
  and `projector-other.mp3`, [Projecteur cinéma by skyn production](https://freesound.org/people/skyn%20production/sounds/86618/).
  These supply the booth sounds after the projector starts. The gate latch,
  switch, and leader are authored in the mix.

### Individual soundtracks and timing

Use a different music recording for each scored film. Use location sound
when the subject supplies the rhythm, including the glass detents, robot
actuation and projector. Third-party audio in these mixes is dedicated to
the public domain under CC0. Keep the release URL for every take, including
both the composition and performance for music. Each film's elements need
their own mix and perspective changes. Mechanical cues follow the
animation's times, and a finished part does not continue clicking. Check
each delivered AAC track after encoding.

| Film | Sound |
| --- | --- |
| First Wake | Surface, bow and submerged recordings follow the waterline cut. |
| The Glass Bench | Studio room tone and the 15 visible ring and dial detents. |
| The Robot Cell | Recorded small gears, motor movement and clamp contacts. |
| Last Tram | Rain, rail and the release, slide and stop of the doors. |
| Above the Treeline | Forest to upland wind perspective. |
| The Kiln Shift | Refractory fire, door and latch. |
| Inside a Turbofan | Separate fan, core air and casing movement cues. |
| Inside the Concert Hall | Bach's *Aria*, played by Kimiko Ishizaka, with distance and reflection changes. |
| The Solar Field | Daytime field and tracker drive. |
| The Scanned Workshop | Workshop room and outdoor sound at the window. |
| City to Street | City square field recording and HoliznaCC0's *Make Funk*. |
| The Observatory Dome | Night insects and distinct shutter, dome and mount sounds. |
| Inside a Meteorite | John Bartmann's *Interstellar Space* and CT display transitions. |
| Horse at the Ridge | Daniel William Lawrence's *Wandering*, hillside ambience, and gait-timed hoof impacts. |
| The Projectionist | Booth room tone, film handling, gate, switch, and recorded 35 mm machinery. |
| Opening Night | Maarten Schellekens' *Sax and Piano*, with the crowd moving from the plaza into the foyer. |

Save these CC0 music recordings under `test-results/showcase-12-15-inputs`.

- `interstellar-space.mp3` — [Interstellar Space • John Bartmann](https://freemusicarchive.org/music/John_Bartmann/Public_Domain_Soundtrack_Music_Album_One/interstellar-space).
- `wandering.mp3` — [Wandering • Daniel William Lawrence](https://freemusicarchive.org/music/daniel-william-lawrence/king-of-the-crow-tree/4-wandering-king-of-the-crow-tree-lawrencemp3/).
- `sax-and-piano.mp3` — [Sax and Piano • Maarten Schellekens](https://freemusicarchive.org/music/maarten-schellekens/public-domain-1/sax-and-piano-free-track/).
- `make-funk.mp3` — [Make Funk • HoliznaCC0](https://freemusicarchive.org/index.php/music/holiznacc0/bassic/make-funk/).
- `goldberg-aria.mp3` — [Aria • J. S. Bach, performed by Kimiko Ishizaka](https://opengoldbergvariations.org/).

The same folder holds the following CC0 field and mechanism recordings.

- `ridge-breeze.mp3` — [Bardenas wind and birds • PLukx](https://freesound.org/people/PLukx/sounds/256125/).
- `ridge-air.mp3` — [Daytime wind and distant birds in a national park • balanced](https://freesound.org/people/balanced/sounds/857824/).
- `workshop-day.mp3` — [Empty-shop room tone • susipekka](https://freesound.org/people/susipekka/sounds/454993/).
- `workshop-window.mp3` — [03 - Birds_stereo • Nordliecht](https://freesound.org/people/Nordliecht/sounds/855953/).
- `city-square.mp3` — [City Square Ambience • PostProdDog](https://freesound.org/people/PostProdDog/sounds/578486/).
- `observatory-night.mp3` — [Night insects, wind in trees, distant traffic • TRP](https://freesound.org/people/TRP/sounds/715678/).
- `chain-motor.mp3` — [Electrical mechanism • xkeril](https://freesound.org/people/xkeril/sounds/869543/).
- `clockwork-drive.mp3` — [Clockwork motor • robindouglasjohnson](https://freesound.org/people/robindouglasjohnson/sounds/698991/).

The Projectionist uses the catalogued room tone from
`test-results/showcase-recordings/room.mp3`. The Glass Bench and
First Wake use the separate source ledger in `examples/demo-audio/sources.json`.

After rendering the older film pictures, replace their audio in a separate
output folder with `node examples/showcase-films/remix-exports.mjs $source $output`.
Check the encoded Glass Bench detents with
`node examples/glass-bench-90/check-sync.mjs "glass-bench-90s-phone.mp4"`.
The script checks the duration, frame count, AAC channels, and the identity
of the copied picture stream. To export new picture and sound for the four
latest films, use `capture.mjs` and `export.mjs` as above.
