// createGodotLightmapImport: the shader and post-import script that show a baked GLB lightmap in Godot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGodotLightmapImport } from '../dist/godot-lightmap.js';

const text = (entry) => new TextDecoder().decode(entry.data);

test('writes the shader and script with the given files and scales', () => {
  const [shader, script] = createGodotLightmapImport({
    albedo: 'albedo.png',
    lightmap: 'lightmap.png',
    emission: 'emission.png',
    lightmapScale: 2.5,
    emissionScale: 4,
    shader: 'godot/baked.gdshader',
  });
  assert.equal(shader.name, 'godot/baked.gdshader');
  assert.equal(script.name, 'godot/lightmap_import.gd');
  assert.match(
    text(shader),
    /ALBEDO = base\.rgb \* texture\(lightmap_texture, UV2\)\.rgb \* lightmap_scale\n {4}\+ texture\(emission_texture, UV\)\.rgb \* emission_scale;/,
  );
  const gd = text(script);
  assert.match(gd, /^@tool\nextends EditorScenePostImport\n/);
  assert.match(gd, /load\(folder\.path_join\("godot\/baked\.gdshader"\)\)/);
  assert.match(gd, /set_shader_parameter\("lightmap_scale", 2\.5\)/);
  assert.match(gd, /set_shader_parameter\("emission_texture", load\(folder\.path_join\("emission\.png"\)\)\)/);
});

test('leaves emission out when it is not given', () => {
  const [shader, script] = createGodotLightmapImport({ albedo: 'a.png', lightmap: 'l.png' });
  assert.doesNotMatch(text(shader), /emission/);
  assert.doesNotMatch(text(script), /emission/);
  assert.match(text(script), /set_shader_parameter\("lightmap_scale", 1\)/);
});

test('refuses unsafe paths and scales below 1', () => {
  for (const albedo of ['../a.png', '/a.png', 'a b.png', 'a/./b.png'])
    assert.throws(() => createGodotLightmapImport({ albedo, lightmap: 'l.png' }), TypeError, albedo);
  assert.throws(
    () => createGodotLightmapImport({ albedo: 'a.png', lightmap: 'l.png', lightmapScale: 0.5 }),
    RangeError,
  );
});
