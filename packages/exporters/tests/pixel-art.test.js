// Pixel-art sampling: the scene option and the per-texture helper write nearest filters and the chosen mip policy in
// glTF (NEAREST or NEAREST_MIPMAP_NEAREST), COLLADA and exportModel; Godot's glTF import maps those samplers to
// TEXTURE_FILTER_NEAREST and NEAREST_WITH_MIPMAPS (measured with Godot 4.7.2, see the exporters README).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { exportDAE, exportGLB, exportGLTF, paletteTexture, pixelArtTexture } from '../dist/index.js';
import { exportModel } from '../dist/model.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { findPython } from '../../../scripts/support/find-python.mjs';
import { readGLB } from './helpers.js';

const quad = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
async function scene() {
  const { texture } = await paletteTexture([255, 0, 0, 255, 0, 0, 255, 255]);
  // A linear, mipmapped, repeating texture: what pixel-art sampling has to override.
  const smooth = {
    ...texture,
    magFilter: 'linear',
    minFilter: 'linear',
    mipmaps: true,
    wrapS: 'repeat',
    wrapT: 'mirror',
  };
  return { nodes: [{ geometry: quad, material: { baseColorTexture: smooth } }] };
}

test('glTF pixelArt: nearest filters with no mips, nearest mips, and an optional wrap', async () => {
  const s = await scene();
  assert.deepEqual(exportGLTF(s).json.samplers, [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 33648 }]);
  assert.deepEqual(exportGLTF(s, { pixelArt: true }).json.samplers, [
    { magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 33648 },
  ]);
  assert.deepEqual(exportGLTF(s, { pixelArt: { mipmaps: 'nearest', wrap: 'clamp' } }).json.samplers, [
    { magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 },
  ]);
  assert.deepEqual(
    readGLB(exportGLB(s, { pixelArt: true })).json.samplers,
    exportGLTF(s, { pixelArt: true }).json.samplers,
  );
  assert.deepEqual(exportGLTF(s, { pixelArt: false }).json.samplers, exportGLTF(s).json.samplers);
});

test('pixelArtTexture sets one texture and leaves the image shared', async () => {
  const s = await scene(),
    smooth = s.nodes[0].material.baseColorTexture,
    pixel = pixelArtTexture(smooth, { mipmaps: 'nearest' });
  assert.equal(pixel.image, smooth.image);
  assert.deepEqual(
    [pixel.magFilter, pixel.minFilter, pixel.mipmaps, pixel.wrapS],
    ['nearest', 'nearest', true, 'repeat'],
  );
  assert.equal(pixelArtTexture(smooth).mipmaps, false);
  s.nodes[0].material.baseColorTexture = pixelArtTexture(smooth, { wrap: 'clamp' });
  assert.deepEqual(exportGLTF(s).json.samplers, [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }]);
});

test('COLLADA pixelArt writes NEAREST and NEAREST_MIPMAP_NEAREST samplers', async () => {
  const s = await scene();
  assert.match(exportDAE(s).dae, /<minfilter>LINEAR_MIPMAP_LINEAR<\/minfilter><magfilter>LINEAR<\/magfilter>/);
  assert.match(exportDAE(s, { pixelArt: true }).dae, /<minfilter>NEAREST<\/minfilter><magfilter>NEAREST<\/magfilter>/);
  const mips = exportDAE(s, { pixelArt: { mipmaps: 'nearest', wrap: 'clamp' } }).dae;
  assert.match(mips, /<wrap_s>CLAMP<\/wrap_s><wrap_t>CLAMP<\/wrap_t><minfilter>NEAREST_MIPMAP_NEAREST<\/minfilter>/);
});

test('exportModel pixelArt rewrites every loaded sampler', () =>
  headlessModels(async () => {
    const file = await readFile(new URL('../../../examples/assets/scifi-helmet.glb', import.meta.url)),
      model = await parseGLTFAsync(await headless(), new Uint8Array(file));
    const plain = readGLB(await exportModel(model, { binary: true })).json,
      pixel = readGLB(await exportModel(model, { binary: true, pixelArt: { mipmaps: 'nearest' } })).json;
    assert.ok(plain.samplers.some((s) => s.minFilter !== 9984));
    assert.ok(pixel.samplers.length > 0);
    for (const s of pixel.samplers) assert.deepEqual([s.magFilter, s.minFilter], [9728, 9984]);
    assert.ok(pixel.textures.every((t) => t.sampler !== undefined));
  }));

test('pixelArt rejects unknown values with the fix in the message', async () => {
  const s = await scene();
  assert.throws(() => exportGLTF(s, { pixelArt: { mipmaps: 'linear' } }), {
    name: 'RangeError',
    message: /'none' or 'nearest'/,
  });
  assert.throws(() => exportGLTF(s, { pixelArt: { wrap: 'border' } }), { name: 'RangeError', message: /'clamp'/ });
  assert.throws(() => exportGLTF(s, { pixelArt: 'yes' }), { name: 'TypeError', message: /pass true/ });
  assert.throws(() => pixelArtTexture(s.nodes[0].material.baseColorTexture, { mipmaps: 1 }), RangeError);
});

