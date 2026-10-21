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
    clouds, emitters, blend materials; sun penumbra, horizon, depth of field, bloom, metal roughness, LDR emitters,
    emissive media) with `voxwrite.cjs`, our writer of the public .vox format. Every scene starts from `defaults.vox`,
    which `node voxwrite.cjs` writes from its table of default render settings and cameras (`DEFAULT_RENDER`,
    `DEFAULT_CAMERAS`; 2026-10-20, replacing a file MagicaVoxel had saved). Its default `_ibl _path` is empty
    (MagicaVoxel's names an image it ships); otherwise the regenerated scenes equal the earlier ones chunk for chunk
    (52 checked), so the MagicaVoxel renders on disk still match them.
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
    writes a side-by-side and difference PNG), `node panos.cjs` (the 16 atmosphere panoramas, the half below the
    horizon on 2-degree blocks).

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
| Bounces | diffuse 2, specular 5, scatter 5 by default (`_bounce`); inside glass, reflections after the second go on with probability 1/2 (fitted, item 2b) | glass-over-base tiles |
| Ground | albedo `_color` at z = 0; camera rays fade it into the sky behind it by 1 - e^(-D `_hor` / 2030) at distance D (atmosphere sky: 2250, and the nearest 100 do not fade) | per pixel against our unfaded ground: `_hor` 0.1 and 0.5, cameras 60-180 from their focus, D 40-5000 |
| Atmosphere sky `_env _mode 1` | single scattering, Rayleigh + Cornette-Shanks Mie (`_mie_g`) + ozone, top 8 km over a 25 000 km planet; densities scale by (e^(3.3 d) - 1) / (e^1.32 - 1); Mie extinction 1.29 - 0.2 d times its scattering; below the horizon the light comes along the horizon's path with the phase of the real direction (the ground fades into it); with the ground off that light fades into a dim surface (item 4b) | 16 panoramas (`test-results/mv-calib/A-pano-*`): mean 0.3-1.0 levels and 97-100% of directions within 3 for 13 of them |
| Sun under the atmosphere | irradiance 10 x `_i` (not 5) times the air's transmittance along the sun's path | lit scenes at sun 50, 20, 5 degrees: regions within 0-1 level |
| Camera | rCAM focus, pitch, yaw, radius; field of view from rOBJ `_lens _fov`, not rCAM | camera scenes |
| Camera `_mode orth` / `iso` | orthographic, the view as tall as the radius (the typed zoom), the ground unfaded; iso sets the pitch to the isometric 35.26 degrees and keeps the stored yaw | `C-orth`, `C-iso` (2026-10-20, 8192 samples): 100% of pixels within 3 levels |
| Lens `_proj 1` (SG) | stereographic with the lens field of view | `C-proj1`: 100% within 3 |
| Transparent background `_bg_a` | the sky's alpha 0, the ground opaque | `C-bga`: alpha identical to ours (124,800 transparent pixels each), colours 99.9% within 3 |
| Voxel `_scale` | the scene scaled about the origin, the camera unchanged | `C-scale`: 100% within 3 |
| Lens `_proj 2` (Pano) | equal-angle panorama: 180 degrees down the image and the same 0.225 degrees per pixel across at 960 x 800 (216 degrees; 360 on a 2:1 image) | `A-pano-e5`: a sun 90 degrees off the view lands 400 px from the centre; our render with `panoramaFit: 'height'`: 99.53% of the sky half within 3 levels |
| Missing MATL keys | read as 0 (roughness 0, IOR 1, metal 0, emission 0), specular 1 | MagicaVoxel's own panel |
| Legacy keys | `_weight` wins (metalness, transparency, emission); `_spec` = specular - 1; `_ior` is always n - 1; cloud `_weight` reads as density 0.1 | panel readings |
| Metal | reflectance min(1, `_sp` x colour); GGX width ~0.13 x `_rough`; no multiple-scattering energy compensation | sky boards, reflection blur fit, rough gold sphere |
| Plastic coat | diffuse colour + Fresnel (added, not energy-conserving) | `_ior` 0, 0.3, 0.6 |
| Glass | Fresnel reflection of the sky exact; colour only through `_d` absorption = -ln(colour) x `_d` per voxel; glass share sqrt(`_trans`) at the block's faces to the air, none inside; what the block rests on shows through with that share again | glass rows; P boards (64 tiles: `_trans` 0.1-1, heights 1-6, white and black base, sky and sun) |
| Subsurface `_sss` | a cloud of extinction about 14 x `_d` per voxel whose events follow the diffuse cap: 2 x cap + 1 of them, each diffuse event before them using 4; light travels several voxels inside (the sun-lit top brightens toward the sun across all 6 voxels: 178 to 206); the sun reaches a point through its own block when the walk entered by a face toward the sun, through its own cell otherwise, and nothing behind the block is lit through it | G boards with caps 2/5/5, 2/10/5, 4/5/5 (tiles (5,5) and (7,5) and their neighbours), the sun-lit top's profile |
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
  emitter, cloud), ours at 8192 samples: 99.97, 99.94, 99.85, 99.3, 99.94 and 99.93% of pixels within 3 levels
  (was 94-96% before the distance-based ground fade, no energy compensation and non-reflective emitters). Glass:
  99.23% before the internal-reflection cap (item 2b); where the glass changes the picture (57,221 pixels) MagicaVoxel
  over ours went 0.9927 -> 0.9988 in linear light; what is left is MagicaVoxel's noise inside the glass.
