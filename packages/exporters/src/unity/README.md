# Margo Unity exact support 0.3.0 — isolated source draft

This is a proposed source-only policy revision. It is not installed or natively
accepted; the canonical 0.2.0 candidate remains unchanged. Applying this draft
also requires the public file API to deliver support version 0.3.0 and its new
manifest hash. No sidecar field change is needed: the support version fixes the
controller policy `margo-unity-source-clock-v1`.

This optional support package implements `margo-unity-exact-v1` for Unity
6000.6.7f1 and official glTFast 6.20.0. Install the immutable support artifact
separately from per-asset bundles. Manual extraction can overwrite files; neither
archive is an installer or a destination conflict preflight.

Each opt-in asset has fixed siblings `model.glb`, `atlas.png`, and
`margo-profile.json`. Copy the bundle to its declared `Assets/` folder without
renaming. The profile binds exact source bytes and the installed
`support-manifest.json` hash. Native support validates the executing package
identity, full payload hashes, source inventory, sampler, dimensions, animations,
requested collider policy and output ownership before saving generated assets.

The official raw GLB import remains untouched and unindexed. This package owns a
second, isolated public glTFast invocation for the explicit target. Public Unity
`Object.Instantiate` clones preserve its native meshes, materials and clips;
all generated references point to owned clones before the original importer is
disposed. There is no private importer API or new geometry, skin or curve kernel.
Stable resource filenames and source IDs preserve generated GUIDs only within
the compatibility boundary below. This is not a promise of raw-import object identity.

PNG bytes remain unchanged. Public native PNG decoding supplies `Color32` pixels
in native row order to a readable RGBA32 texture with sRGB data, one mip level,
Point/Clamp sampling and zero anisotropy. No resampling, gamma correction or
custom PNG codec is applied. Source-exact native pixel/geometry/skin/animation
acceptance is a separate gate; package delivery alone does not certify it.
The public material `mainTexture` must identify the imported atlas and then the
owned atlas after rewiring/reload. The pinned glTFast built-in shaders declare
`baseColorTexture` as `[MainTexture]`. Missing/unsupported shader bindings reject
before output writes; this profile does not guess property names or accept an
unbound atlas merely because its stored pixels exist.

Use the generated `model.Margo/model.prefab` only after
`ImportCompanion.IsCurrent(sourcePath, out report)` succeeds. It revalidates the
actual current support/profile/source tuple and saved invariants. Stored
`report.json` is the last attempt snapshot; arbitrary support upgrades do not
proactively rewrite every prior report. Reimport the selected source or a fixed
sibling to request regeneration. There is no global startup scan, package
installer, legacy generator-only fallback or project-setting mutation.

The public report uses `error == null` for no error and `lastSuccessful == null`
when no successful generation exists. Unity's inline `JsonUtility` storage can
write those null classes as fully blank objects. The reader validates every
expected field and type before restoring only those completely blank values to
null. Nonempty or whitespace errors, partial-output errors and partial success
tuples remain present; malformed storage is rejected. A blank stored object
never supplies a current or successful generation.

The async API is `Task<bool> ImportCompanion.GenerateAsync(string sourcePath,
CancellationToken cancellationToken = default)`. Await it from the Unity editor
context; do not block the editor thread with `.Result`/`.Wait`. Generation holds
one balanced public assembly-reload lock only through the asynchronous
controlled import/resource lifetime and release it last in `finally`. This can
briefly delay an editor reload; it changes no persistent project setting. Pass
a cancellation token with the caller's bounded operation deadline. Quit and
changed-input cancellation also request cleanup. Native cancellation/reload and
leak behavior still require acceptance evidence before promotion.

Asset callbacks
coalesce only changed fixed siblings. Imported/deleted/moved source siblings
mark already-owned readiness not-current before asynchronous regeneration.

The ready generation binds exact owned resource and `.meta` file hashes, GUIDs
and types together with owner schema2 semantic identities. Editing generated content makes `IsCurrent` false. Retained authored
renderer-disable/Rigidbody overrides are explicit target behavior; readiness is
not a new claim that such overrides match the source rendering or physics.

An unowned output folder or filename conflict is rejected. Prewrite rejection
preserves previous generated resources and records not-current state only in
verified owned output. Updates across multiple AssetDatabase files are not
atomic. Any failure after writes begin records `stale`, `companionIsCurrent:false`
and `partialOutput:true`; earlier files/references may already have changed.
An initial recorded partial attempt can retry only the exact same bound
profile/source/support/identity tuple; its preparing report binds
`identityManifestSHA256` before the first resource save. A complete recorded
controller without a prefab is checked without resetting its graph. A partial
or unsupported graph is rejected for explicit recovery review. A previously
successful same-identity update authenticates its semantic metadata and recorded
file inventory against the prior last-success digest; allowed renderer/Rigidbody
prefab changes are inspected separately and do not become identity history.
An input callback can replace a stored attempted tuple with not-current state;
that does not create permission to recover an unbound initial partial attempt.
A crash between native file
creation and recording its GUID can leave an ambiguous unrecorded file. It is
rejected and requires explicit user review/manual recovery, never silent
adoption or a promise that reimport alone can repair it.
Never delete foreign assets to repair a conflict. No missing collider or curve
is silently skipped and accepted. `generateColliders:false` explicitly creates
zero colliders while retaining helper visibility policy.

Version 0.1.0 and its historical 776 workflow checks, and the narrower 0.2.0
native evidence, remain separate. Version 0.3.0 requires new native clock,
identity/update, save/reload and failure/recovery evidence. Humanoid, arbitrary
cross-rig retargeting and other runtime profiles are not implied.

The versioned source clock is one enabled root Generic Animator, null Avatar, speed1,
Normal update, no root motion and AlwaysAnimate. Its exact owned controller has
one Base Layer with Override blending, weight1, no mask, sync, IK or parameters.
There is one state per source clip in source order. The first source clip is the
default even when another clip is named Idle. State names and motions match the
ordered source identities, speed1, offset0, no mirror/feet IK, write defaults
enabled and no parameter bindings, transitions, nested machines or behaviours.
Unlisted controller subassets or effective motion overrides are rejected.
Existing unsupported edits are rejected before resource writes, then checked
again after asynchronous import and after serialization. They are never reset.
An existing stored or post-save prefab root must have activeSelf=true. A disabled
Animator or deactivated stored prefab is rejected rather than silently enabled
on regeneration. The temporary import root deliberately stays inactive; this
policy does not constrain activation of runtime instances.

Owner schema2 records the exact ordered `(animationIndex,name)` list, and each
deterministic native mesh filename's `(meshIndex,meshNumeration,sorted source-ID
reference set)`, including shared meshes. Its intended owned filename/type set
is exact. Names/IDs use strict UTF8 Base64 framing in the identity digest, so
tabs, newlines and Unicode cannot make digest records ambiguous. Prior semantic
metadata must match its recorded last-success digest before it is used to
authorize an update. Unknown/older owner schemas require a fresh target.

Compatible geometry/topology, PNG, curve, FPS or loop changes may retain GUIDs
when that entire identity mapping stays the same. Clip rename/add/remove/reorder
or transitions to/from zero clips; mesh reference reassignment, deletion,
renumbering, changed split inventory; and surplus old owned files require a
fresh target. No old clip, mesh, state or controller is deleted, silently adopted
or assigned to a different source identity. Declared renderer-disable/Rigidbody
overrides continue through stable source IDs; this is not source pose/physics
acceptance for an overridden target.
