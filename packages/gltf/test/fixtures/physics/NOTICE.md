# glTF physics fixtures

`AnimatedPlatform.gltf`, `AnimatedScale.gltf`, `DrivenHinge.gltf`, `JointPendulum.gltf` and `TriggerVolume.gltf`: published
`KHR_physics_rigid_bodies` sample files under the MIT licence, read 2026-11-06 and unchanged. Their source and credit are in
this folder's row of `THIRD-PARTY-NOTICES.md`.

The `JointTypes`, `ShapeTypes`, `Filtering`, `Triggers`, `MotionProperties`, `Materials_Friction` and
`Materials_Restitution` samples of the extension's author state no licence, so they stay out of the repository. The tests
read them when `MARGO_SPLAT_SAMPLES` names a folder holding `physics/<name>.gltf` and `.bin`, and pass over them when absent.
To get them: `samples/<name>/<name>.gltf` and `.bin` of https://github.com/eoineoineoin/glTF_Physics, commit
9dc61cb3474ff9a51f58d3592f79d5c9e572056a. All seven passed against `applyGLTFPhysics` on 2026-11-07.
