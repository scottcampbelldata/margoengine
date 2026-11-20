# Light extension fixtures

- `Example.gltf`, `Example_bufferView.gltf` and `LightProfile.ies`: the published `EXT_lights_ies` sample, CC-BY-4.0, read
  2026-11-06 and unchanged. Its source and credit are in this folder's row of `THIRD-PARTY-NOTICES.md`. The profile names
  NVIDIA as its test lab and is an `IES:LM-63-2019` file.

`EnvironmentTest` (Khronos glTF-Sample-Assets, `Models/EnvironmentTest/glTF-IBL`, exported by Adobe Dimension) is under
the Adobe Stock License, so it stays out of the repository. The GPU check requires its hash-checked shared cache. `MARGO_SPLAT_SAMPLES`
names a folder holding `ibl/EnvironmentTest.gltf`, `ibl/EnvironmentTest_binary.bin` and
`ibl/EnvironmentTest_images/roughness_metallic_0.png` and `_1.png`. Missing or changed files fail with the fetch-skip-assets recovery command. A stand-in cube made
by the check itself covers the rest.
