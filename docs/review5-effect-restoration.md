# Refused effect restoration (2026-11-10)

DOF, Bloom and SSAO used to release their old resources and call setup on a
replacement device. LDR refusal then left their registered frame passes pointing
at released uniforms and textures. DOF threw an uncoded TypeError on later frames.
PostStack could similarly retain its capture passes after refusing an HDR tier.

Each owner now disposes and detaches when restoration setup fails, then rethrows
the original coded error. Core's existing restoration loop reports its first
error through `engine.onError` after notifying every remaining plugin. No core
change or optional-package import was needed. A refused HDR stack detaches all
its attached children. Already disposed effects ignore stale restore callbacks.
The application can continue rendering without the effects and create new ones
once a suitable device is available. Initial unsupported attachment still throws
before allocation. Native WebGPU and full/half-float devices keep normal restores.

CPU regressions run later frames after refusal, check detachment and resource
release, and check stale callback idempotence. The registered DOF
`test:gpu:restore-tier` exercises actual device destruction/replacement for
default and temporal DOF, standalone Bloom, standalone SSAO, and a PostStack
containing GTAO, DOF and Bloom. Starting from full and half-float gives ten cases:
each replacement is LDR, each reports exactly one `unsupported` error with a help
link, and each renders three later frames without attached effects or GPU errors.
The test masks WebGL extension support on the RTX A6000 to force the tier; it does
not certify physical lower-tier hardware. No timing or performance claim.

Reproduce after `npm run build:packages`: run `node --test --test-timeout=120000
packages/dof/tests/*.test.js packages/post/test/*.test.js`, then
`node scripts/gpu-lock.mjs run --owner=review5-restore --gpu=actual-device-tier-restoration --max=5 --wait-max=60 -- node packages/dof/tests/gpu/restore-tier-check.mjs`.
Run the packages' existing GPU suites on native WebGPU and WebGL2 as well.

Research compared Kai Ninomiya, Brandon Jones and Jim Blandy (editors), *WebGPU*
(W3C, 2026), device loss and resource lifetime,
https://www.w3.org/TR/webgpu/#device-loss ; Mark Callow and the Khronos WebGL
Working Group, *EXT_color_buffer_float* (2017),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/ , and
*EXT_color_buffer_half_float* (2022),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_half_float/ .
The format capability standards explain the HDR tier requirement, whereas the
WebGPU lifetime model requires old resources to be discarded on device loss.
The engine's existing error/reporting contract determines the single notification.
No foreign implementation or companion code was read or copied.

The locked-toolchain package build measures DOF at 9529 to 9538 gzip bytes and post at 42105 to 42126 bytes. Existing optional ceilings remain sufficient. Core plus stage stays 24209 gzip bytes; users who do not import these effects receive no additional code or work.

README phase validation (2026-11-10): DOF and post now include runnable initial
unsupported-attachment and engine.onError restoration examples. Run
`npm run check:readme-run -- --packages=dof,post` after building packages.
The separately recorded [SSGI ANGLE D3D11 difference](review5-ssgi-angle.md)
is accepted by Scott's coordinator for this landing; its exact assertion remains
unchanged. Native post, DOF optics/compatibility, post looks on both backends,
remaining compat post leaves and masked HDR-tier cases retain their normal gates.