- Close oblique view with the camera set exactly in MagicaVoxel and both at 8192 samples: 100.00% within 3 levels.
- Calibration boards: diffuse, metal, plastic, sun, sky, exposure, ACES: every tile within 3 levels; emitters (with
  `_ldr`) every tile; sun penumbra 99.6-99.9% of pixels within 3; horizon 98-99.5%; metal reflections 96%.
- Atmosphere sky (`test-results/pt-compare/atm`, 4096 samples each): the diffuse scene lit at sun 50, 20 and 5
  degrees 99.98, 99.89 and 99.81% within 3; views with the sky and horizon in frame 99.54% (sun 20, away from it)
  and 98.66% (sun 5, toward it; 100% within 6). Ground-fade scenes under the uniform sky (`X-hor-1`, `X-hor-5`, `H-r60`, `H-r180`,
  `H-corners`): 99.77-99.99%.
- Speed, same A6000, 960 x 800 at 1024 samples: MagicaVoxel about 14 s (glass) and 15 s (diffuse) by stopwatch on
  its progress bar (+-1 s); ours 1.85 s and 1.70 s (`capture`), about 8x faster. Ours 1.7-2.2 s on all six scenes.

## Open: match MagicaVoxel

1. Subsurface (`_media_type _sss`): done (2026-10-20). Fitted against the four G renders on disk (1024 samples):
   a cloud of 14 x `_d` per voxel (was 100 x), material `sunlit`, its events capped by the new
   `bounceLimits.subsurface` = 2 x diffuse cap + 1 (each diffuse event earlier on the path uses 4: MagicaVoxel's
   neighbours of the block brighten with the diffuse cap too); a shadow ray from inside it crosses its own block, or
   only its own cell when the walk entered through a face turned from the sun. What showed the way: MagicaVoxel's
   sun-lit top is not flat but rises toward the sun across the whole block (178 to 206; ours now 180 to 195, was flat
   with a dip at every voxel boundary), so its light travels several voxels, and a plain walk of any density cannot
   reach the sky-lit level with 2 events. Tiles (5,5) and (7,5), largest channel difference in levels:

   | Board | before | now | tiles within 3 (of 56) | mean |
   | --- | --- | --- | --- | --- |
   | `G-sky-lin` (caps 2/5/5) | 11.7, 7.0 | 1.6, 1.6 | 53 -> 55 | 1.06 -> 0.80 |
   | `G-sky-s10` (2/10/5) | 11.8, 6.6 | 1.5, 1.2 | 53 -> 55 | 1.08 -> 0.82 |
   | `G-sky-d4` (4/5/5) | 25.2, 15.8 | 1.6, 1.2 | 51 -> 53 | 1.80 -> 0.96 |
   | `G-sun60-lin` (2/5/5) | 5.4, 3.2 | 1.9, 3.8 | 51 -> 52 | 0.89 -> 0.78 |

   Every tile of the sky boards is within 6 (`G-sky-d4`'s partly transparent glass, 8.5 levels then, fixed under
   item 2). Cost: under the sun the absorbing cloud
   diagonal to the block went from 1.5 to 4.3 levels and the emissive cloud from 5.1 to 5.6 (the blue cloud beside it
   from 4.9 to 4.5). Rendered by MagicaVoxel 2026-10-20: at scatter cap 10 (`G-sky-sc10`) 55 of 56 tiles within 3
   (the subsurface tiles unchanged, so its events ignore the scatter cap, as modelled); under the sun at diffuse cap
   4 (`G-sun60-d4`) 50 of 56, the subsurface block within 3.2 but the subsurface glass 9.2 levels too bright and the
   neighbours too dark (blue cloud 16, absorbing cloud 9.9, emissive cloud 7.1). Checked (2026-10-20): the
   subsurface budget's weight for earlier diffuse events (2, 3 or 4) moves those tiles by under 1.5 levels, and our
   render is converged by cap 4 (caps 6 and 12 give the same tiles), so MagicaVoxel's extra light there at cap 4 is
   not more diffuse bounces of our kind. Open: those neighbours at cap 4, and only `_d` 0.05 measured.
