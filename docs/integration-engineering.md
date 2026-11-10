# J6 public CAD-format viewer integration

The `cad` page composes public loaders, usdz, fbx, mesh-edit, selection, cameras,
controls, lod, culling and exporters entries. It extrudes a Margo-authored cube,
compiles its polygon mesh, exports/reads binary STL, exports/reads USDZ, imports
an authored ASCII FBX triangle, and exports the combined GLB scene. It draws
through an orthographic camera with a SOLIDWORKS navigation profile. SOLIDWORKS
is a trademark of Dassault Systemes; the profile implies no affiliation.

Run `npm run build:packages`, then
`npm run test:integration:browser -- --scene=engineering`.
Types: `npm run check:examples-types -- --projects=integration-engineering`.
The runner holds one shared GPU slot and limits each backend scene to 150 seconds.
Evidence: `docs/whitepaper/results/integration-j6-cad.json`.

The STL round trip keeps all 20 triangles, USDZ creates two rendered primitives,
FBX creates one, LOD selects its near geometry, and frustum culling keeps one
visible instance and rejects one at x=2000. Four probes and five scene draws
remain exactly equal before/after actual device destruction/replacement and
between native WebGPU and WebGL2 compatibility. Teardown leaves zero tracked
live device allocations, meshes and plugins. The shared game and resource-ledger
accounting limits are in [everything scenes](integration-everything.md).

This public scene covers STL, USDZ, FBX and GLB polygon-mesh interchange.
The authored cube and triangle are stand-ins for production assemblies; they
prove these public calls compose, not every format option or large-file quality.
The profile is attached and disposed; this fixture does not automate all mouse
gestures. Evidence is from RTX A6000 only. No speed assertion is made.

Clean-room sources compared before composing the fixture:

- W3C GPU for the Web Working Group, *WebGPU* (2026), device and resource lifetime,
  https://www.w3.org/TR/webgpu/.
- Alliance for OpenUSD, *OpenUSD UsdGeom Overview* (26.11, 2026), polygon meshes,
  stage units and `subdivisionScheme = none`,
  https://openusd.org/release/user_guides/schemas/usdGeom/overview.html.
- Autodesk, *Maya FBX Export Options* (2024), ASCII/binary interchange variants,
  https://help.autodesk.com/cloudhelp/2024/ENU/Maya-Basics/files/GUID-FE8DBEAA-C2DD-43B3-9933-4BA4CDDEAA89.htm.
- Library of Congress, *STL File Format, Binary* (2025 description of the 1989
  3D Systems format),
  https://www.loc.gov/preservation/digital/formats/fdd/fdd000505.shtml.

Existing Margo import/export APIs implement these formats. This change adds
composition evidence and no parser algorithm, external implementation or code.
