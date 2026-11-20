# Volume scatter fixture

- `ScatteringSkull.gltf`: the JSON of the ScatteringSkull sample, from Khronos glTF-Sample-Assets, `Models/ScatteringSkull/glTF`.
  CC0-1.0 (model by Vladimir Petkovic; copyright 2025 Adobe Inc.), exported by Adobe Substance 3D Stager. Its material
  uses `KHR_materials_diffuse_transmission`, `KHR_materials_volume` and the draft `KHR_materials_volume_scatter`.

The 6,964,692 B geometry and the 1,991,579 B thickness map stay out of the repository. The GPU check requires the whole
sample in the hash-checked shared cache, or the `MARGO_SPLAT_SAMPLES` override under `skull/`, with its `ScatteringSkull_binary.bin` and
`ScatteringSkull_images/aoThickness.png`. Missing or changed files fail with the fetch-skip-assets recovery command.
