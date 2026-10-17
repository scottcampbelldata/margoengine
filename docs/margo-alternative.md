# A viable alternative for people tired of Three.js

Date: 2026-10-16. Margo is for developers who are tired of Three.js and want a place to do the same job. It does not have to absorb every Three.js example. It does have to be a complete, predictable engine for the scenes those developers actually ship.

The last measured core plus stage gzip is 21,107 bytes. CI fails at 25,000. A result from 22,000 through 24,999 is inside the allowed band. Optional packages stay out of that file. A feature that needs a new core API does not land.

## What they are tired of

| Three.js habit | What Margo has to do instead |
| --- | --- |
| A large runtime before the first triangle | Core plus stage measures 21,107 bytes gzip; the build fails at 25,000. |
| Disposal that depends on remembering `dispose()` on every texture and geometry | Unmount and `model.dispose()` release the GPU buffers. A test fails if they remain. |
| React Three Fiber's reconciler and a bare `<mesh>` tag | `<Mesh>` and `<Margo.mesh>` are ordinary React components. A bare `<mesh>` stays HTML. |
| A loaded glTF that renders, then silently exports or simulates as empty | `docs/pbr-mesh-triangles.md`. A static model gets a collider, an export, and a CAD part. A skinned model throws on a default collider. |
| A click that misses a deformed character | Skinned picking through `readPickingGeometry`. |
| Materials and shadows that only exist as forum answers | The parity list in `docs/three-parity-next.md` ships in the optional packages, so a modern glTF with those features loads. |

## Who it is for

A developer who wants to load a modern glTF or FBX, see a PBR material and a shadow, and drive it from React. The first file is one import, a canvas, a mesh, and a dispose. WebGPU is required for PBR, image-based lighting, and shadows. WebGL2 draws the basic mesh. That split is said next to the example, not after the reader has a blank page.

`<Mesh>` and `<Margo.mesh>` are the components. A bare `<mesh>` is HTML. Core does not import React. Another framework would be another optional package, built when someone is going to use it.

## What pleasant means

A choice that fails tells the developer. A choice that works does not leak.

- Wrapping a static loaded model in a physics body creates a collider. A skinned model does not invent a bind-pose box. It throws `Skinned mesh needs an explicit collider`. That work is `docs/pbr-mesh-triangles.md`.
- `<Suspense>` around `<Gltf>` stays up until the file is ready, and unmount disposes the GPU buffers.
- A click hits the triangle the pointer is on, including a deformed skinned mesh, through `readPickingGeometry`.
- A missing optional package throws `Install @margoengine/geometry to use <Box>`, not a failed dynamic `import()` with no hint.
- `Stage.fit(mesh)` throws `No geometry` on a PBR node. The loaded-file fit is `model.bounds`. The quickstart calls that.

## Parity stays

`docs/three-parity-next.md` stays the feature list. Sheen, specular, anisotropy, iridescence, KTX2 on the remaining texture edges, texture transforms, eight influences, point and spot shadows, and skinned picking still get built. They land in the optional packages that already own them. They do not enter core, and they do not turn the post into "this replaces Three.js."

The public sentence is the path Margo does today, plus the limits of what is not finished yet. `docs/three-replacement.md` keeps that refusal list until each item ships. A custom reconciler and a Three.js node-material file format stay off the list. Parity here means a Margo scene can do the job, not that a Fiber file runs unchanged.

## Still run before a public post

1. `docs/pbr-mesh-triangles.md`, so a loaded model does not silently export or simulate as empty.
2. The README install line. `docs/after-react-scene.md` is otherwise implemented. Publish `margoengine`, `@margoengine/core`, and `@margoengine/react`, or tell people to clone and run `npm run modern:dev`.

Core stays at or under 19,999 bytes gzip through all four.
