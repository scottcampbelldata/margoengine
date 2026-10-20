# MagicaVoxel parity: status and open work

Goal (Scott, 2026-10-19): `@margoengine/voxel-pathtracer` renders any MagicaVoxel 0.99.7 `.vox` the way MagicaVoxel
does, and exceeds it everywhere else. MagicaVoxel is the most used voxel editor and renderer and it is free, so a
commercial replacement must beat it, not tie it.

Clean room: MagicaVoxel (0.99.7.2 in `C:\Tools`) is used only as a black box. We write our own `.vox` scenes, it renders
them, we compare its PNG snapshots with ours. Its code, shaders, `config/` and `shader/` folders are never read.

This work landed on main on 2026-10-20 (Scott's request; it had been held on branch
`worktree-agent-a63cac143225721f2` at Codex's request). Nothing touches `@margoengine/core` or the stage.

## How to compare

- Calibration tools: `packages/voxel-pathtracer/tests/magicavoxel/` (copy them to `test-results/mv-calib` and run from
  there; that folder also holds the `.vox` scenes and both renderers' PNGs).
  - `boards.cjs` and `xboards.cjs` write the calibration scenes (top-down tile boards: diffuse, metal, plastic, glass,
    clouds, emitters; sun penumbra, horizon, depth of field, bloom, metal roughness, LDR emitters, emissive media).
  - MagicaVoxel side: set the sample count once (double-click the number right of the chart icon, End, Backspace,
    type 8192, Enter; 1024 leaves visible noise). Open the file (Ctrl+O), click camera slot 1 then L, then type the
    exact distance into the Zoom field (double-click, End, Backspace, value, Enter): its camera glides to a loaded slot
    and stops about 0.05 voxels short, from whichever side it came (measured both ways; with the typed zoom our render
    registers at zero offset). Wait until the progress bar is full (about 2 min at 8192), snapshot (camera icon by the
    console) to `<name>-mv.png`. The field of view comes from the file's `_lens`, not the slot.
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
| Ground | albedo `_color` at z = 0; camera rays fade it into the sky behind it by 1 - e^(-D `_hor` / 2030) at distance D (atmosphere sky: 2250, and the nearest 100 do not fade) | per pixel against our unfaded ground: `_hor` 0.1 and 0.5, cameras 60-180 from their focus, D 40-5000 |
| Atmosphere sky `_env _mode 1` | single scattering, Rayleigh + Cornette-Shanks Mie (`_mie_g`) + ozone, top 8 km over a 25 000 km planet; densities scale by (e^(3.3 d) - 1) / (e^1.32 - 1); Mie extinction 1.29 - 0.2 d times its scattering; below the horizon the light comes along the horizon's path with the phase of the real direction | 16 panoramas (`test-results/mv-calib/A-pano-*`): mean 0.3-1.0 levels and 97-100% of directions within 3 for 13 of them |
| Sun under the atmosphere | irradiance 10 x `_i` (not 5) times the air's transmittance along the sun's path | lit scenes at sun 50, 20, 5 degrees: regions within 0-1 level |
| Camera | rCAM focus, pitch, yaw, radius; field of view from rOBJ `_lens _fov`, not rCAM | camera scenes |
| Missing MATL keys | read as 0 (roughness 0, IOR 1, metal 0, emission 0), specular 1 | MagicaVoxel's own panel |
| Legacy keys | `_weight` wins (metalness, transparency, emission); `_spec` = specular - 1; `_ior` is always n - 1; cloud `_weight` reads as density 0.1 | panel readings |
| Metal | reflectance min(1, `_sp` x colour); GGX width ~0.13 x `_rough`; no multiple-scattering energy compensation | sky boards, reflection blur fit, rough gold sphere |
| Plastic coat | diffuse colour + Fresnel (added, not energy-conserving) | `_ior` 0, 0.3, 0.6 |
| Glass | Fresnel reflection of the sky exact; colour only through `_d` absorption = -ln(colour) x `_d` per voxel; glass share sqrt(`_trans`) at the block's faces to the air, none inside; what the block rests on shows through with that share again | glass rows; P boards (64 tiles: `_trans` 0.1-1, heights 1-6, white and black base, sky and sun) |
| Subsurface `_sss` | scattering events are diffuse events (they follow the diffuse cap, not the scatter cap) and the sun lights them; only cells facing the sun glow, so neighbours on its far side get no light from it | G boards with caps 2/5/5, 2/10/5, 4/5/5; neighbours under the sun |
| Emitter | radiance colour x (1 + 3 x `_emit` x 10^`_flux`); a non-zero `_ldr` l shows 1 + 3 l to the camera only; emitters reflect no light | 4 decades of exposure, glow between neighbouring tiles |
| Cloud | extinction `_d` per voxel, colour = scattering albedo, HG `_g` | cloud rows |
| Emissive cloud | 0.93 x `_d` x colour per voxel, no self-absorption | isolated blocks |
| Bloom | not in saved snapshots (default and scale 0.5 identical) | bloom scenes |
| Background `_bg` (`_setting _bg_c`) | camera rays leaving the scene show the colour exactly as displayed; lighting unchanged; the ground stops fading | on / off pair |
| Vignette `_film _vig` v | cos^4 in screen space: 1 / (1 + t^2)^2, t = v r / (0.2238 H), r pixels from the centre, H image height; independent of the lens | v 0.5 and 1, fov 35 and 70, 960 x 800 and 600 x 600: within 0.001 |
| Edges `_edge` | a band `_width` voxels wide along voxel edges where the shape turns (outer and inner corners), in `_color` lit like the face | top and oblique views, widths 0.2 and 0.5 |
| Grid `_grid` | lines every `_spacing` voxels, `2 x _width` wide, in `_color` lit; on the ground, and on voxel faces with `_display` 0 | spacings 1 and 4, widths 0.02 and 0.1, both display modes |
| Image sky `_env _mode 2` | radiance 3 x `_i`; MagicaVoxel +x at the image centre, azimuth toward +y to the left, rows by elevation; the second `_angle` turns it, the first does nothing; no ground fade | our own ramp HDR: five panoramas within 0.003 of the image width; lit scene 99.76% |
| Uniform fog | extinction 0.001 x `_d` per voxel toward an unshadowed sky + sun glow; escaping rays see the glow; no direct sun; colour value / 255 | 9 fog scenes |
| Depth of field | `_aperture` 0.25 and 2 gave the same sharp image | DOF scenes |

## Current scores (ours vs MagicaVoxel, 1024 samples each, 960 x 800)

- Six perspective scenes with default lighting (`test-results/pt-compare/v2`: diffuse, metal 0.2 and 0.8, glass,
  emitter, cloud), ours at 8192 samples: 99.97, 99.94, 99.85, 99.23, 99.94 and 99.93% of pixels within 3 levels
  (was 94-96% before the distance-based ground fade, no energy compensation and non-reflective emitters). Glass keeps
  a 2.5% bias on the floor seen through it (ours brighter) plus MagicaVoxel's noise inside the glass.
- Close oblique view with the camera set exactly in MagicaVoxel and both at 8192 samples: 100.00% within 3 levels.
- Calibration boards: diffuse, metal, plastic, sun, sky, exposure, ACES: every tile within 3 levels; emitters (with
  `_ldr`) every tile; sun penumbra 99.6-99.9% of pixels within 3; horizon 98-99.5%; metal reflections 96%.
- Atmosphere sky (`test-results/pt-compare/atm`, 4096 samples each): the diffuse scene lit at sun 50, 20 and 5
  degrees 99.99, 99.91 and 99.79% within 3; views with the sky and horizon in frame 99.5% (sun 20, away from it) and
  97.7% (sun 5, toward it). Ground-fade scenes under the uniform sky (`X-hor-1`, `X-hor-5`, `H-r60`, `H-r180`,
  `H-corners`): 99.77-99.99%.
- Speed, same A6000, 960 x 800 at 1024 samples: MagicaVoxel about 14 s (glass) and 15 s (diffuse) by stopwatch on
  its progress bar (+-1 s); ours 1.85 s and 1.70 s (`capture`), about 8x faster. Ours 1.7-2.2 s on all six scenes.

## Open: match MagicaVoxel

1. Subsurface (`_media_type _sss`): a dense cloud (100 x `_d`, material `sunlit`) the sun lights only through each
   point's own cell, so only faces toward the sun glow. The neighbouring cloud that was 20 levels too bright is within
   5; sun-lit tops within 6 (184 against 190; subsurface glass 185 against 183). Open: sky-lit tops are 7-12 levels
   too dark, and MagicaVoxel's subsurface follows the diffuse cap (cap 4: +13 levels), which our volume cannot copy
   (counting its events as diffuse made every top 25-45 levels too dark): MagicaVoxel's subsurface is not a plain
   volume walk. Nor an unlimited one (2026-10-20, 256 samples): with the scatter cap at 64 the sky-lit subsurface
   tile reads 169 against MagicaVoxel's 136 (ours at cap 5: 124), and dense scattering clouds overshoot too (d 1:
   167 against 132), so the answer lies between, specific to `_sss`.
2. Partly transparent glass (`_trans` below 1): done (material `contactTransmission`): glass share sqrt(`_trans`) at
   the block's faces to the air, no picks inside, and what it rests on is reached with the share again. P boards
   (`_trans` 0.1-1, heights 1, 2, 3, 6, white and black base): 64 of 64 tiles within 3 levels sky-lit (mean 0.6) and
   sun-lit (mean 0.4); the G board's `_trans` 0.5 tile from 10 levels to within 3. Open: `_blend` materials still
   re-pick at every face (`voxelwise`); not compared yet.
2b. Glass over a lit floor: MagicaVoxel is darker by a fixed factor per refractive index (0.997 at 1.1, 0.976 at 1.3,
   0.959 at 1.5, 0.957 at 2), independent of its bounce caps (checked with specular 10 and diffuse 4): 1-2 levels.
3. Fog `_fog_uni`: done (`environment.fog`). MagicaVoxel's fog fades rays by exp(-0.001 x `_d` x distance) toward
   its glow, the glow being the sky and sun light it scatters without shadows; rays leaving the scene see only the
   glow and the sun reaches surfaces only through it; its colour is value / 255 (no 2.2 power); the ground's horizon
   fade is off under fog. 9 fog scenes (densities 0.002 to 5, sky, sun, coloured fog with anisotropy, camera 190 and
   400 away) within 3 levels on 99.5-100% of pixels.
4. Atmosphere sky (`_env _mode 1`, `_atm`): done (`src/atmosphere.ts`, baked to a 256 x 256 map in 0.5 s; the
   lighting helper bakes it and dims and reddens the sun through the air). Open: the view into a low sun is 97.7%
   (the half degree above the horizon is up to 8 levels bluer than MagicaVoxel; the ground fade prefers a scale of
   2400 there and 2100 looking away from the sun); dense air (`_ray_d` 0.8-1, `_mie_d` 1) is 2.4-3.1 levels off on
   average; ozone is fitted at `_o3_d` 1 only (linear assumed); `_bounce`-style sky light on objects is unchecked for
   non-default `_atm` settings.
5. Image sky (`_mode 2`, `_ibl`): done. The caller decodes the HDR file the helper names (`imageSky.path`) and
   passes it as the `imageSky` option; the helper sets intensity and turn. Panoramas of our own ramp image: 99.84%
   of pixels within 3 levels (the rest on the image's wrap seam); a scene lit by it: 99.76%.
6. Display settings: done. Background colour (`environment.background`): 99.92%; vignette (`vignette`): 100% at
   two strengths and two fields of view; edges (`edges`): 99.0-99.5%; grid (`grid`): 86-88% as rendered, 92.7-94.6%
   with our camera 0.04% closer (harness option `__cameraScale` 0.9996). Measured on the top views: line widths and
   colours equal (summed line strength 0.997-1.002 of ours), MagicaVoxel's image 0.04% larger (its slot glide stops
   about 0.05 voxels short of the typed radius), which moves 0.4-pixel lines by up to 0.2 px at the image's edges;
   the rest is the thin lines' sampling noise. Edges with the same correction: 99.1-99.8%. Transparent background (`_bg_a`): done
   as `capture({transparent: true})` (RGBA PNG; alpha = camera-ray coverage, the ground opaque); voxel `_scale`:
   done as `voxelScale` for `magicaVoxelMatrix` (the scene scaled about the origin, the camera unchanged). Neither is
   compared yet (scenes `C-bga`, `C-scale` in `mv-calib`): whether MagicaVoxel's ground stays opaque and whether its
   camera follows the scale are open.
7. Camera modes: orthographic and iso (`_mode orth/iso`) and `_lens _proj` are mapped but not compared; depth of field
   (`_aperture`) never showed in MagicaVoxel snapshots: find what enables it.
8. Sample-panel toggles with non-default values (MIS-Reflect, MIS-Scatter, TR-Shadow, Shadow, Pixelated, Stochastic,
   Anti-Aliasing) and the `_bounce _energy` value: not compared. The physical defaults of the tracer correspond to
   MIS on and transparent shadows on, but their MagicaVoxel images were never rendered.
9. Blend materials (`_type _blend`) and metal Fresnel at grazing angles (rough red metal: 1-5 levels): not compared
   beyond the sky boards.
10. Emitter light on the ground near emitters: done (2026-10-20, `pt-compare/v2/emissive`, both at 8192 samples): the
    glow on the ground is 1.0014 x MagicaVoxel's with 99.9% of values within 3 levels (whole image 100.0%); the 6%
    was gone with the non-reflective emitters.

## Exceed MagicaVoxel

Scott (2026-10-20): better in every way (faster, leaner, better parity, features and integration) without bloat;
the best value first. Parity items still open above are finished after Codex frees the desktop.

Measured (RTX A6000, Edge headless, 960 x 800, `L-bg-off`: slab, two cubes, sun, sky, ground):

| | MagicaVoxel 0.99.7 | Margo |
| --- | --- | --- |
| Noise at 1024 samples (8-bit RMS against a 16,384-sample reference) | 0.32 | 0.24 raw, 0.16 denoised |
| Time to MagicaVoxel's 1024-sample quality | about 14 s (1024 samples) | 0.48 s (64 samples, denoised), about 29x faster |
| Package | about 30 MB application | 59 KB gzip (gzip -9 of `dist/index.js`, 180 KB raw) |
| First lit viewport frame after opening | (its viewport) | 0.36-0.44 s with the preview kernel (was 2.1-2.8 s: the full tracer's compile) |
| Large world: 64 terrain models of 256 x 256 x 32 (2048 x 2048 voxels, 12.6 million voxels; `mv-calib/bigworld.cjs`) | (not rendered yet) | 256 samples in 1.5 s (about 6 ms each at 960 x 800), 93 MiB of GPU memory |
| Viewport samples in 4 s at 60 fps | (its viewport) | 1,465 light scene, 540 glass board, 351 sun board with `samplesPerFrame: 'auto'` (238-240 at 1 per frame): 6x / 2.3x / 1.5x, 2-6% of frames late |
| Moving camera, denoised, 1 sample per frame (8-bit RMS against a 2048-sample image; `pt-compare/v2` diffuse / glass / cloud, 30 frames) | (its viewport) | turning 0.001 degrees a frame 0.98 / 2.33 / 1.60 (2.40 / 6.08 / 5.22 before); 0.5 degrees a frame 2.13 / 2.78 / 2.32 (2.40 / 6.05 / 5.00) |

Done:
- Preview kernel: first hit lit by the sun (one shadow ray) and the sky, with edges, grid and the ground fade; the
  viewport shows it from about 0.15 s of compile while the full tracer compiles (about 2 s, not cached by the browser
  between page loads; on one device a second compile is cached).
- `samplesPerFrame: 'auto'`: grows by a quarter after four frames on pace, caps at 80% of what fits an interval after
  a late frame. A faster ramp (x1.5 after three) gave 40% more samples but twice the late frames and an 83 ms hitch.
- `denoise: 'auto'`: every frame below 32 samples, then each time the samples grow by a quarter, and at convergence.
- The MagicaVoxel helper sets `samplesPerFrame: 'auto'` for both looks and `denoise: 'auto'` for the Margo look.
- Denoiser history in the viewport (the row above): the demodulated estimate reprojected onto surfaces seen again,
  the displayed image blended with the last one (temporal antialiasing), dropped where a move uncovers a surface.
  Found on the way: the viewport showed a stale denoised image while the camera moved at a constant sample count
  (fixed), and this GPU converts floats to halves toward zero, which darkened stored history by 1% (now rounded).
  Open: for a few frames after the camera stops the diffuse and cloud scenes are a little worse than without history
  (1.10 and 2.28 against 0.96 and 2.03 at 8 frames); 63 MiB more GPU memory at 1920 x 1080.
- Feature table: [magicavoxel-feature-table.md](magicavoxel-feature-table.md).

Checked and dropped: kernels specialised to the scene's features. Stubbing out glass light sampling did not speed up
a scene without glass (12.45 against 12.32 ms per frame at 1920 x 1080) and cut compile time by about 15% (noisy);
the README's note that the larger shader is slower where there is no glass did not hold.

Large worlds need no work (row above). Done: the denoiser's caustic chain runs only when a material can focus light
(glass, or metal or a coat with roughness below about 0.32); a denoised diffuse scene at 1920 x 1080 went from 351 to
256 MiB and from 18.7-19.0 to 14.4-14.6 ms per frame. Next candidate: render the large world in MagicaVoxel for a
speed comparison.

## Voxel sandbox photo mode (Scott, 2026-10-20)

Scott asked for the worthwhile parts of a path-traced photo mode for the Minecraft-style voxel sandbox
(`examples/voxel-sandbox` on main, drawn by `@margoengine/voxel`'s raster renderer), in this order after the
MagicaVoxel parity work (parity is blocked while it needs the desktop, so this may start earlier):

1. Block textures in the path tracer: per-face texture layers (the sandbox's 16 x 16 pixel art: +x, -x, +y, -y, +z,
   -z), nearest filtering, multiplying the material colour; the denoiser demodulates them like any albedo. Also a
   selling point over MagicaVoxel, which has no textures.
2. See-through texture pixels (cutout): a face pixel with low alpha lets the ray pass on through the voxel (leaves).
3. Photo mode in the sandbox: its chunks as path-tracer models (about a dozen block types, well under 255 materials;
   an edited chunk re-uploads alone), water and glass as glass, torch light as an emitter. Main merged into this
   branch (Scott's go-ahead) and then rebased onto it for main; `examples/voxel-sandbox/src/photo.ts` (P toggles, Enter
   saves a PNG, `?photo` starts in it).

Status: 1 and 2 committed (b7d16afd); the texture and cut-out GPU checks pass. 3 builds and passes the sandbox's
tests. Its first screenshots (2026-10-20) showed uniform fog greying out the whole sky (that fog replaces the sky by
design), so photo mode fades the world into a clear sky as the game's fog does instead (from 60% of the view distance,
e^-4 at 95%), through two new tracer options: `environment.fadeModels` (the ground fade applied to models) and
`physicalSky.horizonBelow` (the baked sky keeps its horizon colour below the horizon, where the loaded world ends,
instead of a black band). Ground, overview and night shots reach 256 samples in 3.6 to 4.1 s at 960 x 540.

Not worth it yet: crossed-card plants (tall grass, flowers, torch shape): new non-cube geometry in the traversal for 4
blocks. Photo mode leaves grass and flowers out and shows torches as small glowing blocks.

## Finish the package (before it can be pushed or published)

- Done: environment maps are filtered bilinearly (radiance; sampling densities stay per texel), which the smooth
  atmosphere needs and any HDR map benefits from; the GPU `environment` check now looks at the middle of its colour
  bands.
- Done: README documents every new option, material field, `environment.fog`/`groundFade`/`sunVisible` and the
  `magicaVoxel*` helpers; `tests/magicavoxel.test.js` (10 tests: materials with current, older and missing keys, render
  objects, the atmosphere, cameras, models and placement, options reaching the frame); the real-GPU `compat` check (closed forms for
  energy compensation, metalColor, additive coat, untinted glass, voxelwise blend, contact transmission, camera
  emission, diffuse caps 1/2/3, the sun on diffuse lobes only, opaque shadows, the sun in media, sunlit media and a
  sunlit slab under opaque shadows, ground fade and its start, fog, the ACES and gamma
  byte); Biome format and lint clean; hygiene 10.0 on every gate for the package.
- Open: `npm run verify` on the branch, size entries (measure:size), rebuild the tarballs for Codex.

## Paused when the voxel and path tracer work began (do not lose)

Scott (2026-10-20): list what was set aside on 2026-10-19 and continue it. Checked with `git worktree list`, `git cherry
origin/main <branch>` (patch-level, so rebased copies do not count) and the handoff files.

1. CAD kernel, `@margoengine/brep` (the standing goal: replace OpenCascade; `docs/brep-kernel-checklist.md` on the
   branch). Branch `claude/kernel` (worktree `C:\Development\Projects\margoengine-claude`), 17 commits on top of main
   431222c0, none on main yet:
   - Phase 0 work (13 commits): real JT 9.5 and JT 10 meshes, JT MultiXT segments, Parasolid cliff-edge and
     charted-spine blends, tolerant edges along fin SP-curves, torus bands, STEP export cutting closed surfaces at
     their seam and B-spline edges in pieces; the branches `claude/integration-2026-10-18`, `claude/jt-real-files`,
     `claude/step-seam-edges`, `claude/smooth-trace-curves`, `claude/vibrant-satoshi-2c802e` and
     `claude/confident-proskuriakova-8da001` are subsets of it.
   - Checklist 1.1-1.3: `model.massProperties` (exact, from the faces), `model.bodiesFromSTEP` (STEP solids into the
     modeler), `model.checkBody` (Euler-Poincare, connected shells, outward faces, no crossing edges).
   - Codex validated the tip dc5d3f50 (branch `codex/test-dc5d3f50`, with its API and size records): check:merge
     passed (2,709/2,709 tests, proofs 15/15, visuals 55/55, brep 81/81, brep hygiene 10). Its comparison with
     OpenCascade over the corpus was paused by Scott on 2026-10-19 11:11 UTC to free the CPU (interim report:
     `C:\Development\Projects\margoengine-split\test-results\kernel-dc5d3f50\RESULTS-FOR-CLAUDE-IN-PROGRESS.md`).
     Its findings, the next kernel work:
     - a negative signed volume and area on an imported body (Jubilee body 48), and a round trip that changes it;
     - round-trip mass exactly doubled on a circular pattern (Jubilee CirPattern bodies 10, 12, 14, 17);
     - mass and the checker throwing a pole/apex error on cone and sphere apex faces (Jubilee bodies 70, 90; Radial
       Engine JT part 10);
     - mass differences from OpenCascade up to 4.7e-5 relative on the model tests, and a tiny sheet's round trip at
       1e-2;
     - operations on imported parts: Margo's cuts valid on 84 of 200 parts (OpenCascade 200), fillets on 4 (OpenCascade
       67), 304 Margo throws.
   - Then the checklist goes on at 1.4 (crash immunity) and 1.5 (harnesses).
   - `7e2741db docs(studio)`: the engine gaps of the Crocotile-equivalent tile editor (docs only).
2. Sky: `fix(night-citadel): water reflects the actual night sky` (one commit on `worktree-agent-aa8330c71e56a38e4`)
   never landed. It changes Night Citadel's look, so it needs Scott's look approval and Codex's re-recorded references.
3. Voxel sandbox: render distance 16 fills in 8.8-9.2 s, over the 6 s target (docs/limits.md); visual references for
   the Intel laptop profile (record there and add its profile id to `VOXEL` in `scripts/visual-regression.js`).
4. Path tracer: light sampling through glass costs about 2x per sample in the glass scene; the denoiser on the caustic
   scene is just under 2x better than raw (target 2x).
5. `C:\Development\Projects\margoengine\.claude\launch.json` (untracked, voxel-sandbox dev server): keep or delete;
   `margo3d-studio` (HANDOFF step 6's posed-picking fixture) is on this PC, not yet used.

Not ours: Codex's own branches (`codex/margotile-*`, its test branches) and its worktrees.
