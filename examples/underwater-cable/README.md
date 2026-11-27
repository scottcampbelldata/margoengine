# Below the Swell

## YouTube showcase

The public-facing cut opens behind a diver at the cable joint, moves to a higher view of the survey team, and rises alongside the ship. New camera paths hold on the bow, the hull's contact with the waves and the stern wake. Margo draws the closing title over a wide view of the vessel. The soundtrack follows the regulator exhaust, the surfacing camera and the wake.

Preview the showcase with `/examples/underwater-cable/?cut=showcase` after setting up the assets and server below. Render and assemble the 60-second, 1080p showcase from the worktree root.

```sh
node scripts/run-with-timeout.mjs --max=42 -- node tools/shot/cli.mjs examples/underwater-cable/showcase.shot.json --once --out test-results/below-the-swell-showcase-master
node scripts/run-with-timeout.mjs --max=8 -- node tools/shot/encode.mjs test-results/below-the-swell-showcase-master --out test-results/below-the-swell-showcase-picture.mp4
node examples/underwater-cable/showcase-sound.mjs test-results/below-the-swell-showcase.wav
ffmpeg -i test-results/below-the-swell-showcase-picture.mp4 -i test-results/below-the-swell-showcase.wav -map 0:v:0 -map 1:a:0 -c:v copy -af 'loudnorm=I=-14:TP=-1.4:LRA=9' -ar 48000 -c:a aac -b:a 384k -movflags +faststart test-results/below-the-swell-showcase.mp4
```

Upload `showcase.srt` as the sound caption track for this cut.

## Reference comparison

A one-minute animated subsea cable survey in Margo. The scene opens on the Tripo survey vessel, crosses the waterline, follows a submarine, visits two divers inspecting the joint, returns to the submarine and tracks the cable away along the sand.

The cut matches the 60-second runtime reported by Lume Media and stages the six views timestamped in their dailies. The in-between cuts and camera tracks are reconstructed from the visible reference. All shots and sound are rendered or authored for this scene. [Runtime at 9:24](https://www.youtube.com/watch?v=bIFgfkTdrJo&t=564s) · [Dailies at 8:45](https://www.youtube.com/watch?v=bIFgfkTdrJo&t=525s)

| Film time | Reference view | Margo shot |
| --- | --- | --- |
| 0:03 | Distant ship and swells | Low, slow camera approach |
| 0:12 | Submarine profile | Wide tracking pass |
| 0:24 | Divers on either side of the device | Wide cable-joint inspection |
| 0:28 | Device closer to camera | Joint and divers close-up |
| 0:44 | Submarine framed closer | Second tracking pass |
| 0:59 | Cable along the seabed | Low, forward cable track |

The camera crosses the surface near 0:08 between the first two views. Margo renders HDR sky illumination, wind waves, foam, hull reflections, a waterline and underwater light transport. Both diver rigs use tapered boot profiles, low-profile fin pockets and palms turned down toward the seabed. The wrist computer stays on the back of the hand. Sand geometry supports the cable along its route. The inspection lamps are mounted on the survey camera rig.

## Run the scene

Place the Tripo export at `examples/underwater-cable/assets/tripo-vessel.glb`. Then run these commands from this scene's Margo Engine worktree.

```sh
npm ci
npm run build:packages
node examples/underwater-cable/assets.mjs
npm run dev:examples
```

Open `/examples/underwater-cable/` at the local address printed by the server. The desktop preview uses WebGPU. Pause or scrub with the playback controls. The camera, diver, waves and wake seek on the same shot timeline.

## Render the film

```sh
node scripts/run-with-timeout.mjs --max=36 -- node tools/shot/cli.mjs examples/underwater-cable/shot.json --production --encode --out test-results/below-the-swell-full
node examples/underwater-cable/sound.mjs test-results/below-the-swell-full.wav
ffmpeg -i test-results/below-the-swell-full.mp4 -i test-results/below-the-swell-full.wav -map 0:v:0 -map 1:a:0 -c:v copy -af 'volume=17dB,acompressor=threshold=0.11:ratio=2.6:attack=2:release=50:makeup=1,alimiter=limit=0.77:attack=3:release=25:level=false:latency=true,loudnorm=I=-14:TP=-1.35:LRA=9,volume=2.30dB' -ar 48000 -c:a aac -b:a 384k -movflags +faststart test-results/below-the-swell-full-with-audio.mp4
```

The shot file renders 1,440 frames at 1920 × 1080 and 24 fps with a 180° shutter. Upload `captions.srt` as an English caption track with the film. The optional `?aovs=1` query supplies geometry, depth, world-normal, albedo, and emissive render targets from `SceneTargets` for a diagnostic shot. List the desired names in that shot's `aovs` and set `page.aovs` to `belowTheSwell.aovs`.

## Reference and assets

- The inspection hardware uses the general layout of a cylindrical subsea joint, armoured cable, and end couplings. [PCS Italiana, Cable Accessories](https://pcsitaly.it/index_htm_files/Cable%20Accessories%20-%20full%20range.pdf)
- Wave scale and optical behavior were checked against Alan Fournier and William T. Reeves, [*A Simple Model of Ocean Waves*](https://ohiostate.pressbooks.pub/app/uploads/sites/45/2017/09/fournier-reeves.pdf) (1986), and Curtis D. Mobley, [*Oceanic Optics*](https://ioccg.org/wp-content/uploads/2022/01/mobley-oceanicopticsbook.pdf) (2022). The scene uses the existing Margo water, caustics, and underwater packages.
- The survey vessel is a Tripo H3.1 GLB generated from four original views. It has 332,745 triangles, one material and three embedded 2K maps for base color, roughness/metallic and normals. The scene fits the Y-up, +Z-forward export to a 71.9 m hull with a 15.5 m beam and 6.15 m draft. [Tripo multi-view workflow](https://www.tripo3d.ai/product-doc/model-generation/multi-view-to-3d)
- The 44 m submarine prop uses an unmarked CC0 glTF model from Innerscene. [Submarine asset and license](https://www.innerscene.com/tools/library/3d-parts/nuclear-style-submarine-3ed81485)
- The diver's head uses the CC0 [Grab3D Human Head](https://grab3d.com/models/anatomy/human-head/).
- Dive gear placement and horizontal trim were checked against [NOAA's diver photo](https://www.noaa.gov/noaa-collections/collections/media/4157) and [Divers Alert Network's trim guidance](https://dan.org/alert-diver/article/mastering-neutral-buoyancy-and-trim/).
- The sand, rock scan, weathered steel and overcast sky are CC0 from Poly Haven. [Overcast Soil (Pure Sky)](https://polyhaven.com/a/overcast_soil_puresky). `assets.mjs` pins the asset URLs and published file checksums. [Coast Sand 02](https://polyhaven.com/a/coast_sand_02) · [Coast Rocks 05](https://polyhaven.com/a/coast_rocks_05) · [Rusty Metal 04](https://polyhaven.com/a/rusty_metal_04)

The preview loads the full rock scan and the 14.2 MB vessel GLB. It is a desktop film scene. `assets.mjs` verifies the vessel by checksum and fetches the public scan assets.
