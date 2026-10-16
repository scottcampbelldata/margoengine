import {materialQuad} from './materials-fixture.js';

/** A red opaque background behind a smaller independently configured material quad. */
export function transmissionQuads(extensions = {}) {
  const fixture = materialQuad();
  const front = structuredClone(fixture.doc.materials[0]);
  front.pbrMetallicRoughness.baseColorFactor = [1,1,1,1];
  front.extensions = extensions;
  fixture.doc.materials[0] = {doubleSided: true, emissiveFactor: [1,0,0],
    pbrMetallicRoughness: {baseColorFactor: [0,0,0,1], metallicFactor: 0, roughnessFactor: 1}};
  fixture.doc.materials.push(front);
  fixture.doc.meshes.push({primitives: [{...fixture.doc.meshes[0].primitives[0], material: 1}]});
  fixture.doc.nodes = [{mesh: 0, translation: [0,0,-0.4], scale: [1.5,1.5,1]}, {mesh: 1, scale: [0.7,0.7,1]}];
  return fixture;
}