test('Unreal pixel-art script sets the texture group, filter, mip policy and storage, and checks each', async () => {
  const { createUnrealPixelArtScript } = await import('../dist/unreal-pixel-art.js');
  const none = createUnrealPixelArtScript(),
    mips = createUnrealPixelArtScript({ mipmaps: 'nearest' });
  for (const text of [none, mips]) {
    assert.match(text, /"lod_group": unreal\.TextureGroup\.TEXTUREGROUP_PIXELS2D/);
    assert.match(text, /"filter": unreal\.TextureFilter\.TF_NEAREST/);
    assert.match(text, /"compression_settings": unreal\.TextureCompressionSettings\.TC_EDITOR_ICON/);
    assert.match(text, /"lossy_compression_amount": unreal\.TextureLossyCompressionAmount\.TLCA_NONE/);
  }
  assert.match(none, /TextureMipGenSettings\.TMGS_NO_MIPMAPS/);
  assert.match(mips, /TextureMipGenSettings\.TMGS_SIMPLE_AVERAGE/);
  assert.throws(() => createUnrealPixelArtScript({ mipmaps: 'linear' }), RangeError);
  // Run the script against a fake unreal module: a setting that does not read back raises, an empty path raises.
  const { spawnSync } = await import('node:child_process');
  const python = findPython();
  if (!python) return; // no Python on this machine; the text assertions above still hold
  const fake = `
import sys, types
class Enum:
    def __getattr__(self, name): return name
unreal = types.ModuleType("unreal")
for n in ["TextureGroup", "TextureFilter", "TextureMipGenSettings", "TextureCompressionSettings", "TextureLossyCompressionAmount"]:
    setattr(unreal, n, Enum())
class Texture2D:
    def __init__(self, sticky=True): self.props, self.sticky = {}, sticky
    def set_editor_property(self, k, v): self.props[k] = v if self.sticky or k != "filter" else "TF_DEFAULT"
    def get_editor_property(self, k): return self.props[k]
    def get_path_name(self): return "/Game/T"
unreal.Texture2D = Texture2D
assets = {}
class Library:
    does_asset_exist = staticmethod(lambda p: p in assets)
    load_asset = staticmethod(lambda p: assets[p])
    list_assets = staticmethod(lambda p, recursive, include_folder: [k for k in assets if k.startswith(p + "/")])
    save_loaded_asset = staticmethod(lambda a, only_if_is_dirty: True)
unreal.EditorAssetLibrary = Library
unreal.log = lambda m: print(m)
sys.modules["unreal"] = unreal
`;
  const script = `${fake}\nexec(${JSON.stringify(none)})
assets["/Game/A/T"], assets["/Game/A/U"] = Texture2D(), Texture2D()
assert apply_pixel_art("/Game/A") == 2
assert assets["/Game/A/T"].props["mip_gen_settings"] == "TMGS_NO_MIPMAPS"
assets["/Game/B"] = Texture2D(sticky=False)
for path in ["/Game/B", "/Game/None"]:
    try:
        apply_pixel_art(path)
        raise SystemExit("no error for " + path)
    except RuntimeError as e:
        print("raised", e)
print("OK")
`;
  const run = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  // A process that never started has no stderr; report the spawn error itself (it once surfaced as an invalid
  // assert message instead).
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /PIXEL_ART_PASS 2/);
  assert.match(run.stdout, /raised Pixel-art setting did not stick: \/Game\/T filter/);
  assert.match(run.stdout, /raised No Texture2D at or under \/Game\/None/);
  assert.match(run.stdout, /OK\s*$/);
});

test('Unity pixel-art postprocessor sets Point filtering, the mip policy and no compression for one folder', async () => {
  const { createUnityPixelArtPostprocessor } = await import('../dist/unity-pixel-art.js');
  const none = createUnityPixelArtPostprocessor({ folder: 'Assets/Tiles' }),
    mips = createUnityPixelArtPostprocessor({ folder: 'Assets/Tiles/Big', mipmaps: 'nearest', className: 'TileMips' });
  assert.match(none, /public sealed class PixelArtTextures : AssetPostprocessor/);
  assert.match(none, /const string Folder = "Assets\/Tiles\/";/);
  assert.match(none, /if \(!assetPath\.StartsWith\(Folder\)\) return;/);
  for (const line of [
    'importer.filterMode = FilterMode.Point;',
    'importer.streamingMipmaps = false;',
    'importer.textureCompression = TextureImporterCompression.Uncompressed;',
    'importer.npotScale = TextureImporterNPOTScale.None;',
  ])
    assert.ok(none.includes(line) && mips.includes(line), line);
  assert.match(none, /importer\.mipmapEnabled = false;/);
  assert.match(mips, /importer\.mipmapEnabled = true;/);
  assert.match(mips, /class TileMips/);
  for (const folder of ['Tiles', 'Assets/../x', 'Assets/a"b', 'Assets/'])
    assert.throws(() => createUnityPixelArtPostprocessor({ folder }), { name: 'TypeError', message: /under Assets/ });
  assert.throws(() => createUnityPixelArtPostprocessor({ folder: 'Assets', className: '1x' }), TypeError);
  assert.throws(() => createUnityPixelArtPostprocessor({ folder: 'Assets', mipmaps: 'linear' }), RangeError);
});