2. Partly transparent glass (`_trans` below 1): done (material `contactTransmission`): glass share sqrt(`_trans`) at
   the block's faces to the air, no picks inside, and what it rests on is reached with the share again. P boards
   (`_trans` 0.1-1, heights 1, 2, 3, 6, white and black base): 64 of 64 tiles within 3 levels sky-lit (mean 0.6) and
   sun-lit (mean 0.4); the G board's `_trans` 0.5 tile from 10 levels to within 3. `_blend` materials: done
   (2026-10-20). They were re-picked at every voxel face (`voxelwise`); MagicaVoxel's B boards show a 3-voxel blend
   block looking like a 1-voxel one, so blends now use the same contact rule as partly transparent glass. B boards:
   sky-lit 34 -> 56 of 64 tiles within 3 (mean 9.3 -> 0.89, all 64 within 6), sun-lit 62 -> 64 of 64. Open: half
   metal, half transparent blends over a white base are 4-5 levels too dark (4 tiles).
   At diffuse cap 4 (2026-10-20): MagicaVoxel brightens partly transparent glass by 7.5 levels (`G-sky-d4` (4,0) and
   (5,0)) while ours stayed put. The pick now happens where a ray leaves the block into the air, in and out, and the
   rest scatters back inside as a diffuse event (it ended the path before, and the second pick was where the ray
   reached what the block rests on). At cap 2 the two rules give the same light; at cap 4 the inner bounces add it.
   `G-sky-d4` 53 -> 55 of 56 tiles within 3 (those two tiles 8.5/8.3 -> 2.8 and under), `B-sky-lin` 56 -> 60 of 64,
   `G-sky-lin`, `B-sun60-lin`, `P-sun60-lin` unchanged; `P-sky-lin` 64 -> 61 of 64 (three 6-voxel blocks at 3.3-3.4,
   all within 6).
2b. Glass over a lit floor: done (2026-10-20, `bounceLimits.internalReflections`). MagicaVoxel was darker by a fixed
   factor per refractive index (0.997 at 1.1, 0.976 at 1.3, 0.959 at 1.5, 0.957 at 2), independent of its bounce caps
   (checked with specular 10 and diffuse 4). Ending paths reflected back inside the glass makes the boards far worse
   (sky board 55 -> 41 of 56 tiles within 3, sun board 52 -> 28), so MagicaVoxel keeps internal reflections, but not
   all of them: the first two in full and each one after with probability 1/2 fits every board. MagicaVoxel over ours
   now 0.998 / 0.989 / 0.997 / 0.999 at 1.1 / 1.3 / 1.5 / 2, 0.991 and 0.992 on the white and red tinted glass; the
   G-sky boards' mean level difference 0.77 -> 0.52; the perspective glass scene 99.2 -> 99.3% within 3, the diffuse
   one unchanged at 100%.
