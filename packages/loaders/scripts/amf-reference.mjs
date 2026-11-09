// Independent AMF test oracle: apply elementary rotations to points, rather than composing parser matrices.
import assert from 'node:assert/strict';
import { readXMLTree } from '../dist/xml.js';

export function referenceAMF(source) {
  const root = readXMLTree(source, 'AMF proof').children.find((node) => node.name === 'amf'),
    children = (node, tag) => node.children.filter((child) => child.name === tag);
  const child = (node, tag) => children(node, tag)[0];
  const number = (node, tag) => Number(child(node, tag)?.text.trim() ?? 0);
  const objects = new Map(children(root, 'object').map((node) => [node.attributes.id, node]));
  const builds = new Map(children(root, 'constellation').map((node) => [node.attributes.id, node]));
  const unit = root.attributes.unit ?? 'millimeter';
  const scale = { millimeter: 1e-3, inch: 0.0254, feet: 0.3048, meter: 1, micron: 1e-6 }[unit];
  assert.ok(scale, `AMF oracle needs a known unit: ${unit}`);
  const positions = [],
    indices = [],
    visiting = new Set();
  const placed = (instance, point) => {
    let [x, y, z] = point;
    const radians = (tag) => (number(instance, tag) * Math.PI) / 180;
    let angle = radians('rx');
    [y, z] = [y * Math.cos(angle) - z * Math.sin(angle), y * Math.sin(angle) + z * Math.cos(angle)];
    angle = radians('ry');
    [x, z] = [x * Math.cos(angle) + z * Math.sin(angle), -x * Math.sin(angle) + z * Math.cos(angle)];
    angle = radians('rz');
    [x, y] = [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
    return [x + number(instance, 'deltax'), y + number(instance, 'deltay'), z + number(instance, 'deltaz')];
  };
  const visit = (id, transform) => {
    assert.ok(!visiting.has(id), `AMF oracle cycle at ${id}`);
    const object = objects.get(id);
    if (object) {
      const mesh = child(object, 'mesh');
      if (!mesh) return;
      const base = positions.length / 3;
      for (const vertex of children(child(mesh, 'vertices'), 'vertex')) {
        const coords = child(vertex, 'coordinates');
        positions.push(...transform(['x', 'y', 'z'].map((tag) => number(coords, tag))).map((value) => value * scale));
      }
      for (const volume of children(mesh, 'volume'))
        for (const triangle of children(volume, 'triangle'))
          indices.push(...['v1', 'v2', 'v3'].map((tag) => base + number(triangle, tag)));
      return;
    }
    const build = builds.get(id);
    assert.ok(build, `AMF oracle missing object/constellation ${id}`);
    visiting.add(id);
    for (const instance of children(build, 'instance'))
      visit(instance.attributes.objectid, (point) => transform(placed(instance, point)));
    visiting.delete(id);
  };
  const used = new Set(
    [...builds.values()].flatMap((node) => children(node, 'instance').map((instance) => instance.attributes.objectid)),
  );
  const roots = builds.size ? [...builds.keys()].filter((id) => !used.has(id)) : [...objects.keys()];
  assert.ok(roots.length, 'AMF oracle has a build root');
  for (const id of roots) visit(id, (point) => point);
  return { positions, indices };
}
