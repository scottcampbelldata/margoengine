# Scene sampling audit

Gzip figures in this note are from this audit. The current build measures core at 18,876 bytes gzip and core plus stage at 21,107 bytes gzip. The gate rejects 25,000 or above.

Desktop WebGPU scenes use 4× MSAA and cap canvas DPR at 1, avoiding an additional
fourfold pixel cost on HiDPI displays. Phone scenes use 1× sampling and cap canvas
DPR at 2. The phone path allocates no multisampled attachments, creates no 4×
scene pipelines, and omits resolve targets. WebGL fallback also disables canvas
antialiasing on phones. Desktop WebGL requests antialiasing; its actual sample
count is controlled by the browser/driver.

## Rendering coverage

| Rendering path | Sampling and ownership |
| --- | --- |
| Core and stage facade | Desktop color/depth 4×, final color resolve to the canvas. Phone depth 1× and direct canvas color. Stage uses the core renderer. |
| `post` Bloom/SSAO, `dof`, `taa`, `tonemap`, `creative` post effects, `transitions` | Scene capture inherits 4×/1×. Optional packages own capture attachments. Persistent/sampleable color and depth outputs stay 1×. |
| SSAO normal/ambient and TAA motion replays | Desktop raster intermediates match the scene's 4× depth coverage, then reduce to 1× data. Phone replays stay 1× and allocate no MSAA intermediates. |
| `water` surface/spray | Inherit scene samples. Desktop foam resolves to 1× history. Phone writes history directly and allocates no MSAA foam target. Refraction/reflection inputs stay 1×. |
| `gltf-pro`, `terrain`, `scatter`, `vfx`, `splats`, `toon` | Scene pipelines and attachments inherit the active scene descriptor. |
| `lines`, `text`, `points`, `controls`, `environment`, `sky`, `scenery`, `video` | Visible GPU draws inherit scene samples. Scenery's 4× sky pipeline is compiled only when used. Point EDL explicitly reads multisampled raster depth where needed. |
| `creative` particles, grass, planet, Earth sky | Visible draws follow scene samples. Phone setup skips unused 4× grass/planet variants. |
| `selection`, `machinery`, `html`, `shadows` | Visible outlines/caps inherit scene samples. Integer picking, stencil/mask data, HTML occlusion data and shadow maps retain their dedicated data formats and sampling rules. |
| `xr` | Stereo geometry uses owned 4× color/depth; color resolves to the native XR layer. A forward-Z depth blit populates its native 1× depth layer. This explicit stereo path is separate from phone canvas rendering. |
| Citadel and standalone conveyor examples | Desktop scene attachments/pipelines/render bundles are 4×. Phone scenes use 1×. Three.js renders to an explicit multisampled scene target before its output pass. |

Compute/storage outputs, picking readbacks, shadow maps, environment prefilter
textures, bloom mips, temporal histories and post-effect ping-pong buffers stay
single-sampled. Packages without GPU scene rendering need no MSAA state.

WebGPU has no depth attachment resolve target. Scene captures explicitly resolve
reversed-Z depth with the maximum of the four samples; XR projection matrices use
forward Z and require the minimum. Captures discard transient samples after their
last use. Desktop passes retain samples when later geometry or depth reads need
them; the phone branch bypasses those attachments and resolves entirely.

## Verification

The sandbox browser test instruments texture creation, synchronous/asynchronous
pipeline creation and every render-pass descriptor before loading the page.
With an iPhone user agent and device DPR 3 it recorded:

| Check | Result |
| --- | --- |
| CSS canvas size | 390×664 |
| Backing size | 780×1328 |
| Effective DPR | 2 |
| Multisampled textures / pipelines | 0 / 0 |
| Resolve targets / discarded color attachments | 0 / 0 |
| WebGPU validation errors | 0 |

The automated browser uses a physical NVIDIA GPU with an emulated phone user
agent/layout. The user separately confirmed smooth movement on their iPhone;
no exact on-device FPS measurement was supplied.

Additional checks cover resize/disposal, sample-count matching, single-sample
picking, SSAO ambient-only composition, temporal reprojection with moving/skinned
geometry, nested post effects, depth preservation, stereo pixels and device
restoration. Packed consumers check all 61 public packages and strict TypeScript
declarations in Bundler and NodeNext modes.

The desktop/phone module matrix covers sky models, water, outlines, scatter,
transitions, HTML occlusion, video and combined/debug rendering. Phone DOF +
tonemap + TAA, SSAO + TAA, creative post + TAA, standalone tonemap and Bloom also
recorded zero multisampled textures, pipelines or resolve targets.

Line, text and point-cloud browser suites pass in both 1× and 4× modes, including
readback captures, depth tests, restoration and galleries. Point EDL compares
matching MSAA coverage samples so partially covered pixels do not invent depth
steps or darken flat surfaces.

The combined core + stage measurement is 19,988 gzip bytes. CI rejects 20,000
bytes or more. Real XR headsets and the complete browser/device matrix were not
tested.
