# Batch 160: outside rendering references

Eight jobs, each with a separate checked commit and push. Reference renderer source is never read.
Reference programs, downloaded standard assets and reference pictures stay in engine-bench;
Margo-owned scripts and logs stay in this worktree. No published speed claim is planned.

| Job | Family / owner | Outside reference and controls |
| --- | --- | --- |
| 1 | Metallic-roughness, gltf-pro | Khronos MetalRoughSpheresNoTextures in the Sample Viewer; matching embedded camera, punctual light, no IBL, neutral display transform. Mitsuba GGX controls where compatible. |
| 2 | Clearcoat, materials | Khronos ClearCoatTest; Sample Viewer, identical asset/camera/light. |
| 3 | Sheen, materials | Khronos SheenTest; Sample Viewer, identical asset/camera/light. |
| 4 | Transmission and volume, materials | Khronos TransmissionTest / AttenuationTest; Sample Viewer and path-traced transport, explicit background and thickness. |
| 5 | Specular and IOR, materials | Khronos SpecularTest / IORTest; Sample Viewer, identical asset/camera/light. |
| 6 | Anisotropy and iridescence, materials | Khronos AnisotropyTest / IridescenceMetallicSpheres; Sample Viewer, identical asset/camera/light. |
| 7 | Environment and IBL, environment | Mitsuba constant-environment and directional environment pictures of sample geometry; fixed linear radiance, no fitted exposure. Reuse batch 168 sunsky rather than measuring sky again. |
| 8 | Clustered and shadowed lights | Cornell box against Mitsuba / Cycles, explicit direct-only and full-transport rows. Reuse batch 168 Cornell/lightmap and staging reference contracts. |

For each job: retain reference provenance and hashes, compare all pixels in a declared fixed domain,
freeze measured budgets without rounding upward, test WebGPU and state/test WebGL2 behavior,
file unexplained losses with a reproducible scene and known cause or explicitly unknown cause.
Fix a clear small package defect with a failing regression test. A reference-model difference is
reported separately from a demonstrated implementation bug. Update claims, reproduction, limits,
operational evidence and build record with each result. Run lint, hygiene, verify and the changed
package checks with hard deadlines before rebasing and pushing. Mark the list row done only after job 8.
