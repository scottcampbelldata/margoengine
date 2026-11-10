# VRM 0.x runtime conversion

Batch 213 job 1 adds only `@margoengine/rigging/vrm0` and its umbrella alias.
`readVRM` remains a 1.x reader. `loadVRM0` converts before gltf-pro creates the
model, so its source document, node list, skinning and runtime avatar agree.
Source bytes and objects are not modified. This does not publish or relicense
an avatar as a new VRM 1.0 asset.

The mapping covers meta and thumbnail image, thumb metacarpal naming, all 17
legacy expression presets and custom names, percentage morph weights on every
node sharing a mesh, material colour/texture binds, first-person annotations,
head-relative gaze offsets and linear range endpoints. Legacy curves and
properties with no exact 1.0 counterpart remain in `extras.vrm0` and are named
in `differences`. Original permissions remain authoritative, following the
Consortium's runtime migration guidance. Missing new permission flags project
to false. No new licence permission is inferred.

Original roots receive a shared 180-degree Y parent turn. This changes -Z to +Z
without touching vertices, morphs, inverse binds, animation accessors or node
indices. Local legacy extension vectors reverse Z; world gravity also follows
the forward turn. First-person anchors other than the head are rebased through
their original matrices. Every legacy spring joint receives its own empty tip,
so branches never claim one joint twice. Leaves use the specification's 7 cm
virtual tip; branching order follows the original child order. Duplicate
spring roots and invalid hierarchies fail with a coded, linked error.

The adapter retains legacy materials for the separate batch 213 MToon job.
This job proves reading and runtime normalization, not toon-shader parity.
The binary helper produces the runtime document with original licence URLs;
it is not a promise of validation as a redistributed VRMC_vrm file.

## Evidence

`packages/rigging/tests/vrm0.test.js` checks DWANGO's real Alicia Solid 0.51
(55 humanoid bones, 48 simulated spring joints), preset mapping, fractional
weights on instanced meshes, permission retention, vector spaces, branches,
gaze rebasing, unchanged binary chunks, malformed input and cancellation.
The existing package browser harness adds a real-asset legacy case. It compares
the converted picture with the original model turned to +Z, checks zero
pixel error, expression changes and neutral restoration, on native WebGPU and
the complete WebGL2 compatibility path. The existing skin, IK and 1.0 checks
remain unchanged. All 222 rigging, ragdoll, umbrella and supply-chain tests pass;
the existing browser harness passes all 17 assertions on each backend. The
real-avatar pixels and hardware are recorded in the accepted results beside
the other whitepaper records. README examples are deferred in readme-owed.md.

The rival's published migration guide documents 0.x loading, separate original
metadata, renamed expression controls and a forward-axis rotation. This entry
provides those behaviours on the existing 1.0 runtime without any rival source
or dependency. Curved legacy gaze versus linear 1.0 gaze is an explicit
Consortium migration difference, not silently discarded input. MToon rendering
is tracked independently as job 2. No timing or speed claim is made.

## Sources compared

- VRM Consortium, *VRM - Extending glTF for Portable Humanoid Avatars*, 2019,
  [SIGGRAPH Asia presentation](https://www.khronos.org/assets/uploads/developers/library/2019-siggraph-asia/VRM-Extending-glTF-for-Portable-Humanoid-Avatars_SIGGRAPH-Asia_Nov19.pdf).
  Establishes the portable humanoid/expression layer, separate from geometry.
- VRM Consortium, *VRM 0.0 specification*, 2018,
  [specification](https://github.com/vrm-c/vrm-specification/blob/master/specification/0.0/README.md).
  Defines legacy fields and percentage binds; its collider schema explicitly
  specifies left-handed offsets.
- VRM Consortium, *VRM-1.0 changes* and *Upgrade compatibility*, 2022,
  [changes](https://vrm.dev/en/vrm1/changed/) and
  [compatibility](https://vrm.dev/en/univrm1/migrate_vrm0/feature/).
  Combined with the old schema to preserve original licence data and report
  linearization rather than claim lossless gaze-curve conversion.
- Shindo Tatsuro, Su Po-Chang and Obuchi Yutaka, *VRMC_springBone 1.0*, 2022,
  [specification](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_springBone-1.0/README.md).
  Defines terminal 7 cm legacy tips, unique joints and ancestor center spaces.
- VRM Consortium, *Coordinate conversion*, 2024,
  [axis conventions](https://vrm.dev/api/coordinate/).
  Distinguishes legacy local extension handedness from the model forward turn.
- Khronos 3D Formats Working Group, *glTF 2.0.1 specification*, 2021,
  [nodes, skins and GLB](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
  A parent transform preserves skin bind spaces and embedded binary data.
- pixiv, *three-vrm 1.0 migration guide*, 2023,
  [public behaviour documentation](https://pixiv.github.io/three-vrm/docs/documents/migration-guide-1.0.html).
  Behaviour inventory only; no implementation source was read or copied.

Fresh-build integration measures this optional entry at 6543 B gzip (6488 B
before main version guard), below the unchanged 6744 B ceiling. Core plus stage
is 24209 B, below 25000 B. This job changes neither core nor stage.
