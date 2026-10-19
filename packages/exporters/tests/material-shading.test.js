// Lambert and Phong materials as data: COLLADA effects, MTL illum/Ks/Ns and the glTF metallic-roughness stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDAE, exportGLTF, exportOBJ } from '../dist/index.js';

const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const scene = (material) => ({ nodes: [{ name: 'tile', geometry: tri, material }] });

test('lambert and phong reach glTF as metalness 0 with roughness 1 or the shininess equivalent', () => {
  const pbr = (material) => exportGLTF(scene(material)).json.materials[0].pbrMetallicRoughness;
  const lambert = pbr({ shading: 'lambert', roughness: 0.2, metalness: 1 });
  assert.equal(lambert.metallicFactor, 0);
  assert.equal(lambert.roughnessFactor, 1);
  const phong = pbr({ shading: 'phong', shininess: 30 });
  assert.equal(phong.metallicFactor, 0);
  assert.equal(phong.roughnessFactor, 0.5, '(2 / 32)^(1/4)');
});

test('COLLADA writes the named effect: lambert, phong with its specular and shininess', () => {
  const effect = (material) => /<technique sid="common">(.*?)<\/technique>/.exec(exportDAE(scene(material)).dae)[1];
  assert.match(effect({ shading: 'lambert' }), /^<lambert>/);
  // Effect colors are written sRGB; 0 and 1 read the same in both spaces.
  const phong = effect({ shading: 'phong', specular: [1, 0, 1], shininess: 12 });
  assert.match(phong, /^<phong>/);
  assert.match(phong, /<specular><color>1 0 1 1<\/color><\/specular>/);
  assert.match(phong, /<shininess><float>12<\/float><\/shininess>/);
  // A standard material keeps the derived choice.
  assert.match(effect({ roughness: 1, metalness: 0 }), /^<lambert>/);
  assert.match(effect({ roughness: 0.5 }), /^<phong>/);
});

test('MTL writes illum 1 for lambert and Ks/Ns/illum 2 for phong, defaulting to sRGB #111111 and 30', () => {
  const mtl = (material) => exportOBJ(scene({ name: 'm', ...material }), { materials: true }).mtl;
  const lambert = mtl({ shading: 'lambert' });
  assert.match(lambert, /^Ks 0 0 0$/m);
  assert.match(lambert, /^illum 1$/m);
  assert.doesNotMatch(lambert, /^Ns /m);
  const phong = mtl({ shading: 'phong' }),
    ks = /^Ks (\S+) (\S+) (\S+)$/m.exec(phong).slice(1).map(Number);
  for (const v of ks) assert.ok(Math.abs(v - 17 / 255) < 1e-4, `Ks ${v} is #11`);
  assert.match(phong, /^Ns 30$/m);
  assert.match(phong, /^illum 2$/m);
});

test('shading, specular and shininess are validated', () => {
  assert.throws(() => exportGLTF(scene({ shading: 'toon' })), TypeError);
  assert.throws(() => exportGLTF(scene({ shading: 'phong', shininess: -1 })), RangeError);
  assert.throws(() => exportGLTF(scene({ shading: 'phong', specular: [2, 0, 0] })), RangeError);
  assert.throws(() => exportGLTF(scene({ shading: 'phong', specular: [0, 0, 0, 1] })), TypeError);
});