3. Fog `_fog_uni`: done (`environment.fog`). MagicaVoxel's fog fades rays by exp(-0.001 x `_d` x distance) toward
   its glow, the glow being the sky and sun light it scatters without shadows; rays leaving the scene see only the
   glow and the sun reaches surfaces only through it; its colour is value / 255 (no 2.2 power); the ground's horizon
   fade is off under fog. 9 fog scenes (densities 0.002 to 5, sky, sun, coloured fog with anisotropy, camera 190 and
   400 away) within 3 levels on 99.5-100% of pixels.
4. Atmosphere sky (`_env _mode 1`, `_atm`): done (`src/atmosphere.ts`, baked to a 256 x 512 map in 0.55 s; the
   lighting helper bakes it and dims and reddens the sun through the air). The view into a low sun (2026-10-20, 4096
   samples): 97.74% -> 98.66% within 3 levels, 99.90% -> 100% within 6. The half degree above the horizon was bluer
   for two reasons: the light path was held 0.115 degrees up (MagicaVoxel keeps reddening down to the horizon: now
   the view's own path down to 0 degrees), and the 256-row map's rows are 0.7 degrees apart, the last one above the
   horizon 0.35 degrees up (now 512 rows, those within 3 degrees of the horizon integrated, every second above, the
   rest interpolated within 0.01% of the model; bake 0.53 -> 0.55 s, GPU memory +1.3 MiB). Other scenes unchanged:
   lit at sun 50, 20, 5 degrees 99.98, 99.89, 99.81%; the view away from the sun 99.49 -> 99.54%. Open: in the low-sun
   view the ground 1-4 degrees down is 2-3 levels too bright in red and green (the ground's own light, not the fade:
   the fade is 1-3% there) and the far ground just below the horizon 2-3 levels too dark in red; dense air (`_ray_d`
   0.8-1, `_mie_d` 1) is 2.4-3.1 levels off on average; ozone is fitted at `_o3_d` 1 only (linear assumed);
   `_bounce`-style sky light on objects is unchecked for non-default `_atm` settings.
4b. Atmosphere sky below the horizon with the ground off (`_setting _ground 0`): done (2026-10-20,
   `bakeAtmosphere(..., 'surface')`, chosen by the lighting helper when the ground is off). MagicaVoxel's lower half
   is a noisy path-traced surface seen through air: at depression d the horizon's light (our earlier below-horizon
   value) keeps the share w = exp(-(sin d / (1.08 sin(sun)^0.81))^0.68), the rest is 0.035 / pi times the sun and sky
   light on level ground (its nadir is that for every default-like air setting: ratio 0.036-0.050 at suns 5-90
   degrees). Found by measuring 2-degree blocks of all 16 panoramas: Rayleigh off makes the nadir nearly black and
   dense Rayleigh makes it red (so it is air light, not just a lit surface), and the depth of the fade scales with the
   sun's height (about 7.5 degrees at a 5-degree sun, 53 at 90). Our renders of the 16 panoramas (1024 samples)
   against MagicaVoxel's, the half below the horizon on 3 x 2-degree blocks: mean difference 47.8 -> 4.2 levels
   (default air: sun 20 degrees 60.6 -> 1.1, 97% of blocks within 3; sun 5 72.3 -> 4.0; sun 45 46.3 -> 2.6; sun 90
   40.8 -> 2.4); worse only for the extreme settings ozone 1 (3.4 -> 5.1) and Rayleigh 0 (12.2 -> 15.5). The sky
   half is unchanged (98.1% of pixels within 3 on average, 99.04-99.94% for default-like air), and with the ground on
   the map is bit-identical (the ground fades into the horizon's light as before: `atm-sky-e5` and `atm-e20`
   re-rendered byte-identical). The surface's albedo is fitted at the default ground colour only; at a 5-degree sun
   the model is 5-10% too bright in green and blue 3-8 degrees down, in every azimuth (about 2 levels).
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
   done as `voxelScale` for `magicaVoxelMatrix` (the scene scaled about the origin, the camera unchanged). Both
   compared 2026-10-20: `C-bga` alpha identical (MagicaVoxel keeps the ground opaque too), colours 99.9% within 3;
   `C-scale` 100%.
