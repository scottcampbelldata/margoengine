# glTF physics fixtures

`AnimatedPlatform.gltf`, `AnimatedScale.gltf`, `DrivenHinge.gltf`, `JointPendulum.gltf` and `TriggerVolume.gltf`: published
`KHR_physics_rigid_bodies` sample files under the MIT licence, read 2026-11-06 and unchanged. Their source and credit are in
this folder's row of `THIRD-PARTY-NOTICES.md`.

The `JointTypes`, `ShapeTypes`, `Filtering`, `Triggers`, `MotionProperties`, `Materials_Friction` and
`Materials_Restitution` samples of the extension's author state no licence, so they stay out of the repository. The tests
read them when `MARGO_SPLAT_SAMPLES` names a folder holding `physics/<name>.gltf` and `.bin`, and pass over them when absent.
