# MagicaVoxel parity: status and open work

Goal (Scott, 2026-10-19): `@margoengine/voxel-pathtracer` renders any MagicaVoxel 0.99.7 `.vox` the way MagicaVoxel
does, and exceeds it everywhere else. MagicaVoxel is the most used voxel editor and renderer and it is free, so a
commercial replacement must beat it, not tie it.

Clean room: MagicaVoxel (0.99.7.2 in `C:\Tools`) is used only as a black box. We write our own `.vox` scenes, it renders
them, we compare its PNG snapshots with ours. Its code, shaders, `config/` and `shader/` folders are never read.

Everything here is on branch `worktree-agent-a63cac143225721f2` (not pushed, Codex's request). Nothing touches
`@margoengine/core` or the stage.

## How to compare

- Calibration tools: `packages/voxel-pathtracer/tests/magicavoxel/` (copy them to `test-results/mv-calib` and run from
  there; that folder also holds the `.vox` scenes and both renderers' PNGs).
  - `boards.cjs` and `xboards.cjs` write the calibration scenes (top-down tile boards: diffuse, metal, plastic, glass,
    clouds, emitters; sun penumbra, horizon, depth of field, bloom, metal roughness, LDR emitters, emissive media).
  - MagicaVoxel side: open the file (Ctrl+O), click camera slot 1 then L, wait until the progress bar is full,
    snapshot (camera icon by the console) to `<name>-mv.png`. The camera's field of view comes from the file's `_lens`.
  - Our side, from the branch root under the GPU lock:
    `node scripts/gpu-lock.mjs run --owner=<you> -- node test-results/mv-vox.mjs <dir> 1024 <files.vox>`
    (`test-results/mv-vox.{html,mjs}`, also kept in the tools folder) writes `<name>-ours.png` through
    `magicaVoxelMaterial`, `magicaVoxelLighting`, `magicaVoxelCamera`, `magicaVoxelModel` and `magicaVoxelMatrix`.
  - Score: `node score.cjs` (all scenes), `node cmp.cjs <name> <board>` (tile by tile), `node diff.cjs <name>` (pixels,
    writes a side-by-side and difference PNG).

## What MagicaVoxel does (measured)

| Setting | MagicaVoxel behaviour | Evidence |
| --- | --- | --- |
| Palette colour | linear = (value / 255)^2.2 (pure power, not sRGB) | 16 grey steps, every channel within 1 level |
| Film, ACES off | out = (`_expo` x radiance)^(1/`_gam`) | greys and exposure 0.5 within 1 level |
| Film, ACES on | Narkowicz's ACES fit after x0.6, then gamma | 16 greys, colours, sun and sky within 1 level |
| `_expo` | plain multiplier | 0.5 halves radiance |
| Uniform sky `_uni` | radiance = `_i` x colour, reached only by scattered rays | white diffuse = 0.5 at `_i` 0.5 |
| Sun `_inf` | irradiance 5 x `_i`; azimuth = yaw - 90 degrees; disk ~0.69 x `_area` rad across | penumbra fits at 0.07 and 0.2 |
| Sun light | diffuse lobes only (no metal, coat or glass highlights); not in clouds; any voxel blocks it | sun boards |
| Bounces | diffuse 2, specular 5, scatter 5 by default (`_bounce`) | glass-over-base tiles |
| Ground | albedo `_color` at z = 0; camera rays fade it into the sky by a / (a + sin depression), a = 0.007 x `_hor` | `_hor` 0.1 and 0.5 |
| Camera | rCAM focus, pitch, yaw, radius; field of view from rOBJ `_lens _fov`, not rCAM | camera scenes |
| Missing MATL keys | read as 0 (roughness 0, IOR 1, metal 0, emission 0), specular 1 | MagicaVoxel's own panel |
| Legacy keys | `_weight` wins (metalness, transparency, emission); `_spec` = specular - 1; `_ior` is always n - 1; cloud `_weight` reads as density 0.1 | panel readings |
| Metal | reflectance min(1, `_sp` x colour); GGX width ~0.13 x `_rough` | sky boards, reflection blur fit |
| Plastic coat | diffuse colour + Fresnel (added, not energy-conserving) | `_ior` 0, 0.3, 0.6 |
| Glass | Fresnel reflection of the sky exact; colour only through `_d` absorption = -ln(colour) x `_d` per voxel; glass share sqrt(`_trans`) | glass rows |
| Emitter | radiance colour x (1 + 3 x `_emit` x 10^`_flux`); a non-zero `_ldr` l shows 1 + 3 l to the camera only | 4 decades of exposure |
| Cloud | extinction `_d` per voxel, colour = scattering albedo, HG `_g` | cloud rows |
| Emissive cloud | 0.93 x `_d` x colour per voxel, no self-absorption | isolated blocks |
| Bloom | not in saved snapshots (default and scale 0.5 identical) | bloom scenes |
| Depth of field | `_aperture` 0.25 and 2 gave the same sharp image | DOF scenes |

## Current scores (ours vs MagicaVoxel, 1024 samples each, 960 x 800)

- Six perspective scenes with default lighting (`test-results/pt-compare/v2`: diffuse, metal 0.2 and 0.8, glass,
  emitter, cloud): 94-96% of pixels within 3 levels, 99.5-100% within 6, mean 1.3-1.5 levels (noise level).
- Calibration boards: diffuse, metal, plastic, sun, sky, exposure, ACES: every tile within 3 levels; emitters (with
  `_ldr`) every tile; sun penumbra 99.6-99.9% of pixels within 3; horizon 98-99.5%; metal reflections 96%.
- Our render time for those scenes: 1.7-2.2 s each (A6000). MagicaVoxel's time is not measured yet.

## Open: match MagicaVoxel

1. Subsurface (`_media_type _sss`, cloud and glass): MagicaVoxel lights it with the sun (unlike its clouds) and it
   looks like a cloud of about 10x the density. Ours renders it as a plain cloud: 59-156 levels off on those tiles.
2. Partly transparent glass (`_trans` below 1) under sky: ours 13-16 levels too bright; MagicaVoxel seems to re-pick
   glass or diffuse at every voxel face inside the block. Sun-lit it already matches.
3. Fog `_fog_uni` (density, colour, phase): not implemented (no global medium in the tracer).
4. Atmosphere sky (`_env _mode 1`, `_atm` Rayleigh / Mie / ozone): not implemented; needs its own calibration.
5. Image sky (`_mode 2`, `_ibl`): the helper reports it; the caller must load the HDR file into `environment.map`
   (rotation and intensity mapping unverified).
6. Background colour (`_bg`, `_setting _bg_c`, `_bg_a` transparent background), voxel `_scale`, edges `_edge`, grid
   `_grid`, vignette `_vig`: not implemented.
7. Camera modes: orthographic and iso (`_mode orth/iso`) and `_lens _proj` are mapped but not compared; depth of field
   (`_aperture`) never showed in MagicaVoxel snapshots: find what enables it.
8. Sample-panel toggles with non-default values (MIS-Reflect, MIS-Scatter, TR-Shadow, Shadow, Pixelated, Stochastic,
   Anti-Aliasing) and the `_bounce _energy` value: not compared. The physical defaults of the tracer correspond to
   MIS on and transparent shadows on, but their MagicaVoxel images were never rendered.
9. Blend materials (`_type _blend`) and metal Fresnel at grazing angles (rough red metal: 1-5 levels): not compared
   beyond the sky boards.
10. Emitter light on the ground near emitters: ours about 6% brighter.
11. Render speed: time MagicaVoxel on the same scenes (stopwatch on its progress bar) and record both.

## Open: exceed MagicaVoxel (already in the tracer, keep proving)

Physically based mode (sun highlights, light through glass with refraction, multiple importance sampling), dispersion,
emissive media, area lights, HDR environment maps, a physical sky, motion blur, panorama, fisheye and lens distortion,
a denoiser, AOVs (albedo, normal, depth, ids), PNG capture of any size, WebGPU in the browser. To do: a feature table
with MagicaVoxel against Margo for the product page, once speed is measured.

## Open: finish the package (before it can be pushed or published)

- README: document the new options (`bounceLimits`, `transparentShadows`, `sunSpecular`, `sunInMedia`,
  `toneMapping: 'aces-narkowicz'`, `gamma`), environment `sunVisible` and `groundHorizon`, material `metalColor`,
  `coat`, `tint`, `cameraEmission`, and the `magicaVoxel*` helpers with the table above.
- Unit tests for the helpers and the new option validation; browser-check cases for bounce caps, opaque shadows, the
  sun on diffuse lobes only, the horizon fade, ACES and gamma encoding, camera emission.
- `npx biome format --write` on touched files, `npm run hygiene`, `npm run verify`, size entries.
- Rebuild the three tarballs for Codex into `test-results` and report their SHA-256.

## Open from before the parity work (do not lose)

- Voxel sandbox: render distance 16 fills in 8.8-9.2 s, over the 6 s target (docs/limits.md).
- Voxel sandbox visual references for the Intel laptop profile: record there and add its profile id to `VOXEL` in
  `scripts/visual-regression.js`.
- Path tracer: light sampling through glass costs about 2x per sample in the glass scene; the denoiser on the caustic
  scene is just under 2x better than raw (target 2x).
- main's docs/HANDOFF.md still says the MagicaVoxel comparison is next; update it when this branch lands.
- `C:\Development\Projects\margoengine\.claude\launch.json` (untracked, voxel-sandbox dev server): keep or delete.
- `margo3d-studio` (HANDOFF step 6 posed-picking fixture) is on this PC, not yet used.