7. Camera modes: done (2026-10-20, measured). `magicaVoxelCamera` maps them and the harness renders them
   (`mv-vox.html` uses the camera's projection; `C-orth`, `C-iso` and `C-proj1` were byte-identical before). Orth and
   iso: orthographic, as tall as the radius (registration of `C-orth`: best height 110 = the zoom, against our first
   guess 2 x radius x tan(fov / 2) = 69.4), with the ground unfaded (MagicaVoxel's orthographic ground is one flat 73
   from top to bottom; the camera result carries `environment.groundFade` 0), the eye pulled back by the height over the
   sine of the pitch so the view starts above the ground. Iso: pitch -35.26 degrees, the stored yaw kept (MagicaVoxel's
   panel showed -35.3 and the file's yaw; our first guess snapped it to a diagonal). Lens `_proj 1` is MagicaVoxel's
   "SG" (Pers, SG, Pano in its lens panel): stereographic with the lens field of view, as guessed. Lens `_proj 2`
   (Pano; also `_mode pano`): the tracer's panorama with `panoramaFit: 'height'`. Our renders against MagicaVoxel's
   (8192 samples): `C-orth` 94.9% -> 100% within 3, `C-iso` 90.7% -> 100%, `C-proj1` 100%. Unit tests in
   `tests/magicavoxel.test.js`; the GPU `projections` check puts 3 height-fitted panorama and 4 stereographic markers
   within 0.08 px of their formulas. Open: the orthographic height is measured at a 35-degree lens only; depth of field
   (`_aperture`) never showed in MagicaVoxel snapshots: find what enables it.
8. Sample-panel toggles with non-default values (MIS-Reflect, MIS-Scatter, TR-Shadow, Shadow, Pixelated, Stochastic,
   Anti-Aliasing) and the `_bounce _energy` value: not compared. The physical defaults of the tracer correspond to
   MIS on and transparent shadows on, but their MagicaVoxel images were never rendered.
9. Blend materials (`_type _blend`): done (item 2). Metal Fresnel at grazing angles (rough red metal: 1-5 levels): not
   compared beyond the sky boards.
10. Emitter light on the ground near emitters: done (2026-10-20, `pt-compare/v2/emissive`, both at 8192 samples): the
    glow on the ground is 1.0014 x MagicaVoxel's with 99.9% of values within 3 levels (whole image 100.0%); the 6%
    was gone with the non-reflective emitters.

## MagicaVoxel renders, 2026-10-20

Scott freed the desktop; all nine were rendered (MagicaVoxel 0.99.7.2, 960 x 800, open the file, camera slot 1, L,
type the zoom; answer No when it asks to save the camera change, so it never writes our scene files; the files were
checked unchanged afterwards). Snapshots in `test-results/mv-calib` (git-ignored).

| File | Slot | Zoom | Samples | Result (ours against it) |
| --- | --- | --- | --- | --- |
| `C-orth.vox` | 1 | 110 | 8192 | 100% within 3 after the fix (was 94.9%) |
| `C-iso.vox` | 1 | 110 | 8192 | 100% after the fix (was 90.7%) |
| `C-proj1.vox` | 1 | 110 | 8192 | 100% |
| `C-bga.vox` | 1 | 110 | 8192 | alpha identical, colours 99.9% |
| `C-scale.vox` | 1 | 110 | 8192 | 100% |
| `B-sky-lin.vox` | 1 | 190 | 1024 | 60 of 64 tiles within 3 after the blend fixes (was 34), all within 6 |
| `B-sun60-lin.vox` | 1 | 190 | 1024 | 64 of 64 after the blend fix (was 62) |
| `G-sun60-d4.vox` | 1 | 190 | 1024 | 50 of 56 (neighbours of the subsurface block open) |
| `G-sky-sc10.vox` | 1 | 190 | 1024 | 55 of 56 |

## Exceed MagicaVoxel

Scott (2026-10-20): better in every way (faster, leaner, better parity, features and integration) without bloat;
the best value first. Parity items still open above are finished after Codex frees the desktop.

Measured (RTX A6000, Edge headless, 960 x 800, `L-bg-off`: slab, two cubes, sun, sky, ground):

| | MagicaVoxel 0.99.7 | Margo |
| --- | --- | --- |
| Noise at 1024 samples (8-bit RMS against a 16,384-sample reference) | 0.32 | 0.24 raw, 0.16 denoised |
| Time to MagicaVoxel's 1024-sample quality | about 14 s (1024 samples) | 0.48 s (64 samples, denoised), about 29x faster |
| Package | about 30 MB application | 70 KB gzip (gzip -9 of `dist/index.js`: 69,634 B, 213 KB raw; 2026-10-21 at main `da95929c`, after the model material tables, 2048-voxel models, native 4K viewport and this parity work; 63 KB and 192 KB on 2026-10-20) |
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
  `magicaVoxel*` helpers; `tests/magicavoxel.test.js` (11 tests: materials with current, older and missing keys, render
  objects, the atmosphere and its tall map, cameras, camera modes and lens projections, models and placement, options
  reaching the frame); the real-GPU `compat` check (closed forms for
  energy compensation, metalColor, additive coat, untinted glass, voxelwise blend, contact transmission, camera
  emission, diffuse caps 1/2/3, the sun on diffuse lobes only, opaque shadows, the sun in media, sunlit media outside
  the scatter cap and a three-voxel sunlit slab lit through its own volume under opaque shadows, ground fade and its
  start, fog, the ACES and gamma byte) and `projections` check (panorama fitted to the height, stereographic fisheye);
  Biome format and lint clean; hygiene 10.0 on every gate for the package (2026-10-20, after the parity work).
- 2026-10-20 (branch `claude/quizzical-northcutt-b56ae0`, after the subsurface, horizon, camera and defaults work):
  `npm run verify` passed (3,116 of 3,116 tests, API reports match, core + stage 21,343 bytes gzip, proofs 15 of 15);
  the package bundle grew by 1,030 bytes gzip (esbuild, minified: 59,281 -> 60,311).
- 2026-10-21: that branch's 12 commits landed on main, ported onto main's model material tables and `options.ts`. Our
  renders of 74 MagicaVoxel scenes (1,024 samples) and the six perspective scenes (8,192) are byte-identical to the
  branch's, so every score above holds; the GPU browser check passed.
- 2026-10-21: re-checked against the package on main `da95929c`: every option, material and helper a done item
  names exists in `packages/voxel-pathtracer/src` (`bounceLimits.subsurface` and `internalReflections`, `sunlit`,
  `contactTransmission`, `environment.fog`, `groundFade`, `background`, `vignette`, `edges`, `grid`, `capture({transparent})`,
  `voxelScale`, `panoramaFit`, the stereographic lens, `bakeAtmosphere(..., 'surface')` and its 512-row map).
- Open: size entries (`entry-sizes.json` still records the build before the port, `99ed7335`), rebuild the tarballs
  for Codex.

## Paused when the voxel and path tracer work began (do not lose)

Scott (2026-10-20): list what was set aside on 2026-10-19 and continue it. Checked with `git worktree list`, `git cherry
origin/main <branch>` (patch-level, so rebased copies do not count) and the handoff files.

1. CAD kernel, `@margoengine/brep`: landed. Checklist 1.1-1.3 (`massProperties`, `bodiesFromSTEP`, `checkBody`, in
   `packages/brep/src/model/`) are on main and the branch `claude/kernel` no longer exists. Codex's corpus findings
   (Jubilee and Radial Engine bodies) and the work after them are tracked in `docs/brep-kernel-checklist.md`. The
   tile editor's engine-gap notes are on main (`9dad7b9e docs(studio)`).
2. Sky: `fix(night-citadel): water reflects the actual night sky` landed on main (`f2df8fcc`).
3. Voxel sandbox: render distance 16 fill time, done 2026-10-20 (3.6-3.7 s, was 8.8-9.2 s; docs/limits.md); visual
   references for the Intel laptop profile (record there and add its profile id to `VOXEL` in
   `scripts/visual-regression.js`).
4. Path tracer: light sampling through glass costs about 2x per sample in the glass scene; the denoiser on the caustic
   scene is just under 2x better than raw (target 2x).
5. `C:\Development\Projects\margoengine\.claude\launch.json` (untracked, voxel-sandbox dev server): keep or delete;
   `margo3d-studio` (HANDOFF step 6's posed-picking fixture) is on this PC, not yet used.

Not ours: Codex's own branches (`codex/margotile-*`, its test branches) and its worktrees.
