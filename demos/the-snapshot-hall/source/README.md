# The Snapshot Hall

An original nine-metre-wide specimen archive lit by brass and opal lamps. Repeated oak drawers, stone floor tiles, inlaid arches and a teal rosette form one static assembly of 5,428 positioned parts. The hall contains 224,852 submitted triangles before depth rejection. Move the camera up to 12.9 metres down the aisle in any rendering mode.

## One scene, three command paths

| Mode | App commands per frame |
| --- | --- |
| Snapshot | One `executeBundles` command replays 5,428 recorded indexed draws. |
| Separate draws | 5,428 `drawIndexed` calls encode the same parts separately. |
| Instanced | Six `drawIndexed` calls draw the same parts grouped by shared geometry. |

The public Margo Engine pin documents the named SnapshotRendering and MultiDraw capabilities as open engine gaps. The exhibit uses a real Margo FrameGraph pass with the exposed GPU device’s render bundle encoder. A fixed instance stream holds the transforms and finishes of every part. The moving view updates a camera uniform shared by all three paths. It reuses the recorded bundle until the GPU device or render target format changes.

WebGPU runs the recorded bundle. Margo’s automatic and explicitly selected `?backend=webgl2` routes replay the recorded commands into their WebGL2 backend. Both draw the same six instanced groups when Instanced is selected. The instanced path submits geometry families together. The pinned device layer does not expose the optional native `WEBGL_multi_draw` extension as a renderer command.

**App commands** counts only the three submission methods in the table. **CPU encode** measures spent CPU wall time inside the app’s per-frame encode calls, including the single bundle submission call in Snapshot mode. GPU execution, driver replay, allocation, camera changes, render-pass setup and the one-time recording have additional costs. Unresolved durations appear as Under timer. This demonstration makes no end-to-end zero-CPU claim.

## Sources

- W3C GPU for the Web Working Group. *WebGPU*, section “Render Bundles.” Defines recording, reusable bundles and pass execution. [W3C specification](https://www.w3.org/TR/webgpu/#render-bundles)
- Khronos WebGL Working Group. *WEBGL_multi_draw Extension Specification*. Defines the native extension’s distinct multi-draw commands. [Khronos registry](https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/)
- Microsoft. *Creating and recording command lists and bundles*. Describes command list reuse and the scope of driver preprocessing. [Direct3D documentation](https://learn.microsoft.com/en-us/windows/win32/direct3d12/recording-command-lists-and-bundles)
- Trinity College Dublin, *The Long Room*. The recurring vaulted interior and side stacks informed the architectural rhythm. The exhibit’s layout, cabinets, fixtures and finishes are original. [Trinity College Library](https://www.tcd.ie/library/old-library/long-room/)
