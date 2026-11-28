# First Wake

A 97-second Margo Engine film. A survey ship leaves Berth 04 at dawn. The camera follows its wake as it spreads and thins behind the stern.

Play the scene with the repository's Vite server and open `/examples/first-wake/`. Render the master with the shot runner.

```powershell
node tools/shot/cli.mjs examples/first-wake/shot.json --once --out test-results/first-wake-master
node examples/first-wake/sound.mjs test-results/first-wake.wav
```

The scene uses the public Margo packages for camera, glTF PBR, materials, geometry, environment lighting, fog, screen-space reflection, filtered water, Kelvin wakes, underwater optics, tonemapping, and titles. The picture is rendered entirely in the engine. The soundtrack uses [CC0 harbor, engine, water and hydrophone recordings](../demo-audio/README.md) cued to the shot timeline.

Private asset inputs are kept under `assets/`:

- `tripo-vessel.glb` is Scott's Tripo survey vessel. Blender removed the fused propeller from the textured hull and rebuilt it as a four-blade bronze screw on the original shaft axis. The exports are `survey-hull.glb` and `survey-screw.glb`. Margo animates the screw.
- `dawn.hdr` is the 4K Radiance HDR version of [Qwantani Sunrise (Pure Sky)](https://polyhaven.com/a/qwantani_sunrise_puresky), by Greg Zaal and Jarod Guest, CC0.
- `concrete-*.jpg` are the 1K diffuse, OpenGL normal, and ARM maps from [Concrete](https://polyhaven.com/a/concrete), by Rob Tuytel, CC0.
- The harbor uses pinned LOD0 [Quay Wall Straight](https://tevy.dev/models/quay-wall-straight) and
  [Quay Wall Straight with Bollard](https://tevy.dev/models/quay-wall-straight-bollard) v1, the
  [Harbour Container Crane](https://tevy.dev/models/harbour-crane) v2, the [Harbour Control Office](https://tevy.dev/models/harbour-office) v1,
  the [20 ft Shipping Container](https://tevy.dev/models/shipping-container-20ft) v1, and the [Steel Warehouse](https://tevy.dev/models/warehouse) v2.
  These tevy models are CC0 1.0.
- The berth sign, signals, mooring lines, camera tracks, titles, and sound were made for the film.

Water's opaque-depth contact foam follows the imported hull. ShipWakes supplies the swept bow crest and stern trail. The camera-following water grid uses 0.375 m cells along the channel in the close shots. The wake hull is fitted to the GLB's 68.68 m waterline, with its center 1.02 m aft of the model's midpoint. The 71.9 m overall length includes the rake of the bow above water. The film adds a slow roll around the ship's longitudinal axis at a period consistent with the [2008 IMO Intact Stability Code](https://www.imo.org/en/ourwork/safety/pages/shipdesignandstability-default.aspx). A continuous tracking shot travels down the submerged starboard side to the turning propeller and rudder. Its camera carries a floodlight.

Run `prepare-propeller.py` with Blender in background mode. Pass the source `tripo-vessel.glb` and the destination asset directory after `--`.
