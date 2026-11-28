import { Geometry, PbrMaterial } from '@margoengine/core';

const linear = (c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;

function place(matrix, point, direction) {
  const [x, y, z] = point;
  const translation = direction ? 0 : 1;
  return [0,1,2].map((axis) => matrix[axis] * x + matrix[4+axis] * y +
    matrix[8+axis] * z + matrix[12+axis] * translation);
}

function prepare(source) {
  const { positions, normals, indices } = source.geometry;
  const vertices = [];
  for (let i=0;i<positions.length;i+=3) {
    const point = place(source.matrix, positions.subarray(i,i+3), false);
    const direction = place(source.matrix, normals.subarray(i,i+3), true);
    vertices.push([...point,...direction]);
  }
  return { element: source.element, vertices, indices };
}

function clip(triangle, normal, offset) {
  const product = (v) => normal[0]*v[0] + normal[1]*v[1] + normal[2]*v[2] + offset;
  const polygon = [];
  let previous = triangle[2];
  let from = product(previous);
  for (const point of triangle) {
    const to = product(point);
    if ((from < 0) !== (to < 0)) {
      const fraction = from / (from-to);
      polygon.push(previous.map((component, i) => component + (point[i]-component)*fraction));
    }
    if (to >= 0) polygon.push(point);
    previous = point;
    from = to;
  }
  return polygon;
}

function tessellate(parts, plane) {
  const positions = [], normals = [], indices = [];
  for (const part of parts) for (let i=0;i<part.indices.length;i+=3) {
    const triangle = [0,1,2].map((corner)=>part.vertices[part.indices[i+corner]]);
    const polygon = plane ? clip(triangle,plane.normal,plane.value) : triangle;
    if (polygon.length < 3) continue;
    const base = positions.length/3;
    for (const [x,y,z,nx,ny,nz] of polygon) {
      positions.push(x,y,z);
      normals.push(nx,ny,nz);
    }
    for (let point=1;point<polygon.length-1;point++) indices.push(base,base+point,base+point+1);
  }
  return new Geometry(positions,normals,indices);
}

export function buildOpaqueHouse(engine, sources) {
  const groups = new Map();
  for (const source of sources) {
    if (source.color[3]<1) continue;
    const key = source.color.slice(0,3).join();
    let group = groups.get(key);
    if (!group) {
      const color = source.color.slice(0,3).map(linear);
      const mesh = engine.createMesh().setMaterial(new PbrMaterial({ color, roughness: .80 }));
      group = { mesh, parts: [] };
      groups.set(key,group);
    }
    group.parts.push(prepare(source));
  }
  const highlight = engine.createMesh().setMaterial(new PbrMaterial({ color: '#fcbc66', roughness: .80 }));
  const meshes = [...Array.from(groups.values(), group=>group.mesh),highlight];
  return {
    meshes,
    update(plane, selection) {
      const selected = [];
      for (const { mesh, parts } of groups.values()) {
        const remaining = selection === undefined ? parts : parts.filter((part) => {
          if (part.element !== selection) return true;
          selected.push(part);
          return false;
        });
        mesh.setGeometry(tessellate(remaining,plane));
      }
      highlight.setGeometry(tessellate(selected,plane));
    },
  };
}
