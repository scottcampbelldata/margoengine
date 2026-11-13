# Storm Light

A lighthouse on a rocky headland at night as a storm builds. The beam sweeps through rain and fog in real light shafts,
the sea heaves and breaks on the rocks, a fishing boat rides the swell, and one slider takes the night from calm dusk
to full gale. Everything moves live in WebGPU.

## What it shows

- **The beam.** Two opposite spot lights from the lens, 1.5 million candela each, turn once every twelve seconds. They
  light the froxel fog of `@margoengine/environment/volumetric`, and `LocalShadows` from `@margoengine/clustered` lets
  the lantern's astragals and the gallery rail cut them. A small additive sprite is the lens as the eye sees it, flaring
  when a beam swings toward the camera.
- **The sea.** `@margoengine/water`: three Gerstner swell trains from the south-west, Fresnel reflection of the sky,
  moon glints, refraction of the rocks below the surface, and the headland's height map coupling the sea to the shore
  for run-up, breakers, foam and spray. The far sea fades into the rain haze so it meets the sky without a seam.
- **The sky.** `@margoengine/sky`: a stylized night with the moon behind an overcast deck of real 3D cloud
  (`VolumetricClouds`), rain and lightning from `@margoengine/sky/weather`. A flash lights the clouds, the cliffs and
  the sea for a moment. Click the sky to strike lightning toward where you clicked.
- **The light.** Moonlight casts shadows through `@margoengine/shadows`; the cottage windows, the lamp post, the boat's
  mast and cabin are small clustered lights, and a cool fill from the open sea keeps the cliffs' form in the dark. TAA,
  bloom and AgX tone mapping finish the frame.
- **The boat.** The sea is read back from the GPU (`WaveQuery`) under the hull, and a damped spring per axis eases the
  boat toward that pose, so it heaves, pitches and rolls with the swell. Its cabin glow runs across the water toward you.

The Storm slider drives wind, rain, swell height (0.25 to 2.2 m), cloud cover, fog density, haze and the lightning rate
together. With reduced motion the camera stays put, the beams stand still and there is no lightning.

## Run it

```sh
npm ci
npm run build:packages
node scripts/dev-examples.mjs
# http://127.0.0.1:5173/examples/storm-light/index.html
```

URL options: `storm=0..1` sets the slider, `tour=0` skips the opening camera tour, `view=x,y,z,tx,ty,tz` places the
camera, `beam=<radians>` holds the beams at one bearing (for stills). `npm run test:storm-light` builds the page and
checks it in a real browser.

## The model

The headland, lighthouse, cottage, jetty and boat are modelled, textured and baked in Blender by the scripts in
[blender/](blender/): `build_scene.py` writes `assets/storm-light.glb`, `assets/boat.glb`, the shore height map
`assets/headland-height.bin` and `assets/scene.json` (where the lamp, windows and boat lights are). Then
`node examples/storm-light/blender/compress.mjs` stores the geometry with `EXT_meshopt_compression` and
`KHR_mesh_quantization` using `@margoengine/exporters`, which takes the main model from 8.92 MB to 5.23 MB.

```sh
blender -b --factory-startup -t 4 --python examples/storm-light/blender/build_scene.py
node examples/storm-light/blender/compress.mjs
```

## Limits

- The cloud deck is lit by the moon, the night sky and lightning, not by the beam: `VolumetricClouds` takes the sky's
  lights only. The beam's glow in the rain haze below the deck stands in for it.
- The water takes glints from up to two directional lights, so the cabin's glow on the sea is a drawn streak, not a
  reflection the water computes.
