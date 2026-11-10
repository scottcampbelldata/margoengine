# Stage glTF loader selection

`@margoengine/stage/gltf` inspects the bounded JSON/GLB root response before importing a loader. Static rigid
float32 triangles with opaque constant-colour materials use `@margoengine/gltf`. Textures, non-opaque alpha,
emission, vertex colour, non-triangle modes, quantized vertex attributes, extension payloads and the basic
loader's one-million-vertex limit select `@margoengine/gltf-pro`. Skins, morph targets and animation clips
select the advanced loader plus `@margoengine/animation`, whose player starts paused. Unused extension names
in `extensionsUsed` and application `extras` alone do not select a heavier loader.

Only selected packages are dynamically imported. The root is fetched once, with a 64 MiB budget and the stage's
combined abort signal. Its redirect URL is retained for relative external resources; selected loaders keep
their existing resource validation, download accounting, disposal and fit rollback. A missing selected package
rejects with MargoError code `state`, the triggering feature, package name, install command and help URL.
No silent static fallback discards skin or morph deformation. Basic results have no `pbr`; animation is null.

Regression evidence: `packages/stage/tests/gltf-routing.test.js` denies pro and animation imports while loading
both JSON and GLB plain triangles, and checks the feature-specific missing-pro diagnostic.
`gltf-animation-missing.test.js` denies animation for a real skinned GLB and verifies no scene nodes remain.
`gltf-full.test.js` retains full skin/morph/clip and rollback coverage. No public export signature changes.
Core plus stage root remains 24,209 B gzip before and after; all routing work belongs to the optional glTF entry.

Clean-room research compared Khronos 3D Formats Working Group, *glTF 2.0 Specification*, 2021,
https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html (materials, meshes, skins, animation, extensions and GLB),
with Khronos Group, *glTF Extension Registry*, 2026, https://registry.khronos.org/glTF/.
The schema's feature declarations select capabilities without decoding geometry twice; the selected loader
still validates the entire asset. No other engine source or companion implementation was read or copied.

Optional stage/gltf measures 1,660 to 3,794 B gzip; its ceiling rises from 1,729 to 4,050 B. The bytes pay for bounded feature selection, a single network root fetch and package-specific diagnostics. Splitting the small routing step would add loading and coordination while saving no core/stage root bytes.
