# Clean room

Margo is written clean room. This page says what that means, how the 2026-10-24 rewrites were done, and where every
lighting and post-processing formula in the engine comes from.

## The rule

Scott's rule (2026-10-24): Margo never uses files from other repositories, whatever their licence. Code is written from public specifications, papers and
descriptions; nobody copies, adapts or reads another engine's or application's source while writing the matching
Margo code. Other engines run only where they live (`../engine-bench`). The one exception is large standard files
every engine uses (sample models, test assets, prebuilt decoders), each recorded in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). The `clean-room` quality gate
([conventions.md](conventions.md#quality-gate)) fails a new mention of another graphics library in `packages/**`
or a new third-party dependency.

Rulings on what counts (Scott, 2026-10-24):

- **Published engine standards are kept, with a citation.** A formula or constant an engine team published for
  others to use, for example Karis 2014's mobile environment BRDF fit and the 0.045 minimum perceptual roughness of
  the Filament design document. Unreal and Unity interop conventions are kept on the same footing.
- **MagicaVoxel parity fits are kept**, recorded as fitted to observed MagicaVoxel output. They were measured from
  the application's renders, never from its code; its renders are not in the repository.
- **Rewritten:** code that followed another engine's source, and library defaults copied with no physical basis.

## Process

Each area went through four steps, with a different agent at each step so no writer saw the old code:

1. **Dirty spec.** An auditor who may read the old Margo code (never another engine's) writes a words-only spec:
   files and line ranges, the public interface callers rely on, the required behaviour, which constants are
   binding (public sources) and which are the writer's to choose, and the tests, proofs and visual baselines that
   touch it. Specs hold no code.
2. **Stub.** The auditor removes the old body (and any built `dist` that held it), leaves a `CLEAN-ROOM:` marker
   and keeps everything outside the range unchanged, so the package still builds.
3. **Clean writer.** A fresh agent reads only the spec, the public sources it names and the tests it lists, and
   writes the body. It chooses its own internal constants and documents each one in a comment.
4. **Tests.** The package tests, proofs (`npm run proofs -- --current`) and visual checks run against the new body;
   any proof whose feature-off output changes is advanced with a note in
   [whitepaper/claims.md](whitepaper/claims.md).

## Rewrites of 2026-10-24

From commits ac465a00..ccb4a164 and their follow-ups, every area the 2026-10-21 audit found close to other engines' or
libraries' code:

- geometry (primitives, curves, extrusion, earcut triangulation, edges, convex hull, subdivision, utilities)
- controls (orbit, trackball, fly, first-person, transform)
- helpers; CSS3D labels; SDF text; eye-dome lighting
- math edge cases; BVH shapecast
- contact shadows; glitch and afterimage
- hashes and noise
- sheen, thin film, transmission, matcap, depth packing
- light falloff, LTC edge integral, cotangent frame
- ACES fit
- LZF, meshopt, EXR PIZ, USD LZ4 and integer coding, JT LZMA
- SVG, outline-font and MTL loaders
- ORCA avoidance and the path funnel (navigation removed; `@margoengine/navmesh/build` replaces it,
  [renames-2026-10-24.md](renames-2026-10-24.md))
- fixtures from other projects replaced by Margo-generated ones; three and Babylon dropped as dev dependencies

The provenance sweep that produced the table below added five more:

- FXAA, rebuilt from Lottes' 2009 whitepaper (it had followed the FXAA 3.11 reference shader)
- the transmission blur level, now derived from the GGX facet tilt and Snell's law
- the 0-15 voxel light-level curve, now equal CIE L* steps
- the Phong `refractionRatio` default (0.98 to air-to-glass 1/1.5) and the `rgbShift` amount default (0.005 to 0.002)

The FBX importer's Phong exponent to roughness mapping was also corrected to match materials and the exporters
(row EX2).

## Where each formula comes from

Every row of the four provenance tables (groups pbr, env, post and shadow-voxel; ids as in those tables), grouped by
the package of its first site. The source is a public paper, specification or standard; "Margo-own" with the design
it follows; "published engine standard" with its document; or "fitted to observed MagicaVoxel output". Most sites
carry the same citation as a one-line comment in the code.

### animation

| id | formula | file | source |
| --- | --- | --- | --- |
| AN1 | VAT crowd lighting: copy of gltf-pro GGX + hemisphere ambient + Neutral | animation/src/vat.ts | as VX5-VX7 |

### bvh

| id | formula | file | source |
| --- | --- | --- | --- |
| BK1 | vertex-colour bake: Lambert, Karis 2013 window, spot smoothstep, cosine AO | bvh/src/bake.ts | Karis 2013 windowed inverse-square falloff; Lambert; spot smoothstep and cosine AO are textbook forms |

### clustered

| id | formula | file | source |
| --- | --- | --- | --- |
| C1 | photometric conversions; cone solid angle with smoothstep edge; EV100; exposure 1/(1.2 x 2^EV) | clustered/src/units.ts | SI photometry; KHR_lights_punctual; ISO 2720 (EV); ISO 12232 saturation-based speed (also in Lagarde & de Rousiers 2014 course notes) |
| C2 | cluster grid: exponential depth slices, AABB-sphere and cone-sphere culling | clustered/src/shader.ts, shared/light-terms.js | Olsson, Billeter & Assarsson 2012 (clustered shading); geometric tests |
| C4 | minimum perceptual roughness before squaring | clustered/src/shader.ts, clustered/src/area.ts | published engine standard: minimum perceptual roughness of the Filament design document |
| C6 | integrated point/spot shadow maps, 3x3 PCF, normal offset | clustered/src/shader.ts | Reeves, Salesin & Cook 1987 (PCF); normal-offset: Holbert 2011 GDC |
| C7 | local shadow lookup with texel-scaled slope and normal offsets; defaults bias 1, normalBias 1.5 texels | clustered/src/shadows.ts | Margo-own: technique public (as C6); defaults Margo's |
| C8 | directional cascades, finest-cascade select, 3x3 PCF | clustered/src/shadows.ts | Engel 2006 / Dimitrov 2007 (CSM) |
| C9 | cascade splits, lambda 0.5 | clustered/src/light-shadow-math.ts | Zhang et al. 2006, "Parallel-Split Shadow Maps", practical split scheme |
| C10 | area-light PCSS: blocker search, penumbra, Vogel disk taps, receiver-plane depth bias | clustered/src/shadows.ts | Fernando 2005 (PCSS); Vogel 1979 (spiral); Isidoro 2006 GDC (receiver-plane depth bias) |
| C11 | area-light cube face guard band, smallest radius | clustered/src/light-shadow-math.ts, clustered/src/shadows.ts | Margo-own: Margo design choice |
| C12 | integrated-map defaults near min(0.1, far/100), bias 0.0005, normalBias 0.02 | clustered/src/local-shadows.ts | Margo-own: Margo design choice |
| C13 | LTC rectangle lights, horizon clip, Fresnel split f0 x mag + (1-f0) x fres; table fitted by `scripts/build-ltc.mjs` from first principles | clustered/src/area.ts, clustered/src/ltc.ts | Heitz, Dupuy, Hill & Neubelt 2016; Hill & Heitz 2016 course notes (Fresnel split). areaEdge already rewritten (LTC edge) |
| C14 | IES LM-63 parse, 1 deg x 5 deg resample, flux by midpoint rule, type-C orientation | clustered/src/ies.ts | ANSI/IES LM-63 |
| C15 | projector light: perspective projection of an image, sRGB decode | clustered/src/projector.ts | IEC 61966-2-1 |
| C16 | spot smoothstep(cos outer, cos inner); luminance check 0.2126/0.7152/0.0722 | clustered/src/index.ts, clustered/src/area.ts, clustered/src/directional.ts | ITU-R BT.709 luma weights |

### core

| id | formula | file | source |
| --- | --- | --- | --- |
| P1 | Core / WebGL / gltf-pro direct light: GGX D, separable Smith G, Schlick F, Lambert | core/src/shaders.ts, webgl/src/index.ts, gltf-pro/src/shader.ts | glTF 2.0 spec Appendix B (B.3.2-B.3.5); Walter 2007 eq. 33/34; Schlick 1994 |
| P42 | Default ambient strength | core/src/engine.ts | Margo-own: Margo design choice |

### creative

| id | formula | file | source |
| --- | --- | --- | --- |
| P33 | Core-mesh toon bands + rim | creative/src/toon.ts | Margo-own: rim = Schlick-like falloff; exponent 3 and defaults are Margo's |
| C-01 | Height fog | creative/src/post.ts | Mathematical integral of an exponential height density (e.g. Wenzel, "Real-time Atmospheric Effects in Games", SIGGRAPH 2006 course) |
| C-02 | God rays | creative/src/post.ts | Margo-own: Method: Mitchell, "Volumetric Light Scattering as a Post-Process", GPU Gems 3 ch. 13, 2007; these values are not that chapter's and are Margo's |
| C-03 | Grade: exposure, gain, lift, saturation, contrast | creative/src/post.ts | ASC CDL v1.2 (slope/offset/saturation) for the form; BT.709 weights |
| C-04 | Focus blur | creative/src/post.ts | Margo-own: Margo design |
| C-05 | Film grain | creative/src/post.ts | O'Neill 2014; Jarzynski & Olano, JCGT 9(3), 2020 (cited) |
| C-06 | Cel bands and rim | creative/src/toon.ts | Cel ramp: Lake, Marshall, Harris, Blackstein, "Stylized Rendering Techniques for Scalable Real-Time 3D Animation", NPAR 2000. Rim exponent is Margo's |
| C-08 | Planet surface: Lambert day, night lights across twilight, Phong ocean glint | creative/src/shaders/planet_surface.wgsl | Margo-own: Lambert; Phong 1975. Constants are artistic |
| C-09 | "Atmosphere": a cloud shell and a rim glow, not scattering | creative/src/shaders/planet_atmosphere.wgsl | Margo-own: Artistic; there is no Rayleigh/Mie or Bruneton/Hillaire model here |
| C-10 | Defaults | creative/src/planet.ts | Margo-own: Public-API defaults; tilt is a physical fact |
| C-11 | Procedural star field | creative/src/shaders/stars.wgsl | PCG cited; the rest is artistic |
| C-12 | Grass shading: wrap diffuse and back-light | creative/src/shaders/grass.wgsl | Wrap lighting: Green, "Real-Time Approximations to Subsurface Scattering", GPU Gems ch. 16, 2004; values Margo's |
| C-13 | Blade bend and wind | creative/src/shaders/grass.wgsl, creative/src/grass.ts | Margo-own: Margo design |

### dof

| id | formula | file | source |
| --- | --- | --- | --- |
| D-01 | View depth from reversed-Z depth (perspective and orthographic) | dof/src/shaders.ts | Projection algebra |
| D-02 | Circle of confusion | dof/src/shaders.ts, dof/src/index.ts | Thin-lens equation (Potmesil & Chakravarty, "A Lens and Aperture Camera Model", 1981) |
| D-03 | Defaults: focus 5, focal length 0.05, f/2.8, max radius 16 | dof/src/index.ts | Margo-own: Public-API defaults |
| D-04 | Golden-angle spiral taps | dof/src/shaders.ts | Vogel 1979 |
| D-05 | Gather tiers, depth tests, near weighting | dof/src/shaders.ts | Margo-own: Margo design (explained in comments) |

### environment

| id | formula | file | source |
| --- | --- | --- | --- |
| E1 | equirect to cube with n x n supersampling | environment/src/shaders.ts | Margo-own: standard lat-long mapping |
| E2 | 2x2 box downsample of cube mips | environment/src/shaders.ts | box filter |
| E3 | GGX specular prefilter, N = V = R, filtered importance sampling | environment/src/shaders.ts | Karis 2013 split sum (eq. 4-6); Colbert & Krivanek, GPU Gems 3 ch. 20, eq. 13 (the +1 bias is in that equation) |
| E4 | Hammersley points, GGX half-vector sampling | environment/src/shader-common.ts | Hammersley/van der Corput radical inverse; Walter et al. 2007 eq. 35-36 |
| E5 | L2 SH projection with exact cube-texel solid angles; irradiance bands | environment/src/shaders.ts | Ramamoorthi & Hanrahan 2001 eq. 3 and 8; Sloan 2008 "Stupid SH Tricks" (basis); solid angle is exact geometry |
| E6 | CPU SH basis, evaluation, equirect projection (4 sub-rows per row) | environment/src/sh.ts | as E5 |
| E7 | split-sum DFG LUT (scale, bias) | environment/src/shaders.ts | Karis 2013 eq. 8-9; Walter 2007 eq. 33-34; Schlick 1994 |
| E8 | IBL shade with multiple-scattering energy compensation | environment/src/ibl.ts | Fdez-Aguera 2019, JCGT 8(1); F0 from glTF 2.0 Appendix B (ior 1.5) |
| E9 | bilinear read of the LUT from a storage buffer | environment/src/ibl.ts | Margo-own: Margo design choice |
| E10 | roughness to mip: linear, r (mips-1); default mip count log2(size)-2, at least 2 | environment/src/environment.ts | Margo-own: Margo design choice |
| E11 | background pass, exposure multiply, display transform | environment/src/shaders.ts | Margo-own: display = Khronos PBR Neutral + sRGB (shared/display.js). NOTE: comments at shaders.ts:199 and background.ts:61 still say "Reinhard" (stale) |
| E12 | 8-bit image background, sRGB encode, cylinder mapping, default height 2pi h/w | environment/src/shaders.ts, environment/src/background.ts | IEC 61966-2-1 (sRGB) |
| E13 | scene fog: linear, exp2, times exponential height thinning | environment/src/lighting.ts | OpenGL 1.x fog equations (linear, EXP2); exponential height density is the standard exponential atmosphere |
| E14 | Henyey-Greenstein phase | environment/src/volumetric.ts | Henyey & Greenstein 1941 |
| E15 | 3D value noise with PCG lattice hash | environment/src/volumetric.ts | Jarzynski & Olano 2020 JCGT 9(3) (PCG); Perlin 1985 (already rewritten, hashes spec) |
| E16 | density: height exponential times two-octave noise | environment/src/volumetric.ts | Margo-own: Margo design choice |
| E17 | sun shadow (4 stratified samples) and clustered local lights in froxels | environment/src/volumetric.ts | Margo-own: Margo design choice |
| E18 | front-to-back slice integration, analytic per slice | environment/src/volumetric.ts | Hillaire 2015 SIGGRAPH course "Physically Based and Unified Volumetric Rendering in Frostbite" (energy-conserving integration); Wronski 2014 (froxels, reprojection) |
| E19 | composite, opacity 1 - exp(-tau) | environment/src/volumetric.ts | Beer-Lambert |
| E20 | option defaults: density 0.02, anisotropy 0.5 ( | environment/src/volumetric.ts | <= 0.95), noiseScale 8, range 100, temporal 0.9 (max 0.98); Halton jitter |
| E21 | octahedral encode/decode | environment/src/probes.ts | Cigolle et al. 2014 JCGT 3(2) |
| E22 | probe box fade | environment/src/probes.ts | Margo-own: Margo design choice |
| E23 | L1/L2 SH volume probes, trilinear blend; cube-texel weight (1+u^2+v^2)^-3/2, 4pi normalisation | environment/src/probes.ts | Ramamoorthi & Hanrahan 2001; texel solid angle is exact geometry |
| E24 | box-projected (parallax-corrected) reflection probes | environment/src/probes.ts | Bjorke, GPU Gems ch. 19 (2004); Lagarde & Zanuttini 2012 |
| E25 | analytic environment BRDF when no Environment is bound | environment/src/probes.ts | published engine standard: Karis 2014, "Physically Based Shading on Mobile" (after Lazarov 2013) |
| E26 | probe GGX prefilter (sampled and direct convolution, weight D nl / r^3) | environment/src/probes.ts | Walter 2007; Karis 2013 |
| E27 | fallback hemisphere ambient for glTF-pro without an Environment | environment/src/probes.ts | Margo-own: mirrors gltf-pro's own ambient |
| E28 | capture near/far 0.05 / 1000 | environment/src/probes.ts, environment/src/cube-camera.ts | Margo-own: Margo design choice |
| E29 | hemisphere light mix(ground, sky, n.y/2 + 1/2) | environment/src/hemisphere.ts | Margo-own: classical hemisphere lighting |
| E30 | planar reflector/refractor: projective lookup, normal-map offset, mip blur | environment/src/planar.ts | Margo-own: Segal et al. 1992 (projective texturing) |
| E31 | sRGB decode/encode, linear sRGB to linear Display P3 | environment/src/output.ts | IEC 61966-2-1; SMPTE EG 432-1 (P3 D65 primaries; matrix derived from primaries) |
| E32 | gradient background; cube flip and box reduce | environment/src/color.ts, environment/src/cube-camera.ts | Margo-own: Margo design choice |

### exporters

| id | formula | file | source |
| --- | --- | --- | --- |
| EX1 | Blinn-Phong exponent to/from glTF roughness | exporters/src/model.ts, exporters/src/scene.ts, exporters/src/dae.ts | Walter et al. 2007 sec. 5.2 (Phong-Beckmann correspondence alpha_p = 2 alpha_b^-2 - 2) |
| EX6 | Packed atlases: MaxRects with best-short-side-fit | exporters/src/atlas.ts | Jylanki 2010, "A Thousand Ways to Pack the Bin" |
| EX7 | Godot SpriteFrames and TileSet text resources, TileMapLayer.set_cell flips | exporters/src/godot-2d.ts | Godot's public TSCN/TRES format documentation and class reference |
| EX8 | Unity TextureImporter meta, AnimationClip, Tilemap and TileBase use | exporters/src/unity-2d.ts | Unity's public manual and scripting reference |

### sprites

| id | formula | file | source |
| --- | --- | --- | --- |
| SP1 | Aseprite file layout: header, frames, layer, cel, tag, palette, user data and slice chunks | sprites/src/aseprite.ts | Aseprite's public file format specification document (docs/ase-file-specs.md), read alone; its source was not read |

| EX3 | Animated PNG chunks (acTL, fcTL, fdAT, sequence numbers, delays, dispose and blend ops) | exporters/src/apng.ts | W3C PNG specification, third edition |
| EX4 | Lossless WebP encoding (VP8L header, colour indexing, subtract green, predictor modes, LZ77 prefix coding, code-length codes) and the animated container (VP8X, ANIM, ANMF) | exporters/src/webp.ts | RFC 9649 WebP Lossless Bitstream Specification; WebP Container Specification |
| EX5 | Length-limited canonical prefix codes | exporters/src/prefix-codes.ts | Huffman 1952; canonical order as RFC 9649 defines it. Over-long trees are rebuilt with a raised count floor |

### fbx

| id | formula | file | source |
| --- | --- | --- | --- |
| EX2 | FBX shininess to roughness | fbx/src/material.ts | Walter et al. 2007 sec. 5.2, (2/(n+2))^(1/4) like materials and exporters (square root restored 2026-10-24) |
| EX9 | Unreal UCX_, UBX_, USP_ collision names and Python material graph | exporters/src/unreal-import.ts | Unreal's public collision naming documentation and Python API reference |
| EX10 | Unity AnimationClip curves on a material property, Roblox TextureID and CollisionFidelity | exporters/src/unity-uv.ts, exporters/src/roblox-uv.ts | Unity's and Roblox's public API references |
| EX3 | FBX 7.4 writer: node records, typed and deflated arrays, object and connection layout | fbx/src/export.ts | The Blender Foundation's public description of the binary format and the public ASCII structure; no exporter source read. Header, FileId, footer constants and record names checked against the bytes of the repository's own `packages/fbx/test/fixtures/blender-rig.fbx` (CC0) |
| EX11 | FBX camera and light properties: names, defaults, enum values, film and lens to field of view, cone angles | fbx/src/scene-extras.ts | The public FBX SDK class reference (FbxCamera, FbxLight), the pinhole relation tan(fov / 2) = film / (2 x focal length), and the values Blender writes in the repository's own `packages/fbx/test/fixtures/blender-shot.fbx` (CC0); no reader source read |
| EX12 | FBX key flags, tangent data, layer blend modes and accumulation modes | fbx/src/layers.ts | The public FBX SDK reference (FbxAnimCurveDef, FbxAnimLayer), Autodesk's MotionBuilder help on layer modes, Kochanek and Bartels 1984; the power rule of a multiplying scale, axis values held on curve nodes and rotation blended as XYZ were measured on the stored values of real Maya files; no reader source read |
| EX13 | FBX inherit types, the meaning of a cluster's Transform, auto tangent clamps | fbx/src/inherit.ts, skin.ts, layers.ts | The public FBX SDK reference (FbxTransform::EInheritType, FbxAnimCurveDef) and Maya's documented joint matrix with its inverse parent scale; that Transform is the inverse bind and type 2 follows Maya's order were measured on the stored values and OBJ frames of real files; no reader source read |
| EX4 | Euler XYZ to and from quaternion, slerp, Hermite sampling of glTF cubic keys | fbx/src/export.ts | Textbook rotation algebra (Shoemake 1985 for slerp); glTF 2.0 specification, appendix C, for the cubic spline |

### gltf-pro

| id | formula | file | source |
| --- | --- | --- | --- |
| P9 | Sheen roughness floor | gltf-pro/src/shader.ts | Margo-own: documented in comment (peak D bound) |
| P14 | Built-in hemisphere ambient (ground-to-sky gradient) and crude ambient specular | gltf-pro/src/shader.ts, gltf-pro/src/pbr-hooks.js, gltf-pro/src/lobe-shader.ts | Margo-own: hemisphere ambient colours and weights are a Margo design choice |
| P15 | Minimum perceptual roughness | gltf-pro/src/shader.ts, core/src/engine.ts, core/src/geometry.ts | published engine standard: minimum perceptual roughness of the Filament design document |
| P16 | Dielectric F0 from IOR times specular colour/factor | gltf-pro/src/shader.ts | KHR_materials_ior, KHR_materials_specular |
| P17 | Clearcoat Fresnel and layering | gltf-pro/src/shader.ts, materials/src/shader.ts | KHR_materials_clearcoat (F0 0.04 for IOR 1.5; mix by clearcoat x fresnel) |
| P18 | Thin-film Fresnel | gltf-pro/src/shader.ts, materials/src/iridescence.ts | KHR_materials_iridescence; Belcour & Barla 2017 |
| P19 | Anisotropic GGX D and visibility; direction rotation | gltf-pro/src/shader.ts, gltf-pro/src/lobe-shader.ts | KHR_materials_anisotropy "Implementation"; Burley 2012; Heitz 2014 (separable G1 in lobe-shader, cites pbr-book) |
| P20 | Anisotropic bent normal for IBL | gltf-pro/src/shader.ts | KHR_materials_anisotropy "Image-based lighting" (spec text gives this heuristic) |
| P21 | Isotropic V term, diffuse transmission back lobe | gltf-pro/src/shader.ts | glTF Appendix B; KHR_materials_diffuse_transmission |
| P22 | Ambient layering (iridescence/diffuse-transmission split of an IBL hook) | gltf-pro/src/shader.ts | Margo-own: Margo derivation (documented, "ponytail" note) |
| P44 | F0 to IOR guard | gltf-pro/src/shader.ts | Margo-own: Margo guard (documented) |

### lightmap

| id | formula | file | source |
| --- | --- | --- | --- |
| L1 | exact unpolarised dielectric Fresnel | lightmap/src/optics.ts | Fresnel equations; PBRT 4e sec. 9.3 |
| L2 | Beer-Lambert transmittance | lightmap/src/optics.ts | Beer-Lambert |
| L3 | direct form factor cos_i cos_j A / (pi r^2) and radiometry modes | lightmap/src/global.ts | Goral et al. 1984; Cohen & Wallace 1993 |
| L4 | bounce gather by cosine-weighted hemisphere rays | lightmap/src/global.ts | Malley's method, PBRT 4e sec. A.5 |
| L5 | caustic photons: point power 4pi I, area power pi L A, Snell refraction, Fresnel split | lightmap/src/refracted.ts | photometry; PBRT 4e sec. 9.3 (cited line 3) |
| L6 | sRGB encode, defaults (texelsPerUnit 1, aoDistance 4), normal 0.5-bias encode, ray bias 1e-3 | lightmap/src/bake.ts | IEC 61966-2-1 |

### lod

| id | formula | file | source |
| --- | --- | --- | --- |
| LD1 | imposter relight: GGX/Schlick sun + gltf-pro hemisphere ambient or flat; Neutral | lod/src/imposter.ts | as VX5/VX6/VX7 |
| LD2 | octahedral view grid, 3-view blend with one parallax step | lod/src/imposter.ts | octahedral map: Praun & Hoppe 2003; Cigolle et al. 2014. Imposter idea: Brucks 2018 "Octahedral Impostors" (blog; technique only, no numbers used) |
| LD3 | coverage cross-fade 0.25-0.75 and IGN dither | lod/src/imposter.ts | Jimenez 2014 |

### materials

| id | formula | file | source |
| --- | --- | --- | --- |
| P8 | Sheen albedo scaling of the base layer | materials/src/lobe-shader.ts, gltf-pro/src/shader.ts | KHR_materials_sheen "Albedo-scaling technique" |
| P23 | Specular-extension Fresnel mix, diffuse x (1-max F) | materials/src/lobe-shader.ts | KHR_materials_specular (dielectric_brdf / albedo scaling) |
| P24 | L2 SH irradiance evaluation | materials/src/env-map.ts | Ramamoorthi & Hanrahan 2001 (real SH basis constants) |
| P25 | Split-sum environment BRDF, analytic | materials/src/env-map.ts | published engine standard: Karis 2014, "Physically Based Shading on Mobile" (after Lazarov 2013) |
| P26 | Roughness to mip: lod = roughness x top mip; irradiance fallback mip = levels-3 | materials/src/env-map.ts | Margo-own: Margo design choice |
| P27 | Ambient = radiance x (F0 A + B) + (1 - spec) kd base irradiance | materials/src/env-map.ts | Karis 2013 split sum |
| P28 | Normalized Blinn-Phong lobe | materials/src/built-material.ts | Blinn 1977; normalization in Akenine-Moller et al. RTR / Hoffman 2010 course notes |
| P29 | Phong exponent to GGX roughness | materials/src/built-material.ts | Walter 2007 sec. 5.2 (alpha_p = 2/alpha_b^2 - 2) |
| P30 | Phong `shininess` default | materials/src/built-material.ts | Margo-own: the exponent whose Walter et al. 2007 GGX roughness (2/(n+2))^(1/4) is 0.5, core's default roughness |
| P31 | envMap `refractionRatio` default | materials/src/built-material.ts | Margo-own: air to crown glass, 1/1.5 (standard refractive-index tables); rewritten 2026-10-24 |
| P32 | Toon ramp on half-Lambert, n bands | materials/src/toon-shader.ts | Mitchell, McTaggart, Green 2006 (Valve) |
| P35 | Transmission blur level from roughness and IOR | materials/src/transmission-pass.ts | Margo-own: screen footprint from the median GGX facet tilt and Snell's law, zero at IOR 1 (KHR_materials_transmission says only that blur grows with IOR); rewritten 2026-10-24 |
| P36 | Dispersion IOR spread | materials/src/transmission-pass.ts, materials/src/transmission-shader.ts | KHR_materials_dispersion spec text |
| P37 | Beer-Lambert volume, Schlick entry weight | materials/src/transmission-pass.ts, materials/src/transmission-shader.ts | KHR_materials_volume; glTF Appendix B |
| P38 | Luminance | materials/src/catcher.ts, shader/src/effects.ts | ITU-R BT.709-6 |
| P43 | Lambertian light-map response | materials/src/built-material.ts | Lambert |

### oit

| id | formula | file | source |
| --- | --- | --- | --- |
| O-01 | Weighted blended OIT weight | oit/src/index.ts | McGuire & Bavoil, "Weighted Blended Order-Independent Transparency", JCGT 2(2), 2013, eqs. 7-9 form (cited). Power, scale and the 1000 cap are Margo's, with the reason given in a comment |
| O-02 | Composite accum/revealage | oit/src/index.ts | McGuire & Bavoil 2013 |

### points

| id | formula | file | source |
| --- | --- | --- | --- |
| PO1 | sphere-impostor headlight 0.3 + 0.7 max(n.l), l fixed in view space | points/src/shaders.ts | Margo-own: Margo design choice |
| PO2 | eye-dome lighting | points/src/shaders.ts | Boucheny 2009 thesis, cited |

### post

| id | formula | file | source |
| --- | --- | --- | --- |
| P-01 | Downsample chain (13 taps, five boxes 0.5/0.125), tent upsample, Karis 1/(1+luma) weighting of the first level | post/src/bloom.ts | Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014 (cited in code and NOTICE.md) |
| P-02 | Luma for the Karis weight | post/src/bloom.ts | ITU-R BT.709 |
| P-03 | Threshold: keep the part of the brightest channel above `threshold` | post/src/bloom.ts | Margo-own: Margo design (hard knee), public default threshold 1 |
| P-04 | Level weights for `radius` | post/src/bloom.ts | Margo-own: Margo design, documented in `BloomOptions.radius` |
| P-05 | Triangular dither of up to one 8-bit step | post/src/bloom.ts | Gjøl & Svendsen, "INSIDE", GDC 2016 (cited). The hash is Chris Wellons' published "lowbias32" ("Prospecting for Hash Functions", 2018, public domain) seeded with the golden-ratio and MurmurHash3 fmix constants. The hash is not cited in the code |
| P-06 | SSAO: normal-oriented hemisphere kernel, range check | post/src/shaders.ts | Mittring, "Finding Next Gen: CryEngine 2", SIGGRAPH 2007 course; J. Chapman, "SSAO Tutorial" (2013, blog): hemisphere kernel, 4x4 rotation noise, range check |
| P-07 | 32-sample kernel | post/src/ssao.ts | Golden-angle spiral (Vogel 1979); the length falloff lerp(0.1, 1, s^2) is Chapman's tutorial |
| P-08 | 4x4 rotation-noise texture | post/src/ssao.ts | Chapman 2013 (tiled rotation vectors) |
| P-09 | Public defaults radius 0.5, bias 0.025 | post/src/ssao.ts | Margo-own: Public-API defaults |
| P-10 | Separable bilateral blur of AO | post/src/shaders.ts | Margo-own: No external fitted values. Undocumented tuning; add a one-line comment |
| P-11 | Normals from depth (the neighbour with the smaller depth step on each axis) | post/src/shaders.ts | Margo-own: Common reconstruction; threshold explained in code |
| P-12 | Composite: remove ambient x (1 - AO) only | post/src/shaders.ts, post/src/ssao.ts | Margo-own: Margo design |
| P-13 | GTAO horizon search and cosine-weighted arc integral | post/src/gtao.ts | Jimenez, Wu, Pesce, Jarabo, "Practical Real-Time Strategies for Accurate Indirect Occlusion", 2016, eq. 10 (cited) |
| P-14 | Occluder distance falloff | post/src/gtao.ts | Margo-own: Margo design, documented in `GTAOOptions.radius` |
| P-15 | 4x4 Bayer slice rotation and step offset | post/src/gtao.ts | Bayer, "An optimum method for two-level rendition of continuous-tone pictures", 1973 |
| P-16 | Hierarchical-depth ray march | post/src/gtao.ts | Uludag, "Hi-Z Screen-Space Cone-Traced Reflections", GPU Pro 5, 2014; McGuire & Mara, "Efficient GPU Screen-Space Ray Tracing", JCGT 3(4), 2014. Not cited in code; constants are Margo's |
| P-17 | Split-sum environment BRDF without IBL (analytic fit) | post/src/ssr.ts | published engine standard: Karis 2014, "Physically Based Shading on Mobile" (after Lazarov 2013) |
| P-18 | Dielectric F0 | post/src/ssr.ts | glTF 2.0 Appendix B |
| P-19 | SSR fades and roughness blur level | post/src/ssr.ts | Margo-own: Margo design; distance and roughness fades documented in `SSROptions` |
| P-20 | Orthonormal basis around the normal | post/src/ssgi.ts | Duff, Burgess, Christensen et al., "Building an Orthonormal Basis, Revisited", JCGT 6(1), 2017 (cited) |
| P-21 | Cosine-weighted directions | post/src/ssgi.ts | Malley's method (cited; Pharr, Jakob, Humphreys, PBRT 13.6.3); Vogel spiral |
| P-22 | SSGI ray start offset, fades, 8-tap bilateral blur | post/src/ssgi.ts | Margo-own: Margo design |
| P-23 | Motion blur reconstruction (tiles, neighbourhood max, depth-classified gather) | post/src/motion-blur.ts | McGuire, Hennessy, Bukowski, Osman, "A Reconstruction Filter for Plausible Motion Blur", I3D 2012 (cited); soft-edge values are Margo's |
| P-24 | Interleaved gradient noise | post/src/motion-blur.ts | Jimenez, SIGGRAPH 2014 "Next Generation Post Processing in CoD: AW" (the constants are on the slides; cited) |
| P-25 | FXAA edge walk | post/src/fxaa.ts | Lottes 2009, "FXAA" (NVIDIA whitepaper): method and its published sub-pixel preset 0.75; thresholds and search steps are Margo's; rewritten 2026-10-24 |
| P-26 | Luma | post/src/fxaa.ts | ITU-R BT.601 |
| P-27 | Quality presets | post/src/smaa.ts | Jimenez, Echevarria, Sousa, Gutierrez, "SMAA", EG 2012; presets are the ones the authors publish with the method (NOTICE.md says so). They are user-facing settings, not a fitted curve |
| P-28 | Area and search tables built in code | post/src/smaa.ts | Morphological model of Reshetov 2009 / Jimenez et al. 2011 (GPU Pro 2) and 2012; the encoding and tables are Margo's own derivation |
| P-29 | Edges with local contrast adaptation | post/src/smaa.ts | SMAA 2012, local contrast adaptation (factor 2 is the paper's) |
| P-30 | Bilinear edge search | post/src/smaa.ts | Margo-own: Bilinear double-fetch idea from Jimenez et al., "Practical Morphological Antialiasing", GPU Pro 2, 2011. The two thresholds follow from Margo's own 21/7/3/1 encoding (0.83 sits between 25/32 and 28/32; 0.015 is under the smallest flag, 1/32) |
| P-31 | Glow, halo ring and six ghosts | post/src/lens-flare.ts | Margo-own: Artistic; no physical model or external source |
| P-32 | Sun visibility from an 8x8 depth disc | post/src/lens-flare.ts | Margo-own: Margo design |
| P-33 | Vignette | post/src/image.ts | cos^4 natural-vignetting law (1/(1+t^2)^2); scale 0.2238 fitted to observed MagicaVoxel output |
| P-34 | ImagePost curves and display gamma | post/src/image.ts | as cited |
| P-35 | Projected decal fade | post/src/decals.ts | Margo-own: Margo design |

### scatter

| id | formula | file | source |
| --- | --- | --- | --- |
| SC1 | simple instance shading 0.25 + 0.75 max(0, n.l) toward fixed (1,2,1) | scatter/src/index.ts | Margo-own: Margo design choice |
| SC2 | back-light translucency lobe + wrapped diffuse | scatter/src/instances.ts | Barre-Brisebois & Bouchard 2011 GDC, "Approximating Translucency for a Fast, Cheap and Convincing Subsurface Scattering Look" (lobe form, parameters free); Green 2004 GPU Gems ch. 16 (wrap lighting) |

### selection

| id | formula | file | source |
| --- | --- | --- | --- |
| S-01 | Jump-flood outline distance field; dilation fallback | selection/src/index.ts | Rong & Tan, "Jump Flooding in GPU with Applications to Voronoi Diagram and Distance Transform", I3D 2006. Not cited in code |
| S-02 | X-ray dashes, defaults | selection/src/index.ts | Margo-own: Public-API defaults |

### shader

| id | formula | file | source |
| --- | --- | --- | --- |
| P39 | Vignette | shader/src/effects.ts | Margo-own: Margo's own parameterisation; defaults do not match any engine I know |
| P40 | RGB shift default amount | shader/src/effects.ts | Margo-own: 0.002, about 4 px of fringe at 1920 wide; rewritten 2026-10-24 |
| P41 | Sobel; sepia | shader/src/effects.ts | Sobel; W3C Filter Effects L1 sepia() |

### shadows

| id | formula | file | source |
| --- | --- | --- | --- |
| SH1 | cascade far splits, log/uniform blend | shadows/src/cascades.ts | Zhang, Sun, Xu, Lo 2006 "Parallel-split shadow maps" (practical split scheme, eq. for C_i = lambda C_log + (1-lambda) C_uni); GPU Gems 3 ch. 10 |
| SH2 | bounding-sphere ortho fit per cascade, texel-snapped centre | shadows/src/cascades.ts | Valient 2008 "Stable Rendering of Cascaded Shadow Maps" (ShaderX6); Microsoft "Common Techniques to Improve Shadow Depth Maps" (sphere fit, texel snapping) |
| SH3 | cascade pick by view depth, dithered blend over last tenth of each cascade | shadows/src/shader.ts | Margo-own: cascade blending: Microsoft CSM article ("blend between cascades"); dither threshold is Margo's |
| SH4 | interleaved gradient noise per screen pixel (x and transposed y) | shadows/src/shader.ts | Jimenez 2014, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH Advances (IGN formula with these constants) |
| SH5 | golden-angle (Vogel) spiral tap rotation | shadows/src/shader.ts | Vogel 1979, "A better way to construct the sunflower head", Math. Biosciences 44 |
| SH6 | PCSS: blocker search, penumbra estimate, filtered compare | shadows/src/shader.ts | Fernando 2005, "Percentage-Closer Soft Shadows", SIGGRAPH sketch (blocker search, w_penumbra = (d_r - d_b) w_light / d_b; for ortho lights linear in depth difference) |
| SH7 | four bilinear-compare taps half a texel apart (3x3 B-spline footprint) | shadows/src/shader.ts | Reeves, Salesin, Cook 1987 "Rendering antialiased shadows with depth maps" (PCF); hardware 2x2 compare (WebGPU `textureSampleCompare`) |
| SH8 | receiver-plane depth bias from the light-space normal; minus half-footprint | shadows/src/shader.ts | slope |
| SH9 | normal-offset receiver position; constant bias; light size | shadows/src/shader.ts, shadows/src/index.ts | Holbert 2011, "Normal Offset Shadows" (GDC poster / blog) |
| SH10 | depth-only caster with alpha test | shadows/src/shader.ts | Margo-own: Margo design choice |

### shared

| id | formula | file | source |
| --- | --- | --- | --- |
| P2 | ggxD / smithG text snippets used by every PBR shader | shared/light-terms.js | glTF 2.0 Appendix B |
| P3 | Khronos PBR Neutral + sRGB encode | shared/display.js, core/src/shaders.ts, shader/src/raw.ts | Khronos PBR Neutral spec (2024); IEC 61966-2-1 |
| P4 | Light distance window and spot cone | shared/light-terms.js | Karis 2013 eq. 9 (window); floor is Margo's (documented: ball of radius 1/64) |
| P5 | clustered per-light BRDF text | shared/light-terms.js | glTF Appendix B |
| P6 | Charlie sheen D and Neubelt visibility | shared/sheen.js | Estevez & Kulla 2017; KHR_materials_sheen (visibility 1/(4(nl+nv-nl nv))) |
| P7 | Sheen directional albedo fit E(mu,r) | shared/sheen.js | Margo-own: fitted by Margo, scripts/sheen-albedo-fit.mjs (numerical integration of P6) |
| P10 | Linear and exp2 fog with height falloff | shared/fog.js | OpenGL 1.x fixed-function fog equations (linear, EXP2); height term is a plain exponential |
| P11 | Margo ACES-style fit | shared/aces.js | Margo-own: least-squares fit of its own functional form to sampled curve outputs (clean room) |
| P12 | Narkowicz ACES curve | shared/aces.js | Narkowicz 2016 blog (published formula) |
| P13 | AgX | shared/agx.js | Sobotka/Chow write-ups (clean room 4a58b5d6) |
| C3 | GGX D, separable Smith-GGX G, Schlick Fresnel, Lambert/pi + D G F / (4 nl nv) | shared/light-terms.js, clustered/src/shader.ts | Walter 2007 eq. 33-34; Schlick 1994; glTF 2.0 Appendix B |
| C5 | windowed inverse-square falloff, spot cone | shared/light-terms.js | Karis 2013 (already rewritten "light falloff") |
| T-02 | ACES-style fitted curve | shared/aces.js | Margo-own: least-squares fit of its own functional form to sampled curve outputs (clean room) |
| T-03 | Narkowicz ACES film fit | shared/aces.js | K. Narkowicz, "ACES Filmic Tone Mapping Curve", blog, 2016-01-06 (the published formula) |
| T-04 | AgX display transform | shared/agx.js | Sobotka AgX; Eary Chow AgX_LUT_Gen write-up; BT.709/BT.2020 primaries; clean room 4a58b5d6, cited in NOTICE.md |
| T-05 | Khronos PBR Neutral, then the exact sRGB encoding | shared/display.js | Khronos PBR Neutral specification (startCompression 0.8, desaturation 0.15, offset formula) |

### sky

| id | formula | file | source |
| --- | --- | --- | --- |
| S1 | Preetham analytic sky: Perez function, Y/x/y distribution coefficients vs turbidity, zenith luminance and chromaticity polynomials, XYZ to sRGB | sky/src/preetham.ts | Preetham, Shirley & Smits 1999, Appendix A.2 (tables and zenith formulas); IEC 61966-2-1 matrix |
| S2 | luminance scale 0.05; horizon fade smoothstep(-0.2, 0.05, sun.y); clamps 0.01, 0.001 | sky/src/preetham.ts | Margo-own: Margo design choice |
| S3 | planet R 6360, top 6460 km; Rayleigh beta (0.005802, 0.013558, 0.0331)/km; scale heights 8 and 1.2 km | sky/src/atmosphere.ts | Hillaire 2020 Table 1 (verified); Bruneton & Neyret 2008 sec. 2 (radii, scale heights) |
| S4 | Mie scattering 0.003996/km times turbidity factor max(0.25,(T-1)/2); extinction = scattering / 0.9 | sky/src/atmosphere.ts | 3.996e-6: Hillaire 2020 Table 1; /0.9: Bruneton & Neyret 2008 sec. 2. Turbidity factor is Margo's |
| S5 | Rayleigh phase 3/(16pi)(1+nu^2); Cornette-Shanks Mie phase, g 0.8 | sky/src/bruneton.ts | Bruneton & Neyret 2008 eq. 2-3; Hillaire 2020 sec. 3 (g = 0.8 default, verified) |
| S6 | coarse 4D table parameterisation 8x16x32x8 (nu, mu_s, sqrt-warped mu, r via quadratic) | sky/src/bruneton.ts | Margo-own: coarse variant of Bruneton & Neyret 2008 sec. 4 |
| S7 | single scattering (32 steps), density via 32-point golden-angle sphere, 3 more orders | sky/src/bruneton.ts | Bruneton & Neyret 2008 sec. 4 (algorithm); Vogel / Fibonacci sphere |
| S8 | transmittance table (64 steps) and CPU sunlight() with disc fade | sky/src/atmosphere.ts | Bruneton & Neyret 2008 sec. 4 |
| S9 | sun/moon disc and glow profile; sun x60, bloom x0.8, moon x4 + pow^8 x0.025 | sky/src/celestial.ts, sky/src/base.ts | Margo-own: stylised (real sun is 0.00465 rad) |
| S10 | night fallback gradient; ground colour below horizon | sky/src/base.ts, sky/src/environment.ts | Margo-own: Margo design choice |
| S11 | stylised night: stars on stereographic cells, twinkle, phased moon, glow | sky/src/night.ts | Margo-own: PCG hash Jarzynski & Olano 2020 |
| S12 | pcg2d hash | sky/src/clouds.ts | Jarzynski & Olano 2020 (pcg2d) |
| S13 | value-noise fbm, 49 deg x 2.13 per octave | sky/src/clouds.ts | Margo-own: Margo design choice |
| S14 | coverage remap | sky/src/clouds.ts | Schneider 2015 SIGGRAPH Advances, "Real-time Volumetric Cloudscapes of Horizon Zero Dawn" |
| S15 | two-lobe HG, g 0.6 / -0.25, weight 0.6 | sky/src/clouds.ts | Henyey-Greenstein 1941; dual-lobe form Hillaire 2016 SIGGRAPH course; lobe values Margo's |
| S16 | shell intersection, Beer-Lambert, powder, sun march, ambient | sky/src/clouds.ts | Beer-Lambert; powder term Schneider 2015 (offset and mix are Margo's) |
| S17 | SH projection of the 32x16 sky mip with pre-scaled coefficients | sky/src/lighting.ts | Ramamoorthi & Hanrahan 2001 (checked arithmetically) |
| S18 | analytic environment BRDF for sky ambient | sky/src/lighting.ts | published engine standard: Karis 2014, "Physically Based Shading on Mobile" (after Lazarov 2013) |
| S19 | sky reflection: equirect lookup, mip = roughness x 3 | sky/src/lighting.ts | Margo-own: Margo design choice |
| S20 | post depth fog beyond `start`, exp or exp2, height boost (1 + max(-y,0) h) | sky/src/fog.ts | OpenGL fog equations; height term Margo's |
| S21 | sun from clock (circle through east, zenith at noon), from angles; day/night blend window (sun.y+0.12)/0.2; moon intensity 0.1 x sun | sky/src/base.ts | Margo-own: not astronomical |
| S22 | `sunPath`: day angle 2 pi (d - 1) / 365, declination and equation of time Fourier series; elevation and azimuth from the hour angle, declination and latitude | sky/src/sun.ts | Spencer, "Fourier series representation of the position of the sun", Search 2(5), 1971 (coefficients); the spherical formulas are standard positional astronomy |

### splats

| id | formula | file | source |
| --- | --- | --- | --- |
| SP1 | view-dependent colour from real SH degree 0-3, +0.5 DC offset | splats/src/shader.ts | real SH normalisation: Sloan 2008, "Stupid Spherical Harmonics Tricks" App. A. Sign pattern and +0.5 offset are the 3DGS asset convention (Kerbl et al. 2023), needed to read trained .ply files |
| SP2 | EWA projection (view rotation, perspective Jacobian), 2D low-pass dilation, eigen axes, 3 sigma extent | splats/src/shader.ts | Zwicker et al. 2001, EWA Splatting eq. 29-31; 0.3 px^2 dilation is the 3D Gaussian Splatting asset convention (Kerbl et al. 2023) |
| SP3 | Gaussian falloff, alpha cap, low-alpha discard | splats/src/shader.ts | Kerbl et al. 2023, "3D Gaussian Splatting", App. C (clamp to 0.99, skip below 1/255) |

### taa

| id | formula | file | source |
| --- | --- | --- | --- |
| A-01 | RGB to and from YCoCg | taa/src/shader.ts | Malvar & Sullivan, "YCoCg-R", 2003 |
| A-02 | Reprojection, 3x3 YCoCg min/max clamp, history blend | taa/src/shader.ts | Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014. Not cited in code |
| A-03 | Depth rejection of history | taa/src/shader.ts | Margo-own: Margo design |
| A-04 | Halton (2, 3) jitter, 8-frame cycle | taa/src/shader.ts, taa/src/index.ts | Halton 1964; 8-sample Halton(2,3) in Karis 2014 |

### terrain

| id | formula | file | source |
| --- | --- | --- | --- |
| TR1 | GGX + Schlick (f0 0.04) + Lambert/pi sun | terrain/src/shader.ts | glTF 2.0 App. B; Walter 2007; Schlick 1994 |
| TR2 | flat ambient base x radiance.w | terrain/src/shader.ts | Margo-own: Margo design choice |
| TR3 | triplanar weights pow(abs n, 8) | terrain/src/shader.ts | Geiss 2007, GPU Gems 3 ch. 1 (triplanar texturing); exponent Margo's |
| TR4 | height/slope layer smoothstep blends | terrain/src/shader.ts, terrain/src/index.ts | Margo-own: Margo design choice |
| TR5 | CDLOD-style vertex morph | terrain/src/shader.ts | Strugar 2009, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps", JGT |
| TR6 | Khronos Neutral + sRGB | terrain/src/shader.ts | Khronos PBR Neutral; IEC 61966-2-1 |

### tonemap

| id | formula | file | source |
| --- | --- | --- | --- |
| T-01 | ACEScg (AP1, D60) to linear sRGB | tonemap/src/shaders.ts | Derived from the AP1 primaries (ACES S-2014-004, ACEScg) and the BT.709 primaries with Bradford D60 to D65 adaptation; checked to 6 dp |
| T-06 | Exposure | tonemap/src/shaders.ts | Definition of a photographic stop (factor 2) |
| T-07 | Contrast about mid grey | tonemap/src/shaders.ts | Margo-own: 18% grey convention; the linear-about-pivot form is a Margo design choice |
| T-08 | 3D LUT trilinear lookup, `.cube` parse | tonemap/src/shaders.ts, tonemap/src/cube.ts | Adobe "Cube LUT Specification" 1.0 (TITLE, LUT_3D_SIZE, DOMAIN_MIN/MAX); trilinear interpolation |
| T-09 | sRGB encode/decode | tonemap/src/shaders.ts, post/src/image.ts, taa/src/shader.ts | IEC 61966-2-1 |
| T-10 | HDR rolloff to a peak white | tonemap/src/shaders.ts | Margo-own: Khronos Neutral's compression with the target white generalised from 1 to the display peak (Margo derivation; reduces to Neutral at peak 1) |
| T-11 | sRGB to P3 and back, gamut clip in P3 | tonemap/src/shaders.ts | Derived from the Display P3 (SMPTE EG 432-1 primaries, D65) and BT.709 primaries; checked to 6 dp |
| T-12 | Neutral in the HDR output path | tonemap/src/shaders.ts | Khronos PBR Neutral + T-10 |
| T-13 | AgX/ACES scaled by the same rolloff ratio; LUT on the SDR part; out-of-gamut negative carry | tonemap/src/shaders.ts | Margo-own: Margo design, described in the TSDoc above `outputShader` |

### toon

| id | formula | file | source |
| --- | --- | --- | --- |
| P34 | Inverted-hull outline | toon/src/index.ts | Raskar & Cohen 1999 (back-face hull silhouettes) |
| C-07 | Inverted-hull outline | toon/src/index.ts | Raskar & Cohen, "Image Precision Silhouette Edges", I3D 1999 (back faces pushed out); defaults Margo's |

### transitions

| id | formula | file | source |
| --- | --- | --- | --- |
| C-14 | Wipe, dissolve, radial, chromatic shift | transitions/src/index.ts | Margo-own: PCG cited; the rest is Margo's |

### voxel

| id | formula | file | source |
| --- | --- | --- | --- |
| VX1 | 0-15 light level to brightness (sky and block light) | voxel/src/render.ts | Margo-own: equal CIE L* lightness steps per level (CIE 15:2004); rewritten 2026-10-24 |
| VX2 | per-corner vertex AO level 0-3 from two edge cells and the diagonal; triangle-diagonal flip; level to light factor | voxel/src/mesher.ts, voxel/src/render.ts, voxel-edit/src/mesh.ts | Lysenko 2013, 0fps.net (ambient occlusion for voxel worlds) (rule and diagonal flip; no brightness values given) |
| VX3 | ambient occlusion term = ao x (floor + skyLight x daylight) | voxel/src/render.ts | Margo-own: Margo design choice |
| VX4 | sun visibility = sky^2 without a shadow map; fade back to sky^2 over last 10% of shadow range | voxel/src/render.ts | Margo-own: Margo design choice |
| VX5 | hemisphere ambient with a spec-ish f0 term | voxel/src/render.ts | Margo-own: f0 0.04: glTF 2.0 App. B. The rest is hand-picked; copies gltf-pro's ambient (also lod/src/imposter.ts:639, animation/src/vat.ts:283, 293) |
| VX6 | GGX D, height-correlated Smith, Schlick F, shared `clusterBrdf` | voxel/src/render.ts | Walter et al. 2007; Heitz 2014; Schlick 1994; glTF 2.0 App. B |
| VX7 | roughness floor | voxel/src/render.ts, lod/src/imposter.ts, animation/src/vat.ts | published engine standard: minimum perceptual roughness of the Filament design document |
| VX8 | sRGB decode/encode | voxel/src/render.ts, voxel/src/textures.ts | IEC 61966-2-1 |
| VX9 | translucent (MODE 3) alpha from transmission and scatter | voxel/src/render.ts | Margo-own: Margo design choice |
| VX10 | liquid surface rise and ripple normal | voxel/src/render.ts | Margo-own: artistic |
| VX11 | shadow-caster quad grown 1/64 block | voxel/src/render.ts | Margo-own: Margo design choice |
| VX12 | BFS flood fill of sky and block light, levels 0-15, step cost 1 + opacity | voxel/src/light.ts | Margo-own: breadth-first flood fill (textbook); 4-bit levels are a common block-game design |
| VX13 | baked light x diffuse replaces sun + ambient on charted fragments | voxel/src/lightmap.ts | Margo-own: Margo design choice |
| VX14 | MATL keys to block options, direct mapping | voxel/src/vox.ts | MagicaVoxel .vox MATL chunk description (ephtracy/voxel-model format notes): file-format semantics |

### voxel-pathtracer

| id | formula | file | source |
| --- | --- | --- | --- |
| PT1 | orthonormal basis from n | voxel-pathtracer/src/shaders.ts | Duff et al. 2017, "Building an Orthonormal Basis, Revisited", JCGT 6(1) |
| PT2 | GGX NDF, Smith Lambda | voxel-pathtracer/src/shaders.ts | Walter et al. 2007 eq. 33; Heitz 2014 eq. 72/86 |
| PT3 | exact unpolarised dielectric Fresnel with TIR | voxel-pathtracer/src/shaders.ts | Born & Wolf; PBRT 4th ed. sec. 9.3 |
| PT4 | GGX visible-normal sampling | voxel-pathtracer/src/shaders.ts | Heitz 2018, "Sampling the GGX Distribution of Visible Normals", JCGT 7(4), listing 1 |
| PT5 | albedo tables E(mu,r), Eavg(r), dielectric E(mu,r,eta) | voxel-pathtracer/src/shaders.ts | Kulla & Conty 2017 (E, Eavg); Turquin 2019 (dielectric albedo normalisation) |
| PT6 | R2/R3 low-discrepancy sequences in fixed point | voxel-pathtracer/src/shaders.ts | Roberts 2018, "The Unreasonable Effectiveness of Quasirandom Sequences" (generalised golden ratio, 1/phi_d^k) |
| PT7 | Rec. 709 luminance; PCG hash and step | voxel-pathtracer/src/shaders.ts | ITU-R BT.709; O'Neill 2014 PCG; Jarzynski & Olano 2020, "Hash Functions for GPU Rendering", JCGT 9(3) |
| PT8 | MIS power heuristic, beta 2 | voxel-pathtracer/src/shaders.ts | Veach 1997 thesis sec. 9.2.4 |
| PT9 | Schlick Fresnel; cosine hemisphere sampling | voxel-pathtracer/src/shaders.ts | Schlick 1994; Malley's method, PBRT sec. 13.6 |
| PT10 | Lambert + coat + GGX metal; Kulla-Conty multiple scattering with Favg | voxel-pathtracer/src/shaders.ts | Kulla & Conty 2017 (E_ms, Fms; Favg of Schlick = F0 + (1-F0)/21 is the exact hemispherical integral) |
| PT11 | smooth/rough dielectric reflect/refract, divided by directional albedo | voxel-pathtracer/src/shaders.ts | Walter et al. 2007 sec. 5; Turquin 2019 |
| PT12 | one-sample lobe selection by weight | voxel-pathtracer/src/shaders.ts | PBRT sec. 9.x (BSDF lobe selection) |
| PT13 | Henyey-Greenstein pdf and inversion sampling | voxel-pathtracer/src/shaders.ts | Henyey & Greenstein 1941; PBRT sec. 11.3 |
| PT14 | equirect env map, bilinear radiance, marginal/conditional pdf / (2 pi^2 sin theta) | voxel-pathtracer/src/shaders.ts | PBRT sec. 12.5/13.x (piecewise-constant 2D distribution) |
| PT15 | uniform-fog glow: HG share of the upper hemisphere (16-entry table) x horizon sky + HG sun | voxel-pathtracer/src/shaders.ts, voxel-pathtracer/src/scene.ts | Margo-own: integral of HG is exact; the single-scatter, unshadowed glow model is Margo's |
| PT16 | Russian roulette after 3 bounces, survival = max throughput clamped | voxel-pathtracer/src/shaders.ts | Arvo & Kirk 1990; PBRT sec. 13.7 |
| PT17 | specular next-event estimation through planar glass/mirror chains, weighted reservoir pick | voxel-pathtracer/src/shaders.ts | Hanika et al. 2015 (MNEE, planar special case), Snell; reservoir sampling (Chao 1982) |
| PT18 | CIE 1931 CMF analytic fit to linear sRGB; Cauchy index from Abbe number; wavelength sampler | voxel-pathtracer/src/spectrum.ts | Wyman, Sloan, Shirley 2013, JCGT 2(2), multi-lobe fit; ISO 7944 lines; IEC 61966-2-1 |
| PT19 | Preetham daylight (Perez distribution, zenith Y and xy) to linear sRGB | voxel-pathtracer/src/sky.ts | Preetham, Shirley, Smits 1999, Appendix A.2 |
| PT20 | SVGF-style a-trous on demodulated radiance, variance, history reprojection | voxel-pathtracer/src/shaders.ts, voxel-pathtracer/src/tracer.ts | Dammertz et al. 2010 (a-trous, B3 kernel); Schied et al. 2017 (SVGF weights eqs. 3-5, published sigma 1/128/4, variance prefilter); Rousselle et al. 2012 (per-pixel error selection); Salvi 2016 GDC "An Excursion in Temporal Supersampling" (variance clipping); Cigolle et al. 2014 (octahedral normals) |
| PT21 | Khronos PBR Neutral on CPU | voxel-pathtracer/src/tracer.ts | Khronos PBR Neutral spec |
| PT22 | sRGB or pure-gamma display encode; Narkowicz ACES option | voxel-pathtracer/src/shaders.ts, voxel-pathtracer/src/tracer.ts | IEC 61966-2-1; Narkowicz 2015 blog |
| MV-A | MagicaVoxel `_atm` sky: single-scattering atmosphere baked to a map, sun transmittance, below-horizon fill | voxel-pathtracer/src/atmosphere.ts | model form public (Nishita et al. 1993; Rayleigh phase; Cornette & Shanks 1992). Every constant is a black-box fit to MagicaVoxel 0.99.7 panoramas (file header; fitting scripts in packages/voxel-pathtracer/tests/magicavoxel/atm*.cjs, panos.cjs); fitted to observed MagicaVoxel output |
| MV-B | palette 8-bit to linear by a pure power; fog colour left un-decoded | voxel-pathtracer/src/magicavoxel.ts | the power itself is generic; that MagicaVoxel's renderer decodes this way (and not fog) was measured from its renders; fitted to observed MagicaVoxel output |
| MV-C | inverse of Narkowicz ACES + gamma, background as display colour | voxel-pathtracer/src/magicavoxel.ts | Narkowicz 2016 ACES fit (published formula); its use as the film curve is fitted to observed MagicaVoxel output |
| MV-D | `_sss` as a sun-lit cloud with scaled extinction; subsurface bounce cap from diffuse cap | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-E | `_rough` to GGX alpha | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-F | `_trans` / `_alpha` to glass share | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-G | metal colour = min(1, specular x colour); additive coat; glass colour only through `_d` absorption; contact transmission; tint off | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-H | `_emit`/`_flux`/`_ldr` to radiance; emitters reflect nothing | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-I | `_media` legacy weight and emissive media | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-J | default settings: sun `_i` 0.7, angle [50, 50], ray_d 0.4, ray_k (45,104,255), mie_d 0.4, mie_g 0.85, o3_k (105,255,110), ground (80,80,80), caps 2/5/5, `_hor` 0.1, edge 0.2, grid 0.02 | voxel-pathtracer/src/magicavoxel.ts | MagicaVoxel .vox file-format semantics (UI defaults of its file keys) |
| MV-K | glass internal-reflection rule: two in full, then each continues half the time | voxel-pathtracer/src/magicavoxel.ts, voxel-pathtracer/src/shaders.ts | fitted to observed MagicaVoxel output |
| MV-L | sun irradiance from `_i` | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-M | sun angular size from `_area` | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-N | uniform fog extinction from `_d` | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-O | ground fade distance from `_hor` | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-P | image sky radiance and rotation | voxel-pathtracer/src/magicavoxel.ts | fitted to observed MagicaVoxel output |
| MV-Q | vignette 1 / (1 + t^2)^2, t = v r / (k H) | voxel-pathtracer/src/magicavoxel.ts, voxel-pathtracer/src/shaders.ts, voxel-pathtracer/src/tracer.ts | cos^4 natural-vignetting law; scale k = 0.2238 fitted to observed MagicaVoxel output |
| MV-R | edge bands and grid lines lit as diffuse, copying MagicaVoxel's display options | voxel-pathtracer/src/magicavoxel.ts, voxel-pathtracer/src/shaders.ts | fitted to observed MagicaVoxel output |
| MV-S | rCAM to camera; ortho height = radius; iso 35.26 deg; pano mapping | voxel-pathtracer/src/magicavoxel.ts | isometric angle atan(1/sqrt 2) is geometry; orthographic height fitted to observed MagicaVoxel output |
| MV-T | MagicaVoxel light-transport shortcuts inside the tracer, used by `look: 'magicavoxel'` | voxel-pathtracer/src/shaders.ts | fitted to observed MagicaVoxel output |

### water

| id | formula | file | source |
| --- | --- | --- | --- |
| W1 | Gerstner waves; deep-water dispersion omega = sqrt(g k) | water/src/index.ts | Fournier & Reeves 1986; Tessendorf 2001 sec. 3 (Gerstner) and dispersion relation |
| W2 | 3-component swell spectrum and bend; default swell trains | water/src/coastal.ts, water/src/index.ts | Margo-own: Margo design choice |
| W3 | Schlick Fresnel for water | water/src/index.ts | Schlick 1994 |
| W4 | sun glint: GGX D, Schlick-GGX k = (r+1)^2 / 8 | water/src/index.ts | Walter 2007; Karis 2013 ("Specular G", k remap for analytic lights) |
| W5 | sky reflection 3-tap blur, fallback gradient | water/src/index.ts | Margo-own: Margo design choice |
| W6 | water absorption over the optical path | water/src/index.ts | Margo-own: Hand-set art values of the order of pure-water absorption (Pope & Fry 1997), not a copied fit |
| W7 | seabed colour, body scatter x0.12, foam albedo, Lambert /pi | water/src/index.ts | Margo-own: Lambert |
| W8 | roughness from normal variance and footprint | water/src/index.ts | Margo-own: idea: Toksvig 2005 / LEAN (Olano & Baker 2010); values Margo's |
| W9 | shore foam, grain, ripple layers (noise rewritten, water-noise spec) | water/src/index.ts | Margo-own: Margo design choice |
| W10 | virtual-pipe shallow water, Froude breaker, foam advection | water/src/coastal.ts | O'Brien & Hodgins 1995; Mei, Decaudin & Hu 2007 (pipe model); thresholds Margo's |
| W11 | integer hash for spray | water/src/spray.ts | xxHash32 avalanche (Collet, xxHash specification): public, but uncited (already listed in hashes.md) |
| W12 | spray seeding and ballistics | water/src/spray.ts | Teschner et al. 2003 (spatial-hash primes), uncited |
| W13 | fog tail on water (Neutral + fog mix + sRGB) | water/src/index.ts | Khronos PBR Neutral; IEC 61966-2-1 |

## Data track: `@margoengine/compute`

Written clean room in October 2026 from the specifications, papers and API documentation below. No source code of
another GPU, array or data library (NumPy, CuPy, TensorFlow.js, GPU.js, taichi.js, Random123, cuFFT/VkFFT and the like)
was read. API names and semantics follow the libraries' public documentation so data scientists find what they
expect; the documentation describes behaviour, not code.

| Area | Source |
| --- | --- |
| WGSL reflection, host-shareable layout, f16 | W3C WebGPU Shading Language (resource interface; alignment and size table); W3C WebGPU (bind group layouts, timestamp queries, indirect dispatch); IEEE 754-2019 binary16 |
| Broadcasting, type promotion, `take`, `histogram`, `quantile` (linear), `argsort`, `mod`/`floorDiv`, `unique`, `bincount`, `convolve` modes | NumPy reference documentation (broadcasting rules; NEP 50 "Promotion rules for Python scalars") |
| `convolve2d` modes with zero fill | SciPy `scipy.signal.convolve2d` documentation |
| Reduce tree, scan | W. D. Hillis and G. L. Steele, "Data parallel algorithms", CACM 29(12), 1986; G. E. Blelloch, "Prefix sums and their applications", CMU-CS-90-190, 1990 |
| Segmented scan operator | J. T. Schwartz, "Ultracomputers", ACM TOPLAS 2(4), 1980; Blelloch 1990, section 1.5 |
| Radix sort | N. Satish, M. Harris and M. Garland, "Designing efficient sorting algorithms for manycore GPUs", IPDPS 2009 |
| Matrix product tiling | V. Volkov and J. W. Demmel, "Benchmarking GPUs to tune dense linear algebra", SC08 |
| FFT, Stockham radix-2 | N. K. Govindaraju, B. Lloyd, Y. Dotsenko, B. Smith and J. Manferdelli, "High performance discrete Fourier transforms on graphics processors", SC08; C. Van Loan, "Computational Frameworks for the Fast Fourier Transform", SIAM 1992 |
| FFT of any length | L. I. Bluestein, "A linear filtering approach to the computation of the discrete Fourier transform", IEEE Trans. Audio Electroacoustics 18(4), 1970 |
| Random numbers | J. K. Salmon, M. A. Moraes, R. O. Dror and D. E. Shaw, "Parallel random numbers: as easy as 1, 2, 3", SC11 (Philox4x32-10 constants and the published known-answer vectors, used as test data); G. E. P. Box and M. E. Muller, Ann. Math. Statist. 29(2), 1958; D. Lemire, "Fast random integer generation in an interval", ACM TOMACS 29(1), 2019 |
| `log1p`, `expm1` | D. Goldberg, "What every computer scientist should know about floating-point arithmetic", ACM Computing Surveys 23(1), 1991 |
| Streaming mean and variance | T. F. Chan, G. H. Golub and R. J. LeVeque, "Algorithms for computing the sample variance", Amer. Statistician 37(3), 1983 |
| Sparse CSR, SpMV, `coo`, `csr`, `diags` | SciPy `scipy.sparse` documentation (formats and constructor semantics); N. Bell and M. Garland, "Implementing sparse matrix-vector multiplication on throughput-oriented processors", SC09 |
| Conjugate gradient, BiCGSTAB, Jacobi preconditioning | M. R. Hestenes and E. Stiefel, J. Res. NBS 49(6), 1952; H. A. van der Vorst, SIAM J. Sci. Stat. Comput. 13(2), 1992; Y. Saad, "Iterative Methods for Sparse Linear Systems", 2nd ed., SIAM 2003, algorithms 9.1 and 7.7 |
| Reverse-mode differentiation | A. Griewank and A. Walther, "Evaluating Derivatives: Principles and Techniques of Algorithmic Differentiation", 2nd ed., SIAM 2008, chapter 3; derivative rules from standard calculus tables |
| CPU fallback (interpreter, LSD radix sort, host kernels) | The WGSL conversion and arithmetic rules above; D. E. Knuth, "The Art of Computer Programming" vol. 3, section 5.2.5 (radix sorting); the package's own WGSL kernels, transcribed |

## Data track: `@margoengine/sciviz`

Written clean room from the sources below. No source code of plotting or visualisation libraries (plotly, vtk.js,
deck.gl, regl, three.js, matplotlib, ParaView, napari, ipyvolume, anywidget and the like) was read. Margo's own colour maps are
computed from their published definitions. The five standard maps are the authors' published tables, recorded as data
under the standard-file exception documented above (THIRD-PARTY-NOTICES.md, `packages/sciviz/NOTICE.md`).

| Area | Source |
| --- | --- |
| Volume ray marching | J. Kruger and R. Westermann, "Acceleration techniques for GPU-based volume rendering", IEEE Visualization 2003 (front-to-back compositing, early ray termination); opacity correction for the step length from the emission-absorption model (N. Max, "Optical models for direct volume rendering", IEEE TVCG 1(2), 1995) |
| Marching cubes table (derived, not copied) | W. E. Lorensen and H. E. Cline, "Marching cubes", SIGGRAPH 1987; face-consistent disambiguation as required by G. M. Nielson and B. Hamann, "The asymptotic decider", IEEE Visualization 1991 |
| Tick spacing | P. S. Heckbert, "Nice numbers for graph labels", Graphics Gems, 1990 |
| Streamlines and quiver glyphs | Classical fourth-order Runge-Kutta (W. Kutta, 1901), as in E. Hairer, S. P. Norsett and G. Wanner, *Solving Ordinary Differential Equations I*, section II.1; trilinear interpolation of the gridded field |
| Series colours | M. Okabe and K. Ito, "Color Universal Design (CUD): how to make figures and presentations that are friendly to colorblind people", 2008 (the published palette values) |
| Date ticks | Calendar arithmetic in UTC from ECMAScript's `Date.UTC` (ECMA-262, section 21.4); log ticks at decades (Heckbert 1990's nice numbers in log space) |
| Histogram bins | D. Freedman and P. Diaconis, "On the histogram as a density estimator: L2 theory", Z. Wahrscheinlichkeitstheorie verw. Gebiete 57, 1981; H. A. Sturges, "The choice of a class interval", JASA 21(153), 1926 |
| Lasso selection (point in polygon) | M. Shimrat, "Algorithm 112: Position of point relative to polygon", CACM 5(8), 1962 (even-odd crossing rule) |
| PNG and SVG export | W3C SVG 1.1 (Second Edition) recommendation; the WHATWG HTML standard's canvas 2D context and OffscreenCanvas `convertToBlob` |
| Surface picking | Ray-height-field intersection by stepping and bisection on the bilinear surface (standard numerical root bracketing; W. H. Press et al., *Numerical Recipes*, 3rd ed., section 9.1) |
| cubehelix | D. A. Green, Bull. Astr. Soc. India 39, 289 (2011) |
| coolwarm | K. Moreland, "Diverging color maps for scientific visualization", ISVC 2009 |
| viridis, magma, inferno, plasma (recorded data, CC0) | N. Smith and S. van der Walt, mpl-colormaps, https://github.com/BIDS/colormap (the authors' table file `colormaps.py`; data only) |
| cividis (recorded data, CC BY 4.0) | J. R. Nuñez, C. R. Anderton and R. S. Renslow, PLOS ONE 13(7): e0199239 (2018), supporting file S2 |
| OKLab and the perceptual maps | B. Ottosson, "A perceptual color space for image processing" (2020); sRGB transfer from IEC 61966-2-1; CIELAB and D65 from CIE 15:2004 |

## Data track: the Python package (`python/`)

Written clean room; no source of ipywidgets' widget implementations, anywidget, ipyvolume or similar was read.

| Area | Source |
| --- | --- |
| Jupyter widget | The Jupyter widgets messaging protocol 2.1 (ipywidgets documentation) and the Jupyter messaging specification (comms); the JupyterLab extension guide (prebuilt extensions, shared modules); webpack's Module Federation documentation (the container's `init`/`get` interface) |
| PNG export (`Figure.to_png`) | RFC 6455 "The WebSocket Protocol" (opening handshake, framing, client masking); the Chrome DevTools Protocol documentation (`Target.attachToTarget` flat sessions, `SystemInfo.getProcessInfo`, `Emulation.setDeviceMetricsOverride`, `Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`, `Browser.close`; the `DevToolsActivePort` file) |
| Polars and xarray inputs | The Polars and xarray user guides (DataFrame and LazyFrame `select` and `collect`, `Series.to_numpy`; DataArray `dims`, `coords` and `attrs`) and the CF conventions (`long_name`, `units`) |

## Motion capture, VRML, X3D and G-code: `@margoengine/loaders`

File formats written from their public descriptions; no reader of another project was read.

| id | formula | file | source |
| --- | --- | --- | --- |
| LF1 | BVH HIERARCHY and MOTION; Euler channels multiplied in listed order | loaders/src/mocap.ts | Meredith and Maddock, "Motion Capture File Formats Explained", University of Sheffield, 2001 |
| LF2 | VRML97 grammar and nodes; Transform as T * C * R * SR * S * -SR * -C | loaders/src/vrml.ts | ISO/IEC 14772-1:1997 |
| LF3 | X3D XML encoding, DEF and USE attributes, containerField | loaders/src/vrml.ts | ISO/IEC 19776-1 |
| LF4 | G0, G1, G90, G91, M82, M83, G92, G20, G21, G28 | loaders/src/gcode.ts | RepRap wiki, "G-code" |
| LF5 | NRRD header fields, encodings, space directions and kinds | loaders/src/nrrd.ts | Teem project, "Definition of NRRD File Format" |
| LF6 | LDraw line types 0 to 5, sub-file matrices, colour 16 and 24 | loaders/src/ldraw.ts | LDraw.org, "LDraw File Format Specification" |
| LF7 | MPD packs, `0 FILE` and `0 NOFILE` | loaders/src/ldraw.ts | LDraw.org, "MPD Language Extension" |
| LF8 | BFC certification, winding and INVERTNEXT | loaders/src/ldraw.ts | LDraw.org, "Language Extension for Back Face Culling" |
| LF9 | `!COLOUR` lines and the classic colour values | loaders/src/ldraw.ts | LDraw.org, "Colour Definition Language Extension" and the published LDConfig.ldr values |
| LF10 | `texture2d`, `texture2dgroup`, `compositematerials`, `multiproperties` | loaders/src/threemf-materials.ts | 3MF Consortium, "Materials and Properties Extension" specification |
| LF11 | VTK XML layout, `DataArray` encodings, appended data and block headers | loaders/src/vtk-xml.ts | Kitware, "VTK File Formats" (VTK User's Guide) |
| LF12 | Cell type numbers and point order | loaders/src/vtk-xml.ts | Kitware, "VTK File Formats" cell diagrams |
| LF13 | LZ4 block decoding | loaders/src/vtk-xml.ts | "LZ4 Block Format Description" |
| LF14 | Unit system numbers, the object, layer and mesh tables a 3DM file exposes | loaders/src/3dm.ts | Robert McNeel & Associates, published rhino3dm API reference |
| LF15 | 3DS chunk ids and the mesh, face and material chunks | loaders/src/3ds.ts | Public 3DS file format descriptions, such as the Autodesk 3D Studio file format summary |
| LF16 | LWO2 and LWOB chunks, `VMAP` and `VMAD` | loaders/src/lwo.ts | NewTek, "LightWave Object File Format" (LWO2) public SDK document |
| LF17 | AMF elements, units and constellations | loaders/src/amf.ts | ISO/ASTM 52915, "Additive manufacturing file format" |
| LF18 | MD2 header, frame and triangle layout | loaders/src/md2.ts | Public Quake II MD2 format descriptions |
| LF19 | PDB ATOM, HETATM, CONECT and MODEL columns | loaders/src/pdb.ts | wwPDB, "Protein Data Bank Contents Guide", format version 3.3 |
| LF20 | Element colours and covalent radii | loaders/src/pdb.ts | Published CPK colour values; Cordero et al., "Covalent radii revisited", Dalton Trans. 2008 |
| LF21 | KML `Model`, `Location`, `Orientation` and `Scale`, and the KMZ layout | loaders/src/kmz.ts | OGC, "KML 2.3" standard |
| LF22 | B-spline basis functions, knot spans and rational evaluation | loaders/src/nurbs.ts | Piegl and Tiller, "The NURBS Book" (2nd ed., 1997), algorithms A2.1 to A2.3 and A4.1, written from the published mathematics |
| LF23 | Rational circle and sphere test shapes | loaders/tests/nurbs.test.js | Piegl and Tiller, "The NURBS Book", chapter 7 |
| LF24 | LAS public header, variable records and point formats 0 to 10 | points/src/las.ts, read through loaders/src/las.ts | ASPRS, "LAS Specification" 1.4 R15 and earlier versions |
| LF25 | The VDB tree: a root table over internal nodes over leaf blocks, active masks, tiles, background | loaders/src/vdb.ts | K. Museth, "VDB: High-Resolution Sparse Volumes with Dynamic Topology", ACM Transactions on Graphics 32(3), 2013 |
| LF26 | `.vdb` byte layout: header, metadata, grid descriptors, transforms, topology, value kinds | loaders/src/vdb.ts | No published specification exists. Written from the agent's general knowledge of the format, with no OpenVDB source open; not yet checked against a real file (known-bugs.md) |
| LF27 | Blosc chunk header, block offsets and byte shuffle | loaders/src/vdb.ts | The Blosc project's public chunk format description |
| LF29 | MaterialX elements, types, inheritance of `colorspace` and `fileprefix`, node inputs | loaders/src/materialx.ts | ASWF, "MaterialX Specification" 1.39. Written from the agent's general knowledge of it, with no MaterialX source open |
| LF30 | Input names and defaults of the four surface shaders | loaders/src/materialx.ts | Autodesk Standard Surface, the OpenPBR Surface specification, the MaterialX glTF PBR node description and the OpenUSD UsdPreviewSurface specification. Same basis as LF29; not compared line by line |
| LF32 | Lottie JSON: layers, transforms, shapes, keyframes, gradients, trim paths | loaders/src/lottie.ts | The Lottie Animation Community format description. Written from the agent's general knowledge of it, with no player source open |
| LF33 | Circle by four cubics, handle 4 (sqrt 2 - 1) / 3; de Casteljau subdivision | loaders/src/lottie.ts | Standard results of computer-aided geometric design |
| LF28 | LZ4 block format | loaders/src/vdb.ts, loaders/tests/vdb.test.js | Y. Collet, "LZ4 Block Format Description" |

## Voxel files: `@margoengine/voxel-edit/formats`

File layouts, written from each format's public description; no reader or writer of another project was read.

| id | formula | file | source |
| --- | --- | --- | --- |
| VF1 | Qubicle `.qb`: six u32 header fields, matrix name and size, z y x cell order, CODEFLAG 2 and NEXTSLICEFLAG 6 RLE | voxel-edit/src/formats.ts | Minddesk, "Qubicle Binary" file format description (Qubicle documentation) |
| VF2 | Qubicle Exchange `.qef`: text header, 0 to 1 colours, one `x y z index mask` line per voxel | voxel-edit/src/formats.ts | Minddesk, "Qubicle Exchange Format" description (Qubicle documentation) |
| VF3 | `binvox`: text header, then value and count byte pairs; x slowest, then z, y fastest | voxel-edit/src/formats.ts | Patrick Min, "binvox voxel file format specification" |
| VF4 | KVX: header, column offsets, slab records of top, length, cull and colours; 6 bit palette in the last 768 bytes | voxel-edit/src/formats.ts | Ken Silverman, the KVX description in the SLAB6 documentation |
| VF5 | VXL: columns of spans N, S, E, A with BGRA dwords for top and bottom colours; N of 0 ends a column | voxel-edit/src/formats.ts | Ken Silverman, the VXL format description in the Voxlap documentation |
| VF6 | over 255 colours: drop the same low bits of each channel until 255 remain, keeping the bucket's centre | voxel-edit/src/formats.ts | Margo-own: deterministic, plain bit truncation; median cut is in the `./voxelize` entry |

## Smooth voxel meshes: `@margoengine/voxel-edit/smooth`

Written from the paper below; no Surface Nets code of another project was read.

| id | formula | file | source |
| --- | --- | --- | --- |
| SN1 | one point per net cell the surface crosses, at the mean of its edge crossings; one quad per filled-to-air sample pair; relaxation toward neighbours kept inside the cell | voxel-edit/src/smooth.ts | Sarah Gibson, "Constrained Elastic Surface Nets", MERL TR-99-24 / MICCAI 1998 |
| SN2 | normals from the density difference across a net cell; a separable box blur by running sums | voxel-edit/src/smooth.ts | Margo-own, central differences and the standard running sum box filter |

## Mesh to voxels: `@margoengine/voxel-edit/voxelize`

Written from the papers below; no voxelizer of another project was read.

| id | formula | file | source |
| --- | --- | --- | --- |
| VZ1 | triangle against box by separating axes: three box normals, the triangle normal, nine edge crosses | voxel-edit/src/voxelize.ts | Tomas Akenine-Moller, "Fast 3D Triangle-Box Overlap Testing", Journal of Graphics Tools, 2001 |
| VZ2 | solid by crossing parity along x rows through cell centres, the hit point from barycentric coordinates | voxel-edit/src/voxelize.ts | Moller and Trumbore, "Fast, Minimum Storage Ray/Triangle Intersection", Journal of Graphics Tools, 1997 |
| VZ3 | shared edges on a ray: each edge read in one fixed vertex order and owning its low end, so a closed mesh crosses evenly | voxel-edit/src/voxelize.ts | Margo-own, the half-open crossing rule for point in polygon |
| VZ4 | palette: cut the box of widest channel range at its weighted median, then box means | voxel-edit/src/voxelize.ts | Paul Heckbert, "Color Image Quantization for Frame Buffer Display", SIGGRAPH 1982 |

## Rigging: `@margoengine/rigging`

Written clean room from the papers and specifications below. No source code of rigging tools or engines (Blender,
Maya, Pinocchio, libigl, three.js, Babylon, Godot, Unity, Unreal and the like) was read.

| Area | Source |
| --- | --- |
| Bone heat weights | I. Baran and J. Popović, "Automatic rigging and animation of 3D characters", ACM SIGGRAPH 2007 (the equilibrium (−Δ + H) w = H p, heat c / d² from the nearest visible bone, shared heat at equidistant bones) |
| Cotangent Laplacian and vertex areas | U. Pinkall and K. Polthier, "Computing discrete minimal surfaces and their conjugates", Experimental Mathematics 2(1), 1993; M. Meyer, M. Desbrun, P. Schröder and A. H. Barr, "Discrete differential-geometry operators for triangulated 2-manifolds", VisMath 2002 (published 2003) |
| Conjugate gradients, Jacobi preconditioning | M. R. Hestenes and E. Stiefel, J. Res. NBS 49(6), 1952; Y. Saad, "Iterative Methods for Sparse Linear Systems", 2nd ed., SIAM 2003, algorithm 9.1 |
| Skin data rules (checks) | The Khronos glTF 2.0 specification, section 3.7.3.3 (skinned mesh attributes: JOINTS_n / WEIGHTS_n, weights summing to 1, joint indices within the skin) |
| Brush falloff | The smoothstep polynomial 3t² − 2t³ (Hermite interpolation, standard numerical analysis) |
| IK chains (`rigging/ik`) | A. Aristidou and J. Lasenby, "FABRIK: a fast, iterative solver for the inverse kinematics problem", Graphical Models 73(5), 2011 (backward and forward reaching passes); the pole as a rotation of each inner joint about the line through its neighbours, which keeps both bone lengths (elementary geometry) |
| Elbow evaluator | The law of cosines for the two-bone triangle and Rodrigues' rotation formula (O. Rodrigues, 1840) about the shoulder-target line |
| Shortest-arc rotations, quaternion from a matrix | Quaternion algebra from W. R. Hamilton's definition; S. W. Shepperd, "Quaternion from rotation matrix", J. Guidance and Control 1(3), 1978 (through `@margoengine/math/quat`) |
| Root motion (`animator`) | Integration of a sampled track over an interval split into whole loop cycles and partial ones (elementary); the travel carried through the node hierarchy's local rotations and scales (glTF 2.0 section 3.5.3, transformations) |
| Look-at and aim (`animator`) | Shortest-arc turns of the look axis toward the target shared along a bone chain, a roll about the look axis taking the up axis's projection to world up's (vector rejection), and slerp (K. Shoemake, "Animating rotation with quaternion curves", SIGGRAPH 1985) for weights |
| Retarget presets (`rigging/retarget`) | Bone names from public documentation only: the VRM 1.0 humanoid bone list (VRM Consortium specification, `VRMC_vrm` humanoid), Godot's documented `SkeletonProfileHumanoid` bone names, Roblox's documented R15 body parts, and the bone names visible in Mixamo-exported files; rest-pose alignment is a shortest-arc turn per bone (quaternion algebra above), parents first |
| Spring bones (`rigging/springs`) | The VRMC_springBone 1.0 specification (VRM Consortium), its fields and its non-normative algorithm section; L. Verlet, "Computer experiments on classical fluids", Physical Review 159, 1967; the time-corrected step and the damped spring are elementary mechanics |
| VRM avatars (`rigging/vrm`) | The VRMC_vrm 1.0 and VRMC_springBone 1.0 specifications (VRM Consortium) and the glTF 2.0 binary container specification (Khronos); the two sample avatars are data, read and never studied for code |
| Voxel weights (`rigging/voxel-weights`) | O. Dionne and M. de Lasa, "Geodesic voxel binding for production character meshes", SCA 2013; the fill vote for open meshes is ours |
| Automatic rig (`rigging/autorig`) | I. Baran and J. Popović, "Automatic rigging and animation of 3D characters", ACM SIGGRAPH 2007 (the idea of finding a skeleton from the solid inside a mesh; their embedding is not used, the placement by paths and cuts is ours); D. Winter, "Biomechanics and Motor Control of Human Movement" (body segment lengths); voxel grid as in the row above |
| Corrective shapes (`rigging/correctives`) | J. P. Lewis, M. Cordner and N. Fong, "Pose space deformation", SIGGRAPH 2000, for the radial basis interpolation; the single-joint reading is plain rotation-vector projection |
| Weight transfer (`rigging/transfer`) | R. Abdrashitov, K. Raichstat, J. Monsen and D. Hill, "Robust skin weights transfer via weight inpainting", SIGGRAPH Asia 2023 Technical Communications, for matching by distance and normal; the fill is a plain weighted average, not its inpainting solve |
| Face tracking (`rigging/face`) | Apple's published `ARFaceAnchor.BlendShapeLocation` names, Google's MediaPipe Face Landmarker output format and the VRM 1.0 expression presets; no tracker's code was read |

## Game AI: `@margoengine/behavior`

Written clean room from the papers, talks and textbook descriptions below. No source code of behaviour-tree, utility-AI
or steering libraries or engines (Unreal, Unity, Godot, BehaviorTree.CPP, OpenSteer, three.js, Babylon, Yuka and the
like) was read.

| Area | Source |
| --- | --- |
| Behaviour trees (sequence, selector, parallel policies, decorators, reactive re-checks, halting) | M. Colledanchise and P. Ögren, "Behavior Trees in Robotics and AI: An Introduction", CRC Press 2018 (arXiv:1709.00084), chapters 1-3; D. Isla, "Handling complexity in the Halo 2 AI", GDC 2005 |
| Utility scoring, response curves, compensation factor | D. Mark, "Behavioral Mathematics for Game AI", Course Technology 2009; D. Mark and K. Dill, "Improving AI decision modeling through utility theory", GDC AI Summit 2010; "Building a better centaur: AI at massive scale", GDC 2015 (`score + (1 - score)(1 - 1/n) score`) |
| Steering (seek, flee, arrive, pursue, evade, wander, obstacle avoidance, path following, priorities) | C. W. Reynolds, "Steering Behaviors For Autonomous Characters", Game Developers Conference 1999 |
| Flocking (separation, alignment, cohesion) | C. W. Reynolds, "Flocks, herds and schools: a distributed behavioral model", ACM SIGGRAPH 1987 |
| Seeded random stream | `@margoengine/math`'s `createRandom` (mulberry32) |

## Game networking: `@margoengine/netcode`

Written clean room from the articles, talks and specifications below. No source code of networking libraries or
engines (Colyseus, Photon, Mirror, GGPO, Rapier, Unity Netcode, Unreal and the like) was read.

| Area | Source |
| --- | --- |
| Fixed timestep loop | G. Fiedler, "Fix Your Timestep!" (2004) |
| Snapshots, deltas against an acknowledged baseline, quantization | G. Fiedler, "Snapshot Compression" and "State Synchronization" (2015); the delta-against-acknowledged-snapshot idea as described in public talks on the Quake 3 network model |
| Client prediction, reconciliation, entity interpolation | G. Gambetta, "Fast-Paced Multiplayer" parts I to IV; Y. Bernier, "Latency Compensating Methods in Client/Server In-game Protocol Design and Optimization", GDC 2001 |
| Client running ahead by the one-way delay, input redundancy | T. Ford, "Overwatch Gameplay Architecture and Netcode", GDC 2017 |
| Clock synchronisation | F. Cristian, "Probabilistic clock synchronization", Distributed Computing 3(3), 1989 (the smallest round trip bounds the offset) |
| Rollback (input delay, prediction as the last input, save, load and resimulate, frame-advantage time sync, checksums) | T. Cannon, "Fight the Lag! The Trick Behind GGPO's Low-Latency Netcode", Game Developer magazine, September 2012; M. Stallone, "8 Frames in 16ms: Rollback Networking in Mortal Kombat and Injustice 2", GDC 2018 |
| Lag compensation (server-side rewind to the shooter's view) | Y. Bernier, GDC 2001 (above) |
| Ray against circle and sphere | The quadratic of \|o + s d - c\|² = r² (elementary geometry) |
| WebSocket server | RFC 6455, "The WebSocket Protocol" (handshake 4.2, framing 5.2, masking 5.3, fragmentation 5.4, control frames 5.5, close codes 7.4) |
| WebRTC data channels | W3C "WebRTC: Real-Time Communication in Browsers" (RTCDataChannelInit: ordered, maxRetransmits, negotiated, id) |
| Room API shape (`./rooms`) | Public documentation of the room-and-matchmaking API shape common to web game servers (lifecycle hook names, joinOrCreate and friends, state patches at a patch rate); the wire format, matchmaking and state sync are this package's own |
| Code generator (`./generate`) | This package's own wire format (packages/netcode/README.md, "Wire format") |
| Varints, zigzag | LEB128 as specified in DWARF 4 section 7.6; zigzag as described in the Protocol Buffers encoding documentation |
| Schema hash | FNV-1a 32-bit as published by G. Fowler, L. C. Noll and K.-P. Vo |

## 3D Tiles: `@margoengine/tiles`

Written clean room from the specifications and papers below. No source code of 3D Tiles runtimes or tools (CesiumJS,
3d-tiles-renderer, three-loader-3dtiles, loaders.gl, 3d-tiles-tools, py3dtiles, iTwin.js and the like) was read.

| Area | Source |
| --- | --- |
| Tileset JSON, refinement, geometric and screen-space error, bounding volumes, external tilesets, metadata | OGC 3D Tiles Specification 1.1 (OGC 22-025r4): "Tileset", "Tiles", "Bounding volumes", "Geometric error", "Refinement", "Metadata" |
| Implicit tiling, subtree files, Morton order | OGC 3D Tiles 1.1, "Implicit Tiling" (subtree binary format, availability bitstreams, template URIs, subdivision of boxes and regions) |
| b3dm, i3dm, pnts, cmpt, feature and batch tables | OGC 3D Tiles 1.1, "Tile formats" (the 1.0 formats 1.1 keeps) |
| y-up to z-up for glTF content | OGC 3D Tiles 1.1, "glTF transforms"; Khronos glTF 2.0, "Coordinate system and units" |
| WGS84, ECEF, east-north-up | NIMA TR8350.2 (WGS84 constants); B. R. Bowring, "Transformation from spatial to geographical coordinates", Survey Review 23 (181), 1976 |
| Octahedral normals (NORMAL_OCT16P, OCT32P) | Z. H. Cigolle, S. Donow, D. Evangelakos, M. Mara, M. McGuire and Q. Meyer, "A survey of efficient representations for independent unit vectors", JCGT 3(2), 2014 |
| Quaternion from a rotation matrix | S. W. Shepperd, "Quaternion from rotation matrix", J. Guidance and Control 1(3), 1978 |
| Oriented-box frustum and distance tests | Separating-axis projection of a box onto a plane normal (C. Ericson, "Real-Time Collision Detection", 2005, ch. 5) |

## Point clouds: LAS, octree and colours in `@margoengine/points`

Written clean room from the specifications and papers below. No source code of point-cloud libraries or viewers
(LAStools, LASzip, laz-perf, PDAL, libLAS, Potree, CloudCompare, Entwine and the like) was read.

| Area | Source |
| --- | --- |
| LAS reader and writer | ASPRS LAS Specification 1.2 (2008), 1.3 R11 (2010) and 1.4 R15 (2019): public header block, VLR and EVLR headers, point data record formats 0 to 10, extra bytes descriptors (LASF_Spec record 4), OGC WKT (LASF_Projection 2112) |
| GeoTIFF keys of the CRS | OGC GeoTIFF Standard 1.1 (19-008r4): GeoKeyDirectoryTag layout, ProjectedCSTypeGeoKey 3072, GeographicTypeGeoKey 2048, VerticalCSTypeGeoKey 4096 |
| ASPRS classes | ASPRS LAS 1.4 R15, table 17 (standard point classes) |
| Nested-sample octree | Grid subsampling per node as described in M. Schütz, "Potree: Rendering Large Point Clouds in Web Browsers", diploma thesis, TU Wien, 2016 (the idea only); budget-ordered node selection by projected size |
| Seeded shuffle | Fisher-Yates (Knuth, TAOCP vol. 2, algorithm P) with the mulberry32 generator |
| Polygon area | Newell's method for a polygon's normal (M. E. Newell, 1972, as in F. S. Hill, "Computer Graphics", 1990) |
| LAZ decoder (`/laz`) and the test-only encoder | M. Isenburg, "LASzip: lossless compression of LiDAR data", Photogrammetric Engineering and Remote Sensing 79(2), 2013 (item predictors, return contexts, GPS time sequences, integer corrector coding); the LAZ Specification 1.4 R1 from rapidlasso (record "laszip encoded" 22204, compressors, item ids and versions, chunk table, layered point14 chunks, wave packets); I. H. Witten, R. M. Neal and J. G. Cleary, "Arithmetic coding for data compression", CACM 30(6), 1987, and A. Said, "Introduction to arithmetic coding: theory and practice", HP Labs HPL-2004-76, 2004 (32-bit range coder, adaptive bit and symbol models) |

Verified against a real USGS file: yes (2026-10-27). `packages/points/tests/fixtures/USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz`
(public domain 3DEP tile, LAS 1.4, point format 6, written by LASzip 3.4.3, 54,634 points, two chunks) decodes to the point
count, the exact X/Y/Z minimum and maximum and the points-by-return array of the producer's header. It was also decoded
once by laspy 2.7.0 with lazrs 0.8.2 (installed in a throwaway virtual environment outside the repository and used only
through their public Python API as a black box; nothing from them is in the repository, package.json or the lock file).
Verified against laspy 2.7.0 / lazrs 0.8.2 on a real USGS file: all 54,634 points are field by field identical (raw
integer X, Y and Z, intensity, return number, number of returns, flag byte with scanner channel, classification, user
data, scan angle, point source id and the GPS time bit for bit; the 1,639,020 record bytes are equal). It exposed two errors that the
encoder-made files could not: in point14 the GPS time sequence model has 515 symbols (a new sequence is 511, the
switches 512 to 514), not the 516 of GPSTIME11 (LAZ specification 1.4, note 6 of the point14 item); and a multiplier 1
GPS point leaves the stored difference unchanged (the file is the authority; the specification text is silent). The
test encoder follows both readings.

Verified against real files in every point format: yes (2026-11-06). `packages/points/tests/laz-real.test.js` holds what
LASzip (through the `laszip` Python module) and lazrs 0.8.2 decode from public files of formats 0 to 3, 6, 7, 8 and 10,
and from real points LASzip itself compressed for formats 4, 5 and 9, as SHA-256 digests in
`packages/points/tests/fixtures/laz/records.json`. GPSTIME11, RGB12, RGB14, RGBNIR14, BYTE, BYTE14, WAVEPACKET13 and
WAVEPACKET14 are all covered, so the GPSTIME11 reading above is now checked on real files. Both decoders ran outside
the repository as black boxes through their public Python API; no source of LASzip, lazrs, laz-perf or laspy was read.
One rule came from that comparison and not from a text, because the specification is silent: the context passed to the
items after POINT14 is the new scanner channel only on a record where the channel changed, and 0 on every other record;
a record reads the last values of the record before it with the models of its own context, and a context first used in
a chunk takes a copy of those values. The test encoder follows this too. Item version 1, the coding of LASzip 1.0, is
refused: the LAZ specification calls it outdated and leaves it out, and the LASzip paper says it does not describe it.
Reading LASzip's source to get it is what this file rules out.
The LAZ specification PDF was read from downloads.rapidlasso.de (public format description, no code).

## Cutscenes: `@margoengine/cutscene`

Written clean room from the public descriptions below. No source code of sequencers or engines (Unity Timeline, Unreal
Sequencer, Godot AnimationPlayer, Theatre.js, GSAP, three.js, Babylon and the like) was read.

| Area | Source |
| --- | --- |
| Camera paths | E. Catmull and R. Rom, "A class of local interpolating splines", Computer Aided Geometric Design, 1974 (uniform Catmull-Rom segments) |
| Rotation keys | K. Shoemake, "Animating rotation with quaternion curves", ACM SIGGRAPH 1985 (slerp), through `@margoengine/math`'s `interpolateQuaternions` |
| Roll | Rodrigues' rotation formula (standard linear algebra) |
| Easing | `@margoengine/tween`'s easings (Penner's equations, CSS Easing Functions Level 1 cubic-bezier) |
| Instants and ordering | Our own design: half-open clip spans, instants sorted once by time, kind and document order |
| Virtual camera shots (`cutscene/shots`) | Our own design from the public idea of cutting between named cameras on a timeline; the view blend is spherical linear interpolation of a direction (K. Shoemake, 1985) with its length blended apart; custom track types are ours. No source of Unity Cinemachine or Unreal Sequencer was read |
| Render to video (`cutscene/render`) | Fixed-step rendering through `@margoengine/headless/video`; the sound track follows RFC 7845 (Ogg Opus, for `OpusHead`), RFC 9559 and the WebM guidelines, Encapsulation of Opus in ISO Base Media (opus-codec.org) and ISO/IEC 14496-1, 14496-3 and 14496-14 for `esds`; the mix is plain sums and straight-line resampling |

## Save and load: `@margoengine/save`

Written clean room from the specifications below. No source code of serializers, save systems or engines (Unity
prefabs and serialization, Godot scenes, Unreal SaveGame, three.js ObjectLoader, Babylon serializers, localForage,
idb and the like) was read.

| Area | Source |
| --- | --- |
| Overrides | RFC 7386, "JSON Merge Patch" (objects merge, null removes, other values replace) |
| Document format | ECMA-404 / RFC 8259 JSON; our own entity, reference (`{"$ref": id}`) and prefab layout |
| Compression | RFC 1952 gzip, through the WHATWG Compression Streams standard (`CompressionStream`, `DecompressionStream`) |
| Web Storage adapter | The HTML Standard, Web Storage (`getItem`, `setItem`, `removeItem`, `key`, `length`); RFC 4648 base64 |
| IndexedDB adapter | W3C Indexed Database API 3.0 (open and upgradeneeded, object stores, readonly and readwrite transactions, requests) |
| File adapter | Node.js `fs/promises` documentation (`writeFile` with `signal` and `flush`, `rename` replacing the target) |

## E57 reader and writer in `@margoengine/points/e57`

Written clean room from the standard below. No source code of E57 libraries (libE57, libE57Format, PDAL, pye57,
CloudCompare and the like) was read.

| Area | Source |
| --- | --- |
| File header, pages, XML section, data3D scans, prototype fields, compressed vectors, bitPack bytestreams | ASTM E2807-11, "Standard Specification for 3D Imaging Data Exchange, Version 1.0" |
| Page checksum | CRC-32C: G. Castagnoli, S. Bräuer and M. Herrmann, "Optimization of cyclic redundancy-check codes with 24 and 32 parity bits", IEEE Trans. Communications 41(6), 1993 (reflected polynomial 0x82F63B78) |
| XML subset | W3C XML 1.0 (elements, attributes, character references, CDATA, comments) |
| Pose rotation | Rotation matrix of a unit quaternion (Hamilton's quaternion algebra) |

## Audio mixing and effects: `@margoengine/mixer`

Written clean room from the specifications below. No source code of audio engines, mixers or effect libraries (Tone.js,
Howler, Web Audio API implementations in browsers, FMOD, Wwise, JUCE and the like) was read.

| Area | Source |
| --- | --- |
| Web Audio graph, parameters and timing | W3C Web Audio API specification (AudioContext and OfflineAudioContext, AudioParam automation, GainNode, DelayNode, ConvolverNode, PannerNode, AnalyserNode, DynamicsCompressorNode) |
| Biquad filters | The BiquadFilterNode section of the Web Audio API specification, which states the public RBJ "Audio EQ Cookbook" formulas |
| Compressor curve | Giannoulis, Massberg and Reiss, "Digital Dynamic Range Compressor Design: A Tutorial and Analysis", JAES 60(6), 2012 (static soft-knee curve) |
| Reverb impulse | Exponentially decaying white noise at an RT60 (the definition of reverberation time); mulberry32 pseudo-random generator (public domain) |
| Loop delay | The Web Audio API specification's rules for cycles in the graph (a loop needs a DelayNode and costs one render quantum of 128 frames) |
| Mute, solo and sends | Common mixing-desk behaviour (solo-in-place, solo-safe returns, pre and post fader sends); our own tree rule in `audibleBuses` |

## WebGL2 compatibility layer: `@margoengine/webgl2-compat`

Written clean room from the specifications below. No source code of shader translators or WebGPU-on-WebGL layers
(Tint, Naga, SPIRV-Cross, ANGLE's translator, Dawn, wgpu, three.js and the like) was read.

| Area | Source |
| --- | --- |
| Capability probe and tiers | Khronos WebGL 2.0 specification (`getExtension`, `getParameter`, `getShaderPrecisionFormat`) and the WebGL extension registry entries named in the package; OpenGL ES 3.0 and GLSL ES 3.00 specifications (precision qualifiers) |
| WGSL corpus recorder | W3C WebGPU specification (`GPUDevice` methods, `getCompilationInfo`) |
| WGSL front end (`/wgsl`: lexer, parser, type checker, constant folding, IR) | W3C WGSL specification (textual structure and template-list discovery, grammar, types and memory layout, expressions, statements and behaviors, built-in functions, entry-point interfaces); IEEE 754 for f32 and f16 rounding; mulberry32 (public domain) in the fuzz tests |
| GLSL back end (`/glsl`: WGSL IR to GLSL ES 3.00, helpers for integer division, remainder, shifts, conversions, bit and pack built-ins, uniform reads in WGSL layout, combined samplers) | W3C WGSL specification (expressions, statements, built-in functions and their defined results, memory layout, entry-point interfaces); Khronos GLSL ES 3.00 specification (types, qualifiers, std140 layout, built-in functions, texture lookups, precision) |
| Device (`/device`: GPU, adapter, device, queue, buffers, textures, samplers, bind groups, render pipelines, command encoding and replay, canvas context, install) | W3C WebGPU specification (object model, limits and features, texture formats, render pass load and store, error scopes, device loss, canvas configuration); Khronos WebGL 2.0 and OpenGL ES 3.0 specifications (buffers, textures, samplers, framebuffers, blit, draw calls, sync objects, pixel transfers); WebGL extension registry (EXT_clip_control, WEBGL_provoking_vertex, OES_draw_buffers_indexed, KHR_parallel_shader_compile, EXT_texture_filter_anisotropic, EXT_depth_clamp, EXT_color_buffer_float) |

## Weather states and hail: `@margoengine/weather`

Written clean room from the specifications and papers below. No source code of weather systems or particle libraries
(Unreal weather and Niagara systems, Unity weather assets, three.js and Babylon particle systems, game weather plugins
and the like) was read. The code of `@margoengine/sky/weather` in this repository was the starting layout for the hail pass.

| Area | Source |
| --- | --- |
| Wind noise | Smooth value noise: lattice values from the PCG output hash (O Neill, "PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation", 2014) blended with the quintic fade of Perlin, "Improving Noise", SIGGRAPH 2002; our own gust, direction and turbulence layout |
| Random walk | A weighted Markov chain over named presets; mulberry32 pseudo-random generator (public domain) |
| Blending | Smoothstep (the OpenGL and WGSL `smoothstep` definition); shortest-arc angle interpolation |
| Hail path | Constant fall speed (terminal velocity under drag, a design choice) and two ballistic bounces: `y = v t - g t^2 / 2` with a coefficient of restitution on the vertical speed |
| Wet and snowy surfaces | Our own design: roughness and albedo scales for wet surfaces (wet surfaces look darker and shinier) and a slope threshold for snow |
| Ground wetness and snow cover | First-order exponential approach to a target, with separate rise and fall time constants |

## Biome maps: `@margoengine/biomes`

Written clean room from the papers and books below (design spec: item 27.4). No source code of other engines, terrain
or biome tools (Unreal PCG and its Biome Core plugin, Unity terrain and its store assets, Godot add-ons, World Creator,
Gaea, World Machine, Houdini and the like) was read; facts about them come only from their public documentation.

| Area | Source |
| --- | --- |
| Fixed-point library | Exact 64-bit products from 16-bit limbs and integer division with a correction step (textbook integer arithmetic); binary logarithm by repeated squaring of the mantissa (the textbook digit-by-digit method) |
| Trigonometry | Volder, "The CORDIC trigonometric computing technique", IRE Transactions on Electronic Computers, 1959 (vectoring and rotation modes, gain constant) |
| Hashes | Jarzynski and Olano, "Hash functions for GPU rendering", Journal of Computer Graphics Techniques, 2020 (PCG output hash, nested hashing for several inputs) |
| Value noise | Lattice values from those hashes, blended with the quintic fade of Perlin, "Improving Noise", SIGGRAPH 2002; fractal sums and ridged noise in our own integer layout |
| Multi-noise classifier (`/multinoise`) | Our own design: nearest prototype by weighted squared Euclidean distance to a point or box (textbook nearest-prototype rule) on axes normalised to Q16, blended with the Wendland kernel above; the technique name is generic and no other tool's source or data was read |
| Blend kernel | Wendland, "Piecewise polynomial, positive definite and compactly supported radial functions of minimal degree", Advances in Computational Mathematics, 1995 (C2 kernel `(1 - r)^4 (4r + 1)`) |
| Procedural relief and R16 | Our own design: fractal lowlands, ridged mountains under a mask, a smoothstep coast shelf, river valleys carved around polylines |
| Height interpolation | Keys, "Cubic convolution interpolation for digital image processing", IEEE Transactions on Acoustics, Speech and Signal Processing, 1981 (Catmull-Rom weights, a = -0.5) in Q16; linear extension past the edges |
| Arc cosine | Hastings' polynomial, Abramowitz and Stegun, "Handbook of Mathematical Functions", 1964, formula 4.4.45 and 4.4.46 |
| Slope, aspect, curvature, position | Horn, "Hill shading and the reflectance map", Proceedings of the IEEE, 1981 (3x3 gradient); Zevenbergen and Thorne, "Quantitative analysis of land surface topography", Earth Surface Processes and Landforms, 1987 (general, profile and plan curvature); Guisan, Weiss and Weiss 1999 (topographic position index) |
| Depression filling | Barnes, Lehman and Mulla, "Priority-flood: an optimal depression-filling and watershed-labeling algorithm for digital elevation models", Computers and Geosciences, 2014 (min-heap of outlets, ties by index) |
| Distance to water | Meijster, Roerdink and Hesselink, "A general algorithm for computing distance transforms in linear time", 2000 (exact squared Euclidean distance, two separable passes) |
| Wind exposure | Winstral, Elder and Davis, "Spatial snow modeling of wind-redistributed snow using terrain-based parameters", Journal of Hydrometeorology, 2002 (Sx, largest upwind slope angle within 300 m) |
| Orographic rain | Roe, "Orographic precipitation", Annual Review of Earth and Planetary Sciences, 2005 and Roe and Baker 2006 (upslope condensation, downwind drift of the condensate, evaporation on descent); Smith and Barstad, Journal of the Atmospheric Sciences, 2004 (the linear theory this approximates); our own integer march along the wind, lee floor and recovery fetch |
| Temperature | Minder, Mote and Lundquist, Journal of Geophysical Research, 2010 (surface lapse rates below 6.5 K/km, steeper by day than by night); the mean annual latitude profile is our own fit, `|sin lat|^3`, to observed zonal means as plotted in Hartmann, "Global Physical Climatology", 2016; heat load folded about the north-east to south-west axis after McCune and Keon, Journal of Vegetation Science, 2002 |
| Seasons and growing season | Seasonal swing of about 12 sin(latitude) K over the sea growing with continentality (Gorczynski and Conrad continentality indices); degree days of a sinusoidal year, the standard closed-form integral; Korner and Paulsen, Journal of Biogeography, 2004, and Korner, "Alpine Treelines", 2012 (6.4 C growing-season mean, at least 94 days above 0.9 C) |
| Season states (`/seasons`) | McMaster and Wilhelm, "Growing degree-days: one equation, two interpretations", Agricultural and Forest Meteorology, 1997 (degree days as the integral above a base), here clipped to part of the sinusoidal year in closed form; Hock, "Temperature index melt modelling in mountain areas", Journal of Hydrology, 2003 (snow melt from thaw degree days, 3 mm per C day chosen inside its 2.5 to 6 range); green-up full at 200 C day, senescence as the share of cooling between the warmest day and the autumn crossing, and the colour curve are our own design |
| Cold-air pools | Our own engineering form (labelled as such): night cooling `coldAir (1 - exp(-d / 30 m))` with d the Priority-Flood fill depth plus half the depth below the local mean, reduced on wind-exposed ground |
| Evapotranspiration and moisture index | Allen, Pereira, Raes and Smith, FAO Irrigation and Drainage Paper 56, 1998, chapter 3 (Hargreaves, extraterrestrial radiation from latitude and day); Fu's form of the Budyko curve with w = 2.6 (Fu 1981; Zhang et al. 2004) for AET / PET |
| Soil depth | Heimsath, Dietrich, Nishiizumi and Finkel, Nature, 1997 (exponential soil production) and Pelletier and Rasmussen, Water Resources Research, 2009 (depth from the log of convexity, deep in hollows); convexity measured on the 49 m position box, not per 1 m cell |
| Biome classification | Wendland 1995 kernels of the signed distance to each envelope bound (our blend-band layout); ecotone warp by integer value noise and a 3x3 box blur (our design); nearest-envelope fallback in normalised distance (the nearest-interval idea of public block-world generation write-ups, written fresh); largest-remainder rounding to 255 |
| Whittaker classes | Whittaker, "Communities and Ecosystems", 2nd edition, 1975 (the temperature and rainfall diagram); the rectangles in `WHITTAKER` are our own approximation of its regions |
| Holdridge life zones | Holdridge, "Determination of world plant formations from simple climatic data", Science, 1947, and "Life Zone Ecology", 1967: belts at biotemperatures 1.5, 3, 6, 12 and 24 C, rainfall doubling from 62.5 mm, PET ratio 58.93 x biotemperature / rainfall; nearest hexagon centre in the log lattice (our computational form) |
| Preset limits | Plant functional type screening by coldest month, GDD5 and a drought index after Prentice et al., Journal of Biogeography, 1992 (BIOME1) and Kaplan et al., Journal of Geophysical Research, 2003 (BIOME4); the per-preset numbers are our own, rounded from those background values |
| Koppen labels | Beck et al., "Present and future Koppen-Geiger climate classification maps at 1-km resolution", Scientific Data, 2018, after Peel, Finlayson and McMahon 2007 (the 30-class rules); months from our sinusoidal year and rain-season regimes |
| Terrain view and ground weights | Our own design: ground layer rules as Wendland bands like the envelopes, biome weights shared among ground layers and rounded to 255 by largest remainder, generated material textures from value noise with box-filtered mips; drawn through the terrain package's optional weights textures |
| Editor | Our own design: integer brush dabs (quintic, linear or hard falloff) on user rasters, edits kept as plain data for exact replay, undo and redo by raster snapshots; the dirty margin rule (rounds x 2 x the largest radius plus the cluster spread) from our research notes of 2026-10-28 |
| Placement candidates and thinning | Lane and Prusinkiewicz, "Generating spatial distributions for multilevel models of plant communities", Graphics Interface, 2002 (layers placed in size order, each thinned by suitability and the layers above); thinning against each candidate's own hashed number, our layout |
| Clusters | Thomas, "A generalization of Poisson's binomial limit for use in ecology", Biometrika, 1949 (Gaussian offspring); Matern, "Spatial Variation", 1960 (discs); Clark, Silman, Kern, Macklin and HilleRisLambers, "Seed dispersal near and far", Ecology, 1999 (the 2Dt kernel); the shot-noise Cox form and its equality with Neyman-Scott processes of Poisson offspring as in Illian, Penttinen, Stoyan and Stoyan, "Statistical Analysis and Modelling of Spatial Point Patterns", Wiley, 2008 |
| Hard core | Luby, "A simple parallel algorithm for the maximal independent set problem", SIAM Journal on Computing, 1986; Blelloch, Fineman and Shun, "Greedy sequential maximal independent set and matching are parallel on average", SPAA, 2012 (rounds with fixed priorities settle to the greedy set); evaluated lazily per candidate and round, our design |
| Sizes and crowns | de Liocourt, 1898 (reverse-J diameters); Bailey and Dell, Forest Science, 1973 (Weibull); Richards, Journal of Experimental Botany, 1959 (Chapman-Richards height); West, Brown and Enquist, Nature, 1999 (crowns as a power of stem size, exponent 0.75 here); the room rule after Reineke, Journal of Agricultural Research, 1933 (stand density from space filling) with the random sequential adsorption jamming cover 0.547 (Feder, Journal of Theoretical Biology, 1980) |
| Canopy layers | Purves, Lichstein, Strigul and Pacala, "Predicting and understanding forest dynamics using a simple tractable model", PNAS, 2008, and Strigul et al., Ecological Monographs, 2008 (the perfect plasticity approximation); the size-asymmetric light share after Weiner, "Asymmetric competition in plant populations", Trends in Ecology and Evolution, 1990; the 60 % closure is the lower bound of a closed tree canopy (crowns interlocking, generally 60 to 100 % crown cover; open canopy 25 to 60 %) in the Federal Geographic Data Committee's Vegetation Classification Standard, FGDC-STD-005, June 1997 (glossary), and matches the 0.6 to 0.65 cover our densest stands reach under the hard core and room rule; the mortality curve is our calibration |
| Workers and streaming | Our own design (B7): worker replicas made from the same options and changed by the same calls in order (so their integer output is the page's), per-worker priority queues that never reorder across a change, tile affinity by 4 x 4 blocks, prefetch along the camera's smoothed velocity, a per-frame copy budget; stored records in pages of 64 from a free list. Web Workers, transferable ArrayBuffers and AbortSignal as the HTML and DOM standards describe them |
| Edges | Murcia, "Edge effects in fragmented forests", Trends in Ecology and Evolution, 1995; Harper et al., "Edge influence on forest structure and composition in fragmented landscapes", Conservation Biology, 2005 (denser, taller shrubs and smaller trees at edges); the factors are ours |
| Point-pattern statistics | Diggle, "Statistical Analysis of Spatial and Spatio-Temporal Point Patterns", 3rd edition, CRC, 2013 and Illian et al. 2008 (K, L, g, G, F, J and edge corrections); Myllymaki, Mrkvicka, Grabarnik, Seijo and Hahn, "Global envelope tests for spatial processes", JRSS B, 2017; Marsaglia and Marsaglia, "Evaluating the Anderson-Darling distribution", Journal of Statistical Software, 2004; Koenker and Bassett, "Regression quantiles", Econometrica, 1978 |
| Erosion (`/erosion`) | Musgrave, Kolb and Mace, "The synthesis and rendering of eroded fractal terrains", SIGGRAPH 1989 (thermal erosion by an angle of repose); Howard, "A detachment-limited model of drainage basin evolution", Water Resources Research, 1994, and Whipple and Tucker, Journal of Geophysical Research, 1999 (stream power incision); Davy and Lague, "Fluvial erosion/transport equation of landscape evolution models revisited", Journal of Geophysical Research, 2009 (transport capacity, erosion toward it and deposition of the excess); drainage in Priority-Flood order after Barnes, Lehman and Mulla 2014. Our own integer layout: Q16 rates, fixed rounds, an in-place thermal pass in alternating order, lakes filled with sediment, cuts never below the downstream cell. No erosion code of any tool or engine (Gaea, World Machine, World Creator, mapgen4 and the like) was read |
| Roads and paths (`/splines`) | The uniform cubic Catmull-Rom and B-spline bases as in Catmull and Rom, "A class of local interpolating splines", in Barnhill and Riesenfeld (eds.), "Computer Aided Geometric Design", Academic Press, 1974, and textbook spline references (polynomial coefficients of the four control points, evaluated by Horner's rule); point-to-segment distance by projection onto the segment (textbook geometry). Our own integer layout: a fixed number of samples per span, Q16 parameters with floors, a bucket grid of segment reach boxes, beds averaged over the line, weights combined by largest weight then lowest bed. No road or spline tool code (Unreal, Unity, Gaea, World Machine, World Creator and the like) was read |
| Self-thinning bands | Long et al., 2024, and Weller, Ecological Monographs, 1987 (published size-density frontier slopes of about -1.4 to -2.3 by species and site; no universal -3/2) |

## Ragdolls: `@margoengine/ragdoll`

Written clean room from the public descriptions below. No source code of ragdoll systems or engines (Unity, Unreal,
Godot, PhysX, Havok, Jolt, Bullet, three.js, Babylon and the like) was read. Rapier is the physics library underneath;
only its published API (`setBodyType`, the joint frames of `ImpulseJoint`) is used.

| Area | Source |
| --- | --- |
| Swing and twist limits | The swing-twist decomposition of a rotation about an axis (standard quaternion algebra: the twist is the rotation's projection onto the axis, the swing the remainder) |
| Limit impulses | E. Catto, "Iterative Dynamics with Temporal Coherence", GDC 2005 (velocity constraints solved with impulses through the bodies' inverse inertia), applied as an inelastic stop |
| Limit projection | T. Jakobsen, "Advanced Character Physics", GDC 2001 (projecting a violated constraint back by moving the body), here a turn of the child about its joint |
| Capsule inertia | Solid cylinder moments of inertia (standard mechanics tables) |
| Bodies from bones and blending back | Our own design: one capsule per bone in the bone's world frame, joints at the bone origins, kinematic hit boxes that follow the animation, and a per-bone slerp from the frozen physics pose to the animated pose |
| Powered ragdolls (`ragdoll/powered`) | Rapier's published joint motor API; J. Tan, K. Liu, G. Turk, "Stable Proportional-Derivative Controllers", IEEE CG&A 2011, for the implicit spring on the root bone; feeding a target's velocity to a PD controller is textbook control. Raising the mass and inertia of small bodies in a chain is our own measure on real rigs |
| Getting up (`ragdoll/getup`) | Our own design from the public description of the technique (choose a clip by how the body lies, align the character to the body, blend from the ragdoll's pose); turn extraction is the swing-twist decomposition above |
| Body shapes from the skin (`ragdoll/hulls`) | Reuses `rigging/hulls`, which is quickhull as already cited; the box is a plain search over turns about the bone, of our own design |
| Saved profiles (`ragdoll/profile`) | Our own format. Mass shares from P. de Leva, J. Biomechanics 1996; segment lengths from Drillis and Contini, 1966; joint ranges from common published ranges of motion |
| Balance (`ragdoll/balance`) | Capture point from J. Pratt et al., Humanoids 2006; foot placement in the manner of SIMBICON, K. Yin, K. Loken, M. van de Panne, SIGGRAPH 2007; leg angles by the law of cosines |
| Kinematics swept collision (`kinematics-constraints/swept`) | Conservative advancement from B. Mirtich, PhD thesis, UC Berkeley, 1996; per-link motion bound from F. Schwarzer, M. Saha, J.-C. Latombe, WAFR 2002; quaternion from a matrix from K. Shoemake, SIGGRAPH 1985. No robotics library's source was read |
| Kinematics concave obstacles (`kinematics-constraints/sdf`) | Lipschitz pruning from J. C. Hart, The Visual Computer 12(10), 1996; distances from the repository's own `bvh` and GJK. No other engine's source was read |
| Custom ease curves (`tween/custom-ease`) | Monotone cubic from F. N. Fritsch and R. E. Carlson, SIAM J. Numer. Anal. 17(2), 1980; stroke thinning from U. Ramer, 1972, and D. Douglas and T. Peucker, 1973; the JSON shape is Margo's own. |
| Springs by duration and bounce (`tween` `springOptions`) | The damped oscillator from any mechanics text; `duration` and `bounce` as Apple's public SwiftUI documentation describes them. |

## 2D sprites: `@margoengine/sprites`

Written from the WebGPU and WGSL specifications only (instanced triangle strips, `textureLoad`, straight-alpha blending).
No other engine's sprite code was read. Snapping rounds an image's corner after the camera, so half-pixel pivots still
cover whole pixels; the tests compare every frame byte for byte with an image composed on the CPU in the test itself.

## Pixel camera and layer compositor: `@margoengine/pixel`

Written from the WebGPU and WGSL specifications only (`textureLoad`, `@builtin(position)`, blend factors, dynamic uniform
offsets) and plain rotation maths. No other engine's pixel-art code was read. Each output pixel turns back into the
layer and floors to one source pixel; the tests compare every frame byte for byte with an image composed on the CPU in
the test itself, with quarter turns done by moving pixels forward rather than by the shader's formula.

## Rendering without a page: `@margoengine/headless`

Written from the WebGPU specification (GPUCanvasContext, the 256-byte `copyTextureToBuffer` row alignment, the flag values
of `GPUBufferUsage` and its siblings) and the W3C PNG specification. No other project's headless code or binding source
was read. The real-GPU test compares the bytes with a screenshot of the same scene on a page canvas.
