# Path-Traced Voxels

**Exhibit 135.** The numbered v2 brief marks this entry **YouTube only** and calls for “a MagicaVoxel scene path traced with emissive lights and glass.” This public browser companion preserves the same rendering subject and gives viewers a direct comparison and live tracing controls.

Afterglass is an original miniature pavilion. Switch between the two slotted lamps and watch the stone take on their color. Make the stepped glass column opaque to compare how the same shape appears without transmission.

## Rendering

- **Path-traced reference.** The first view shows one of four complete Margo traces made from the same scene. The two controls choose the lamp and column material and paint the corresponding measured result. These 960 × 840 frames were captured at 160 samples per pixel with the pinned engine, then encoded as WebP. The mean encoding error stayed below 1.1 levels out of 255 in every channel.
- **Live path tracing.** Start live trace imports the original MagicaVoxel model and builds the same scene on the current device. Native WebGPU is tried first and full Margo WebGL2 compatibility is available. Live switches update the material table and restart accumulation. The current live sample count is shown below the viewport. Show reference switches the view back to the matching high-sample capture.
- **Model.** The 62 × 48 × 32 cell file contains 16,820 occupied cells, two fixtures with 36 emissive cells each and 1,145 glass cells across three material IDs. The .vox contains genuine MATL glass and emissive materials. The opaque comparison changes only the three glass materials, keeping their color and the entire occupancy grid. One cell is one scene unit and the scene is framed as a tabletop object.

The early reference control and the live compile are separately measured. The reference route exists because compilation of the released tracer's shader exceeds the showcase's cold start gate on this machine. Both render sizes use the same scene, camera projection, trace settings and reference image assets. Live resolution follows the viewport with a common cap.

All source art is original. The renderer, file writer and material conversion are from public Margo main at **0efd9cff8230507a32deb49907ecd499d46925f5**.

## Verification

From the gallery root set MARGO_ENGINE_CHECKOUT to the built pinned public checkout. Run the following procedures under a bounded timeout.

~~~text
node qa-output/path-traced-voxels/check.mjs
python qa-output/path-traced-voxels/check-pixels.py
~~~

Set PATH_TRACED_LIVE=1 to test actual live rendering. A public route can be supplied as PATH_TRACED_VOXELS_URL. Browser tests check trusted touch or click, whether the selected image has painted, all four reference SHA-256 hashes, and both live material changes. The isolated artifact regeneration uses tools/write-model.mjs, qa-output/path-traced-voxels/capture.mjs and qa-output/path-traced-voxels/pack-references.py.

Reference first touch was 0.940 s, 0.967 s and 0.967 s on cold 390 × 844 phones emulated at 2× device pixel ratio, 150 ms network latency, 1.6 Mbps download and 4× CPU throttling. The three measurements represent WebGPU available, automatic WebGL2 and forced WebGL2 profiles. The selected result increases red in the warm stone patch by 70.3 levels and blue in the cool patch by 52.4 levels. The glass-to-opaque comparison visibly changes the central column.

After the explicit live request, the first rendered trace appeared in 8.614 s on the throttled native phone, 4.565 s on native desktop and 32.420 s on the throttled phone forced to full WebGL2 compatibility. These live times are separate from the reference interaction times.

## References

- Ephtracy, [MagicaVoxel .vox format extension specification](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox-extension.txt).
- John Amanatides and Andrew Woo, 1987, [A Fast Voxel Traversal Algorithm for Ray Tracing](https://www.eecs.yorku.ca/~amana/research/grid.pdf).
- James T. Kajiya, 1986, [The Rendering Equation](https://doi.org/10.1145/15886.15902).
- [Pinned Margo voxel path tracer and its WebGL2 compatibility notes](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/voxel-pathtracer).
