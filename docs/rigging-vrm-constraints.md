# VRM node constraints

`@margoengine/rigging/vrm-constraints` supplies `readVRMConstraints(document)`,
`evaluateVRMConstraint(constraint, frame)` and `addVRMConstraints(model, options)`.
The umbrella alias is `margoengine/rigging/vrm-constraints`.

`addVRMConstraints(model, { animator })` registers a solver after that Animator's
pose, layers and IK. Omit animator to register a pre-update plugin in the model's
own scene. The controller borrows the model. `update()` also works manually.
`dispose()` or `Symbol.dispose` stops updates and restores captured local target
rotations. Model-first disposal detaches it; Animator-first disposal still permits
controller cleanup. A disposed controller rejects update. Importing does nothing.

The readonly constraints array exposes independent records. Only each record's
weight is writable; its default is 1 and its finite range is zero through one.
All weights validate before any pose write. Sources, targets, kind and axis are
immutable. The reader retains the source document, including standard extras,
without mutation. The data remains in gltf-pro when the extension is required;
the controller is an explicit optional installation.

Rotation transfers the source's local rest-relative change. Roll extracts twist
in the destination's rest frame. Aim uses the shortest world-space turn of one
of six signed axes. Dependency ordering refreshes world transforms between
writes; direct and parent-mediated cycles reject. An aim at its own position
holds rest. An exactly indeterminate half-turn swing chooses zero twist;
representable near-singular twists retain their direction. Rest matrices must be
nonsingular TRS. No iteration, timestep or convergence budget is required.

## Evidence

The independent numeric record has 120 public-runtime observations across three
rest configurations, four weights, all roll axes and all signed aim axes. The
reference is pinned to the public 3.5.5 runtime with revision 186, executed in
external engine-bench through an in-memory harness. No implementation source was
read or saved. Unit results agree within 1e-12 up to quaternion double cover.
Validation and lifecycle tests cover immutable references, live invalid weights,
metadata, cycles, reversed chains, Animator order, scene ownership and disposal.

The existing licensed Seed-san and pixiv VRM1 Constraint Twist Sample carry 23
and 14 authored constraints. The browser fixture appends a standard animation
clip to an in-memory copy of each GLB; source assets and permissions stay intact.
It renders them through MToon and real GPU skinning. Native and full compatibility
change 1725 and 460 pixels respectively when constraints are enabled, then restore
exactly after disposal. Native coverage is 5314 / 3696 pixels and compatibility
5317 / 3696. This is RTX A6000 correctness evidence, not a speed or cross-vendor
claim. Run the package's test:constraints:browser command with and without
--compat under the shared GPU lock; both real files run in each invocation.

## Research compared

- Shindo Tetsuro, Su Po-Chang and Obuchi Yutaka, *VRMC_node_constraint 1.0*, 2022,
  https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_node_constraint-1.0/README.md.
  Provides the constraint spaces, axis semantics, weights and dependency contract.
- Przemyslaw Dobrowolski, *Swing-twist decomposition in Clifford algebra*, 2015,
  https://arxiv.org/abs/1506.05481. The projected quaternion avoids an inverse
  shortest-turn ambiguity when extracting roll; singularity handling is explicit.
- Ken Shoemake, *Animating Rotation with Quaternion Curves*, SIGGRAPH 1985,
  https://www.cs.cmu.edu/~kiranb/animation/p245-shoemake.pdf. Weight blending reuses
  Margo's existing quaternion interpolation instead of Euler interpolation.
- Khronos 3D Formats Working Group, *glTF 2.0.1*, 2021,
  https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html. Used for TRS and the
  in-memory animation fixture's accessors and binary container.
- pixiv, *VRMRotationConstraint, VRMRollConstraint and VRMAimConstraint public API*,
  observed 2026-11-10 at version 3.5.5,
  https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMRotationConstraint.html,
  https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMRollConstraint.html,
  https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMAimConstraint.html.
  Only public constructor, state, dependency and update outputs were inspected.

README work is owed in docs/work-lists/readme-owed.md.
