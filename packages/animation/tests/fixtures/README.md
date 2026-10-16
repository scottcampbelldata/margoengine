# Eight-influence production fixture

`node scripts/animation-influences-browser-tests.js` caches the unmodified
Babylon.js octopus rig in `test-results/animation-octopus.glb`. The binary is not
redistributed in this package or repository.

- Source: [Babylon.js Assets, octopus_customRig.glb](https://github.com/BabylonJS/Assets/blob/a6c64e15d8f12d1e81328c553353f86810081788/meshes/octopus_customRig.glb).
- Attribution: Babylon.js Assets contributors, **CC BY 4.0**, under the
  [repository license](https://github.com/BabylonJS/Assets/blob/a6c64e15d8f12d1e81328c553353f86810081788/LICENSE).
- Pinned commit: `a6c64e15d8f12d1e81328c553353f86810081788`.
- SHA-256: `28981df80e5232ccbc335d746c37b446df157fa2517e82b0f242d57eec54d154`.
- Size: 18,471,872 bytes. Maya 2018 / Babylon glTF exporter.
- 48,222 vertices, 91 joints, seven animation clips; 1,552 vertices have nonzero
  `WEIGHTS_1`, with up to five active influences. Both joint sets use unsigned
  16-bit indices, and both weight sets use Float32 values.

The test loads the original GLB through `loadGLTF`, compares GPU position,
normal, and tangent deformation with an independent CPU skinning reference,
and poses a joint used by the secondary set. A four-influence truncation acts
as a negative control. Synthetic tests exercise all eight active influences,
normalized integer weights, morph-before-skin order, and a 1,001-joint palette.
