# ANGLE D3D11 (NVIDIA): a 4x RGBA16F resolve rereads as two different images (draft, no standalone repro yet)

Draft for the ANGLE issue tracker (and NVIDIA). Not filed. Margo row: KB5247d (materials dispersion live reset on the WebGL2
compatibility layer). The same defect is written up for the lane that owns it as KB5822a ("ANGLE D3D11 returns two versions of the
MSAA-resolved texture"); this file only adds what the materials case shows. Use KB5822a's folder when it exists.

## Environment

RTX A6000, driver 32.0.16.1742 (617.42), Windows 11, Edge 157, default ANGLE backend (Direct3D 11). ANGLE Vulkan on the same machine is exact.

## Observation (from Margo's records, 2026-11-10)

`node scripts/material-dispersion-gpu-check.js --backend=compat` renders a 57-frame grid on a WebGL2 context. After a live change of one
uniform from positive to zero, the 4x multisampled RGBA16F frame resolves to an image that differs from the constructor-zero image in 10
channels, each by one float16 step (max 0.000244140625), mostly outside the transmissive quad where only the opaque background and the
final 4x resolve touch the pixels. Nine of nine full-grid runs reached the same second image. 1x is exact.

Ruled out in Margo: stale uniforms (the GL call streams are identical but for a 4-byte write), `invalidateFramebuffer`, readback layout,
program variants, engine timing.

## Why there is no standalone repro here

Raw WebGL2 pages without engine code (a UBO-driven refraction shader; a 4x RGBA16F renderbuffer resolve with 3,000 edge triangles, with and
without invalidate; 300 frames each) did not reproduce it: the trigger also needs the earlier resource churn of the full grid.

Nearest standalone evidence on this PC (2026-11-11): `../KB3508/msaa-blend-repeat.html?api=webgl2&frames=300` shows ANGLE D3D11 on the
RTX A6000 returning different resolved bytes for identical commands (10 of 299 frames, 9 distinct images) while ANGLE Vulkan and D3D11on12
give one image. That is a different pixel format and draw (RGBA8, blended), so it shows that D3D11 MSAA on this driver is not repeatable, not that
it is this fault.

## Result on this PC

Dispersion grid not re-run here (it belongs to the webgl2-compat/materials lanes). No standalone repro exists; status: draft only.
