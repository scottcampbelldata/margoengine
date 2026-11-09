// Explicit, format-aware aliases. They prove runnable API examples, not the fictional asset's identity.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { requiredFixture } from './required-fixture.mjs';
import { readmeCache } from '../fetch-readme-assets.mjs';

const decoder = 'packages/decoders/tests/fixtures/';
export const README_FILES = {
  '/albedo.ktx2': decoder + 'ktx2-gpu/alpha-etc1s.ktx2',
  '/texture.ktx2': decoder + 'ktx2-gpu/alpha-uastc-zstd.ktx2',
  '/rock.ktx2': decoder + 'ktx2-gpu/alpha-uastc-zstd.ktx2',
  '/environment.ktx2': decoder + 'ktx2-hdr/odd-uastc-hdr.ktx2',
  '/sky.ktx2': decoder + 'ktx2-layers/cube-uastc-zstd.ktx2',
  '/terrain.ktx2': decoder + 'ktx2-layers/array-uastc.ktx2',
  '/texture.jxl': decoder + 'jxl/alpha_triangles.jxl',
  '/texture.pvr': decoder + 'pvr/test_image_pvrtc4bpp_v3.pvr',
  '/points.drc': decoder + 'draco-points/pc_color.drc',
  '/image.tga': 'examples/assets/texture-formats/checker.tga',
  '/image.tiff': 'examples/assets/texture-formats/checker-lzw.tif',
  '/texture.dds': 'examples/assets/texture-formats/checker-rgba.dds',
  '/studio.exr': 'packages/environment/tests/fixtures/BrightRings.exr',
  '/parts/bracket.3mf': 'packages/loaders/tests/fixtures/gears.3mf',
  '/scans/part.ply': 'packages/loaders/tests/fixtures/torus_colored.ply',
  '/fonts/Inter.ttf': 'packages/text/tests/fixtures/fonts/SourceSans3-Regular.ttf',
  '/scans/site.las': 'packages/points/tests/fixtures/laz/point-time-color.las',
  '/scans/site.laz': 'packages/points/tests/fixtures/laz/point-time-color.laz',
  '/surveys/quarry.laz': 'packages/points/tests/fixtures/laz/point-time-color.laz',
  '/scan.copc.laz': 'packages/points/tests/fixtures/laz/simple.copc.laz',
  '/assets/shot.fbx': 'packages/fbx/test/fixtures/blender-shot.fbx',
  '/assets/room.fbx': 'packages/fbx/test/fixtures/blender-layers.fbx',
  '/assets/character.fbx': 'packages/fbx/test/fixtures/blender-rig.fbx',
  '/assets/maya-rig.fbx': 'packages/fbx/test/fixtures/real/maya_mixed_inherit_mode_7700_ascii.fbx',
  '/assets/take.fbx': 'packages/fbx/test/fixtures/real/maya_anim_layers_7500_ascii.fbx',
  '/assets/crate.fbx': 'packages/fbx/test/fixtures/real/max_pbr_metal_rough_material_7700_ascii.fbx',
  '/assets/route.fbx': 'packages/fbx/test/fixtures/real/max_nurbs_curve_rational_7500_binary.fbx',
  '/assets/hero.fbx': 'packages/fbx/test/fixtures/real/maya_dq_weights_7500_binary.fbx',
};
export const README_DOWNLOADS = {
  '/models/teapot.3ds': '3ds-nasa/Shuttle Carrier - SLIC.3ds',
  '/models/ship.lwo': 'lwo-nasa/TOPEX-Poseidon.lwo',
  '/prints/bracket.amf': 'amf-rook/Rook.amf',
  '/models/knight.md2': 'md2-dolphin/dolphin.md2',
  '/models/tank.md2': 'md2-dolphin/dolphin.md2',
  '/molecules/1crn.pdb': 'pdb-crambin/1CRN.pdb',
  '/maps/tower.kmz': 'kmz-macky/MackyBldg.kmz',
  '/motion/logo.json': 'lottie-twitterheart/TwitterHeart.json',
  '/sims/smoke.vdb': 'smoke.vdb',
  '/parts/bracket.stl': 'stl-binary-3dsmax/3DSMaxExport.STL',
  '/logo.svg': 'svg-inkscape/Example.svg',
  '/prints/lithophane.3mf': '3mf-textures/multipletextures.3mf',
  '/text.txt': 'dae-maya-skin/library_controllers_skin.dae',
  '/map.tmx': 'tmx-objects/sandbox.tmx',
  '/objs.tsx': 'tmx-objects/objs.tsx',
  '/models/crate.obj': 'obj-mtl-doorman/doorman.obj',
  '/models/doorman.mtl': 'obj-mtl-doorman/doorman.mtl',
  '/crate.mtl': 'obj-mtl-doorman/doorman.mtl',
  '/scans/fullwave.laz': 'laz-format10/fullwave.laz',
  '/scans/fullwave.wdp': 'laz-format10/fullwave.wdp',
};
for (const { file } of JSON.parse(readFileSync(new URL('./readme-companions.json', import.meta.url), 'utf8'))) {
  README_DOWNLOADS[`/models/${file}`] = `obj-mtl-doorman/${file}`;
}

/** A selected required alias fails on absence/LFS; it never falls through to unrelated bytes or HTML. */
export function readmeFixture(pathname, base = resolve(import.meta.dirname, '../..'), cache = readmeCache()) {
  const tracked = README_FILES[pathname],
    downloaded = README_DOWNLOADS[pathname];
  if (!tracked && !downloaded) return undefined;
  const path = tracked ? resolve(base, tracked) : resolve(cache, downloaded);
  requiredFixture(
    path,
    tracked
      ? `git lfs pull; restore ${tracked} or run its documented fixture fetch command`
      : 'node scripts/fetch-readme-assets.mjs',
  );
  return { path };
}

/** Single byte range, including open and suffix ranges. Null means HTTP 416. */
export function sampleRange(range, size) {
  if (!range) return undefined;
  const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!parts || (!parts[1] && !parts[2]) || size === 0) return null;
  const suffix = parts[1] === '';
  const start = suffix ? Math.max(0, size - Number(parts[2])) : Number(parts[1]);
  const end = suffix || parts[2] === '' ? size - 1 : Math.min(size - 1, Number(parts[2]));
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size &&
    (!suffix || Number(parts[2]) > 0)
    ? { start, end }
    : null;
}

/** Serve the real file, preserving Range semantics for streaming texture and point-cloud readers. */
export function serveSample(request, response, path) {
  const size = statSync(path).size,
    range = sampleRange(request.headers.range, size);
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('content-type', 'application/octet-stream');
  if (range === null) {
    response.statusCode = 416;
    response.setHeader('content-range', `bytes */${size}`);
    return response.end();
  }
  response.statusCode = range ? 206 : 200;
  response.setHeader('content-length', range ? range.end - range.start + 1 : size);
  if (range) response.setHeader('content-range', `bytes ${range.start}-${range.end}/${size}`);
  if (request.method === 'HEAD') return response.end();
  return createReadStream(path, range ?? {}).pipe(response);
}
