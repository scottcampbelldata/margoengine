// Native importer texts for the precision bundles: every application name lands where it should and nowhere else.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGodotFlipbookPlayer } from '../dist/godot-flipbook.js';
import { createGodotPrecisionAddon } from '../dist/godot-precision-addon.js';
import { godotImportedNodeName, GODOT_SUFFIX_IMPORT_SETTINGS } from '../dist/import-names.js';
import { createRobloxRuntimeRestore } from '../dist/roblox-runtime-restore.js';
import { createUnityPrecisionImporter, UNITY_PRECISION_JSON_PRESENCE } from '../dist/unity-precision-importer.js';
import { createUnrealPrecisionImporter } from '../dist/unreal-precision-importer.js';

const hooks = {
  materialName: 'Material_0',
  validateMaster: 'def validate_master(project, manifest):\n    return project["document"]\n',
  atlasPayload: 'def atlas_payload(manifest, master, source_sha):\n    return "{}"\n',
  checkMasterAtlas: '    pass\n',
};

test('each text carries the application name in its three spellings and no other', () => {
  const texts = {
    unreal: createUnrealPrecisionImporter({ ...hooks, appName: 'Acme', masterFile: 'source.acme' }),
    unity: createUnityPrecisionImporter({ appName: 'Acme', extension: 'acmeunity' }),
    godot: Object.values(createGodotPrecisionAddon({ appName: 'Acme', extension: 'acmeprecision' })).join('\n'),
    player: createGodotFlipbookPlayer({ appName: 'Acme' }),
    restore: createRobloxRuntimeRestore('a'.repeat(64), { appName: 'Acme' }),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.doesNotMatch(text, /margo/i, name);
    assert.match(text, /Acme/, name);
  }
  assert.match(texts.unreal, /ACME_UNREAL_PRECISION: /);
  assert.match(texts.unreal, /"\/Game\/AcmePrecision_" \+ uuid/);
  assert.match(texts.unreal, /"source\.acme"/);
  assert.match(texts.unreal, /def validate_master\(project, manifest\):\n {4}return project\["document"\]/);
  assert.match(texts.unity, /namespace AcmePrecision \{/);
  assert.match(texts.unity, /"ACME_UNITY_BUNDLE"/);
  assert.match(texts.unity, /"acmeunity"/);
  assert.ok(texts.unity.includes(UNITY_PRECISION_JSON_PRESENCE));
  assert.match(texts.godot, /"acme\.precision\.v1"/);
  assert.match(texts.godot, /PackedStringArray\(\["acmeprecision"\]\)/);
  assert.match(texts.godot, /acme_source_object_id/);
  assert.match(texts.player, /"AcmeFlipbook"/);
  assert.match(texts.restore, /local EXPECTED_MANIFEST_SHA = "a{64}"/);
  assert.match(texts.restore, /AcmeRuntimeManifestSha256/);
});

test('texts are pure functions of their options', () => {
  const a = createUnityPrecisionImporter({ appName: 'Acme', extension: 'acmeunity' });
  assert.equal(createUnityPrecisionImporter({ appName: 'Acme', extension: 'acmeunity' }), a);
  assert.notEqual(createUnityPrecisionImporter({ appName: 'Other', extension: 'acmeunity' }), a);
});

test('invalid names, extensions, hooks and hashes throw with the fix', () => {
  for (const appName of ['', 'acme', 'Ac me', 'A'.repeat(49), 'Acmé', undefined])
    assert.throws(() => createGodotFlipbookPlayer({ appName }), /appName must be 1-48 ASCII letters/);
  assert.throws(() => createUnityPrecisionImporter({ appName: 'Acme', extension: '.acme' }), /extension must be/);
  assert.throws(
    () => createUnrealPrecisionImporter({ ...hooks, appName: 'Acme', masterFile: '../x' }),
    /masterFile must be a bundle file name/,
  );
  assert.throws(
    () => createUnrealPrecisionImporter({ ...hooks, appName: 'Acme', masterFile: 's.a', validateMaster: 'pass' }),
    /validateMaster must be Python source starting with "def validate_master\(project, manifest\):"/,
  );
  assert.throws(
    () => createUnrealPrecisionImporter({ ...hooks, appName: 'Acme', masterFile: 's.a', materialName: 'a b' }),
    /materialName must be an asset name/,
  );
  assert.throws(() => createRobloxRuntimeRestore('A'.repeat(64), { appName: 'Acme' }), /manifestSha256 must be 64/);
});

test('Godot suffix import names the node Godot keeps and turns name suffixes on', () => {
  assert.equal(godotImportedNodeName('Wall-col', true), 'Wall');
  assert.equal(godotImportedNodeName('Wall-convcol', true), 'Wall');
  assert.equal(godotImportedNodeName('Wall', false), 'Wall');
  assert.throws(() => godotImportedNodeName('Wall-col', false), /requires an emitted mesh node/);
  for (const name of ['Wall_col', 'Wall-COL', '1Wall', 'Wall-colonly', 'Wa ll'])
    assert.throws(() => godotImportedNodeName(name, true), /safe ASCII base/);
  assert.match(GODOT_SUFFIX_IMPORT_SETTINGS, /^\[remap\]\nimporter="scene"/);
  assert.match(GODOT_SUFFIX_IMPORT_SETTINGS, /nodes\/use_name_suffixes=true/);
});

// The first native Unreal 5.8 run (examples/package-benchmarks/results/unreal-precision-import.json) failed in turn on
// three checks that could never pass; these pin each fix in the importer text.
const unrealText = () => createUnrealPrecisionImporter({ ...hooks, appName: 'Acme', masterFile: 'source.acme' });
const pythonBlock = (text, name) => {
  const start = text.indexOf(`def ${name}(`);
  assert.ok(start >= 0, name);
  const end = text.indexOf('\n\n\n', start);
  return text.slice(start, end < 0 ? undefined : end);
};

test('Unreal set_exact compares struct values (SoftObjectPath) by their exported text, lists element by element', async () => {
  const text = unrealText();
  assert.match(pythonBlock(text, 'comparable'), /isinstance\(value, unreal\.StructBase\)[\s\S]*export_text\(\)/);
  // Run the importer's own need/comparable/set_exact against a fake unreal module whose structs compare by identity,
  // as Unreal's Python wrappers do: the read-back copy of a SoftObjectPath list must still count as the value set.
  const { spawnSync } = await import('node:child_process');
  const script = `
class StructBase:
    pass
class SoftObjectPath(StructBase):
    def __init__(self, path): self.path = path
    def export_text(self): return self.path
class _Unreal: pass
unreal = _Unreal(); unreal.StructBase = StructBase
def need(ok, message):
    if not ok: raise ValueError(message)
${pythonBlock(text, 'comparable')}

${pythonBlock(text, 'set_exact')}

class Owner:
    def __init__(self): self.values = {}
    def set_editor_property(self, name, value):
        self.values[name] = [SoftObjectPath(v.path) for v in value] if isinstance(value, list) else value
    def get_editor_property(self, name): return self.values[name]
owner = Owner()
set_exact(owner, "override_pipelines", [SoftObjectPath("/Interchange/Pipelines/A.A"), SoftObjectPath("/Interchange/Pipelines/B.B")])
set_exact(owner, "is_automated", True)
try:
    owner.set_editor_property = lambda name, value: owner.values.__setitem__(name, [SoftObjectPath("/Other.Other")])
    set_exact(owner, "override_pipelines", [SoftObjectPath("/Interchange/Pipelines/A.A")])
    print("MISSED")
except ValueError:
    print("OK")
`;
  const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);
  if (!python) return; // no Python on this machine; the text assertion above still holds
  const run = spawnSync(python, ['-c', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'OK', 'equal paths pass, a different path still fails');
});

test('Unreal texture policy uses only properties UE 5.8 has, and the used-texture check allows a NullRHI editor', () => {
  const text = unrealText(),
    policy = pythonBlock(text, 'texture_policy');
  assert.doesNotMatch(policy, /"compression_none":/, 'UE 5.8 Texture2D has no compression_none');
  assert.match(policy, /"lossy_compression_amount": unreal\.TextureLossyCompressionAmount\.TLCA_NONE/);
  assert.match(policy, /TC_VECTOR_DISPLACEMENTMAP/);
  assert.match(
    pythonBlock(text, 'inspect_unlit'),
    /need\(used in \(\[\], \[texture\]\), "Actual native graph must bind only the exact owned atlas"\)/,
  );
});
