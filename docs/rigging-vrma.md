# VRM animation

The optional `@margoengine/rigging/vrma` entry loads VRMC_vrm_animation 1.0 from GLB bytes, JSON plus supplied buffers, or a URL with external buffers. `readVRMA` and `loadVRMA` are promises with AbortSignal and a default 64 MiB download budget (the shared accessor cache permits up to four times that decoded). Metadata, license fields and extras stay in `document` and `extension`. No renderer is needed to read a file.

`playVRMA(data, animation, avatar, options)` binds the first clip by default, or a clip name/index. It uses the animation package's FK Retarget with full source and target rest world frames, unique humanoid names, optional-bone inheritance and proportional hips-height translation. Rotations use STEP, quaternion LINEAR, or normalized CUBICSPLINE samples. Source rest rotations and non-humanoid ancestors are respected. Target length and scale remain authored. Unavailable target expressions are ignored, available weights clamp to [0,1], and gaze uses extrinsic ZXY yaw/pitch in degrees. The source gaze origin is retained for applications, while the target's own gaze origin/range maps are used for playback.

Playback defaults: looping, speed 1, clip 0, automatic update. `seek` clamps seconds to the clip range; update wraps forward and reverse loops, and stops at nonlooping endpoints. Pausing holds the current pose. With `vrm`, its pose source runs before gaze, expression evaluation and spring simulation in the same update. Without a VRM controller, the player belongs to the model's scene; pass `autoUpdate: false` to drive it manually. Disposal removes the source/plugin and restores the affected transforms, expressions and gaze. Model disposal detaches without writing to destroyed nodes. Consumers should give one writer ownership of each bone; a separately running Animator must not overwrite the same bones.

The VRM controller adds `lookAtGaze` (null by default) for explicit degrees and `addPoseSource` for ordered input producers. These belong in rigging, because the optional avatar controller owns gaze and springs; core and stage are unchanged.

This is specification FK retargeting, not a contact-preserving optimizer: foot sliding from different limb proportions needs the optional animator IK facilities. No speed claim is made. Tiny per-avatar transforms reuse the existing TypeScript sampler and retargeter, without a new CPU-heavy geometry or codec loop.

## Evidence and parity

The public three-vrm-animation API documents humanoid, expression and lookAt tracks; all three are built here, with optional multiple clips, all glTF interpolation modes and explicit cancellation/limits. The standard VRMA specification permits FK retargeting. The independent tests cover combined gaze Euler angles, every interpolation, proportional hip translation, expression clamping, metadata, bad references/cycles/duplicates, network/budget/abort and lifecycle. Renderer evidence uses one motion authored on the real Seed-san hierarchy and retargeted onto Seed-san and VRM1_Constraint_Twist_Sample, whose sources/licenses are in THIRD-PARTY-NOTICES.md. Native WebGPU and full WebGL2 compatibility render nonzero changed pixels and exactly restore the original frame. These are correctness checks, not benchmarks.

New optional entry: 0 B before, 6,091 B gzip after (whole bundle measurement); ceiling 6,295 B. Its glTF reader and retargeter load lazily and remain external package dependencies. The VRM entry measures 10,653 B within its existing 10,739 B ceiling. Core plus stage remains 24,209 B. Splitting further would separate a single loader/playback contract without reducing root cost.

## Clean-room sources

- Tetsuro Shindo and 0b5vr, VRM Consortium, *VRM Animation 1.0* (2024), https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md. Defines humanoid, expression and gaze channels and first-clip default.
- VRM Consortium, *About pose data compatibility* (2024), https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/how_to_transform_human_pose.md. Arbitrary rest frames, missing optional bones and hips-height scaling. The existing Retarget implements the corresponding world-frame mapping.
- Michael Gleicher, *Retargetting Motion to New Characters*, SIGGRAPH (1998), https://graphics.cs.wisc.edu/Papers/1998/Gle98/retarget-preprint.pdf. Contrasts proportional FK initialization with contact-preserving spacetime constraints; the latter is not claimed here.
- Khronos Group, *glTF 2.0 Specification*, animations and accessors (2017, living specification), https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#animations. Checked accessor reuse and interpolation, including cubic quaternion normalization.
- pixiv, *three-vrm-animation public API* (3.x), https://pixiv.github.io/three-vrm/docs/modules/three-vrm-animation.html. Feature comparison from documented API only. No implementation or companion code was read or copied.
