# XR device runs

Every record here is one WebXR session on one real device. Nothing in this folder is simulated: `npm run check:xr-runs`
(a step of `npm run verify`) refuses to count a record from a stand-in, and `--release` fails while a route has no run.

No device has run yet, so this folder holds no records. The open entry in [known-bugs.md](../known-bugs.md) stays until
all four routes pass.

| Route | Session | Drawn through | Needs |
| --- | --- | --- | --- |
| `vr-webgpu` | `immersive-vr` | WebXR's WebGPU binding | A VR headset whose browser has `XRGPUBinding` |
| `vr-webgl2` | `immersive-vr` | The WebGL2 layer's `XRWebGLLayer` | A VR headset with WebXR on WebGL2 |
| `ar-webgpu` | `immersive-ar` | WebXR's WebGPU binding | An AR phone or headset whose browser has `XRGPUBinding` |
| `ar-webgl2` | `immersive-ar` | The WebGL2 layer's `XRWebGLLayer` | An AR phone or headset with WebXR on WebGL2 |

## Add a run

1. Serve the repository over HTTPS, or use the browser's port forwarding to reach localhost: WebXR needs a secure page.
2. Open `/examples/xr-device-check/` on the device. The page shows which sessions it can start.
3. Press the button for a session and stay in it for the 20 seconds, moving your head and using a controller, hand or tap.
4. Answer the four questions the page asks, and press Save.
5. Add the saved file here as `<route>-<device>-<date>.json`. `npm run check:xr-runs` prints what it proves.

A record proves a route when the browser's own `navigator.xr` ran it, at least 300 frames had a viewer pose, a headset
gave 2 views, an input source was seen, nothing failed, the session ran to the end, and the tester answered yes to all
four questions: the scene stood still, the view followed the head, the input reacted, and leaving gave the page back.
