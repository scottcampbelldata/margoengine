# DOF requires floating-point scene capture

The optional DOF entry accepts native WebGPU and the full or half-float WebGL2
compatibility tier. It refuses the LDR tier with coded `unsupported` and a help
link, before assigning its engine or creating resources. Device restoration
releases its old resources before checking the replacement device. PostStack
already requires floating-point capture for HDR stages; standalone DOF now
enforces the same measured requirement.

The original 64x64 tier fixture's rotated red PBR box, default camera and default
DOF options reproduce the problem without timing. Full and half-float captures
match exactly, with 413 lit pixels. Before repair the LDR capture has 579 lit
pixels, 5.322265625 percent with maximum RGB error above 2, mean maximum-channel
error 2.09423828125 and maximum 6. These exceed the unchanged layer limits of
0.1 percent and mean 0.25. The logical rgba16float capture uses normalized
8-bit storage on LDR, losing HDR range and precision before post-processing;
no later blur or display conversion can restore discarded information.

Six CPU regressions cover default/temporal setup refusal before allocation,
clean registration, subsequent new half-float effects, and release without
replacement allocation on full/half-float to LDR restoration. They fail on the
parent. The package's registered `test:gpu:tiers` runs the existing tier harness
on its new DOF scene: full accepts, half-float matches at every byte, LDR refuses
with the code/link, and every GL/error collector stays empty. No image tolerance,
format substitution, backend implementation, core or stage code changes.
Existing lens/autofocus/temporal GPU suites remain independent requirements.
The default lower-tier scene does not certify every custom lens or temporal
option on every physical lower-tier device.

The root measures 9290 to 9529 bytes minified and gzipped, a 239-byte increase;
its optional ceiling moves from 9297 to 9815. These bytes keep the mandatory
setup/restore capability check and linked diagnostic with the effect. A split
would separate required validation from every DOF use and introduce an
unnecessary feature entry. Core plus stage remains 24209 bytes gzip.

The landing includes the owning sciviz notebook/share dependency repair; the
existing isolation assertions are unchanged. See sciviz-host-backends.md.

Clean-room research compared Mark Callow and the Khronos WebGL Working Group,
*EXT_color_buffer_float* (2017),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/ , with
the same authors' *EXT_color_buffer_half_float* (2022),
https://registry.khronos.org/webgl/extensions/EXT_color_buffer_half_float/ ,
and Kai Ninomiya, Brandon Jones and Jim Blandy (editors), *WebGPU*, Texture
Format Capabilities (W3C, 2026), https://www.w3.org/TR/webgpu/#texture-format-caps .
The WebGL specifications distinguish float-renderable storage from normalized
targets and define the half-float colour-buffer support; WebGPU defines the
logical render-attachment formats. Combine that capability distinction with the
existing empirical parity rule to require the lowest tier that passes, rather
than rejecting half-float along with LDR. No foreign implementation or companion
code was read or copied. No speed or physical-device certification claim.

Reproduce with the package CPU suite, then `npm run test:gpu:tiers --workspace
@margoengine/dof` under the shared GPU lock after building packages. The original
`test:gpu` keeps lens, Autofocus and full compatibility image checks.
