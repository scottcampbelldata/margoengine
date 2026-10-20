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
   volume walk.
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

## Open: exceed MagicaVoxel (already in the tracer, keep proving)

Physically based mode (sun highlights, light through glass with refraction, multiple importance sampling), dispersion,
emissive media, area lights, HDR environment maps, a physical sky, motion blur, panorama, fisheye and lens distortion,
a denoiser, AOVs (albedo, normal, depth, ids), PNG capture of any size, WebGPU in the browser. To do: a feature table
with MagicaVoxel against Margo for the product page, once speed is measured.

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

## Open from before the parity work (do not lose)

- Voxel sandbox: render distance 16 fills in 8.8-9.2 s, over the 6 s target (docs/limits.md).
- Voxel sandbox visual references for the Intel laptop profile: record there and add its profile id to `VOXEL` in
  `scripts/visual-regression.js`.
- Path tracer: light sampling through glass costs about 2x per sample in the glass scene; the denoiser on the caustic
  scene is just under 2x better than raw (target 2x).
- main's docs/HANDOFF.md still says the MagicaVoxel comparison is next; update it when this branch lands.
- `C:\Development\Projects\margoengine\.claude\launch.json` (untracked, voxel-sandbox dev server): keep or delete.
- `margo3d-studio` (HANDOFF step 6 posed-picking fixture) is on this PC, not yet used.
