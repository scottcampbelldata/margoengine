# MagicaVoxel and Margo: feature table

MagicaVoxel 0.99.7.2 against `@margoengine/voxel-pathtracer` (on main since 2026-10-20; rows re-checked against the
packages on main `da95929c`, 2026-10-21). Every
number was measured on the same PC (RTX A6000, Windows 11; Margo in Edge, headless WebGPU) at 960 x 800 unless a row
says otherwise. MagicaVoxel was used as a black box: we wrote scenes, it rendered them, we compared its PNGs with ours
(method and scenes: [magicavoxel-parity.md](magicavoxel-parity.md)).

Legend: **yes**, **no**, **open** (MagicaVoxel has it, Margo does not match it yet), **not checked** (not looked at).

## At a glance

| | MagicaVoxel | Margo |
| --- | --- | --- |
| What it is | Free desktop voxel editor with a built-in path tracer | Path-tracing renderer for web apps and games (WebGPU, in the browser) |
| Size | about 30 MB application | 70 KB gzip (the whole renderer: 69,634 B, gzip -9 of `dist/index.js`, 2026-10-21) |
| 1024 samples (default scenes) | 14-15 s | 1.7-1.85 s, about 8x faster |
| Time to MagicaVoxel's 1024-sample noise level | about 14 s | 0.48 s (64 samples, denoised), about 29x faster |
| Noise at 1024 samples (8-bit RMS against a 16,384-sample reference) | 0.32 | 0.24 raw, 0.16 denoised |
| First lit image after opening a scene | not measured | 0.36-0.44 s (preview while the full tracer compiles) |
| Same image as MagicaVoxel from a `.vox` file | | 99.3-99.97% of pixels within 3 of 255 levels on six default-lit scenes |

## Files

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| Open `.vox` models, palette, materials, scene graph | yes | yes |
| Use the file's render settings (sky, sun, film, fog, display) and camera | yes | yes (`magicaVoxelLighting`, `magicaVoxelCamera`) |
| MagicaVoxel's look, or the same scene lit physically | its look only | both (`look: 'margo'`: sun highlights on metal and glass, light through glass, rough metal keeps its energy) |

## Materials

| Material | MagicaVoxel | Margo |
| --- | --- | --- |
| Diffuse, metal, plastic, glass, emitter | yes | yes, each matched within 3 levels on the calibration boards |
| Cloud (scattering medium) | yes | yes |
| Subsurface | yes | yes; sky- and sun-lit tops within 1.2-3.8 levels at diffuse caps 2 and 4 (one density measured) |
| Partly transparent glass | yes | yes, 64 of 64 calibration tiles within 3 levels |
| Blend material | yes | yes; 126 of 128 calibration tiles within 3 levels, all within 6 |
| Rough metal and rough glass that keep their energy | metal: no (measured); glass: not checked | yes (within 0.79% of white in a white sky) |
| Glass dispersion (rainbow splitting) | not checked | yes |
| Glowing media (fire, gas) | yes (emissive cloud) | yes |
| Area lights (rectangle panels) | not checked | yes |
| Block textures (pixel art per voxel face, see-through texels) | no (its files hold palette colours only) | yes, tiled like `@margoengine/voxel`'s block games |

## Light and sky

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| Uniform sky, sun with soft shadows, ground | yes | yes |
| Atmosphere sky (sunrise, sunset) | yes | yes; 98.7-100% of pixels within 3 levels |
| Image (HDR) sky | yes | yes; 99.76% on a lit scene |
| Fog | yes | yes; 99.5-100% on 9 fog scenes |
| Sun highlights on metal and glass | no (measured: the sun lights diffuse surfaces only) | yes in the Margo look |
| Sunlight aimed through glass and off mirrors (clean caustics) | not checked | yes |

## Camera

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| Perspective | yes | yes |
| Orthographic, isometric | yes | yes, 100% of pixels within 3 levels |
| Panorama lens (Pano) | yes | yes; 99.5% of the sky within 3 levels |
| Depth of field | yes (no effect seen in its snapshots) | yes, round or polygon bokeh |
| Fisheye, lens distortion | stereographic (SG; 100% within 3) | yes: equidistant, equal-area, stereographic; Brown-Conrady |
| Motion blur (objects and camera) | not checked | yes |

## Image

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| Exposure, gamma, ACES film curve | yes | yes, within 1 level |
| Vignette | yes | yes, within 0.001 |
| Voxel edges, grid, background colour | yes | yes; edges 99.0-99.8%, grid 92.7-94.6% (camera registered), background 99.92% |
| Transparent background PNG | yes | yes; alpha identical, colours 99.9% within 3 levels |
| Non-cubic voxels (`_scale`) | yes | yes, 100% within 3 levels |
| Bloom | in its viewport, not in saved snapshots | through `@margoengine/post` |
| Denoiser | none in its render settings | yes |
| Clean image while the camera moves | not measured | yes: history across frames; 2-3x less noise turning slowly, about 2x on glass and clouds turning 0.5 degrees a frame |

## Output and scale

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| PNG snapshot | yes | yes, up to 16,384 pixels a side (tiled, cancellable) |
| Float (HDR) image; albedo, normal, depth and object passes | not checked | yes |
| Largest model | 256 x 256 x 256 | 2048 per axis (dense voxels, or sparse `blocks`) |
| Materials in one scene | 255 (one palette) | more than 255 (a material table per model) |
| Many models | yes (world editor) | up to 65,535 instances sharing models |
| Large world: 64 terrain models, 12.6 million voxels | not rendered yet | 256 samples in 1.5 s, 93 MiB of GPU memory |

## Editing and integration

| Feature | MagicaVoxel | Margo |
| --- | --- | --- |
| Voxel modelling tools, palette editor | yes | no editor UI; the editing operations (dense and sparse grids, modelling operations, brushes, selections, picking, `.vox` scene editing) are in `@margoengine/voxel-edit` |
| Mesh export | yes | not in this package: `@margoengine/voxel-edit/mesh` meshes models for export and `@margoengine/exporters` writes GLB |
| Runs inside your own web page, game or tool | no | yes |
| Live scene updates from code | no | yes (only changed models re-upload) |
| Ray picks, depth for overlays drawn on top | no API | yes |
| Same input, same image | not checked | yes, bit for bit on the same GPU and driver |
| Platforms measured | Windows | Windows, Edge (other GPUs and browsers untested) |

## Where MagicaVoxel is ahead

- It is a complete, free editor that artists already use; Margo's engine has the editing operations but no editor UI.
- Margo is measured on one PC and one browser only.
