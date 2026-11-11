# ANGLE D3D11 (NVIDIA): a 4x RGBA16F dispersion frame resolves differently after a uniform reset (draft, repro page does not trigger it yet)

Goes to: ANGLE (Chromium), NVIDIA. Not filed.

## Environment
Edge 157, ANGLE D3D11, NVIDIA RTX A6000, Windows 11. WebGPU (Dawn D3D12) and Vulkan give exact results.

## Steps
`node scripts/material-dispersion-gpu-check.js --backend=compat`, failure 9: a 4x multisampled RGBA16F frame with a
refracting dispersion surface is drawn with the dispersion uniform at 0, the uniform is raised for a few frames,
then reset to 0, and the frame is drawn again with identical commands.

## Expected
The reset frame equals the first frame bit for bit (OpenGL ES 3.0 Appendix A repeatability).

## Actual
10 channels differ by one float16 step (max 0.000244140625), in 9 of 9 runs. Vulkan is exact.

## Standalone page
`msaa-half-reset.html` (raw WebGL2, no engine code): 4x RGBA16F MSAA, 3000 dense background triangles, blit resolve,
a refracting quad driven by one UBO uniform that goes live and is reset, with texture and program churn between
frames. Sets window.result {gl, differing, channels, maxDifference, distinct}.

## Results (Edge 157, ANGLE D3D11, RTX A6000)
| query | differing | distinct |
|---|---|---|
| frames=12 | 0 | 1 |
| frames=60&size=512 | 0 | 1 |
| frames=60&churn=64 | 0 | 1 |
| frames=300&live=6&peak=0.2&size=640 | 0 | 1 |

## Next step
Export the recorded WebGL2 session of the failing Margo case with full payloads and replay it standalone; the
hand-built page does not reach the failing state. Related: KB5822a, KB5247d, KB3508.
