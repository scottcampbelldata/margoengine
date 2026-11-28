export const materialCount = 8;

export function encodeDisplayMesh(mesh, faceName, slotOf) {
  const groups = Array.from({ length: materialCount }, () => []);
  for (const { id, first, count } of mesh.faces) {
    const group = groups[slotOf(faceName(id))];
    for (let i = first; i < first + count; i++) group.push(mesh.indices[i]);
  }
  const { positions, normals, indices } = mesh;
  const headerLength = 2 + materialCount;
  const scalars = positions.length;
  const headerBytes = headerLength * 4;
  const data = new ArrayBuffer(headerBytes + scalars * 8 + indices.length * 2);
  const header = new Uint32Array(data, 0, headerLength);
  header.set([0x3847424d, scalars, ...groups.map(group => group.length)]);
  new Float32Array(data, headerBytes, scalars).set(positions);
  new Float32Array(data, headerBytes + scalars * 4, scalars).set(normals);
  const out = new Uint16Array(data, headerBytes + scalars * 8);
  if (scalars / 3 > 65536 || groups.reduce((sum, group) => sum + group.length, 0) !== indices.length) {
    throw new Error('The display mesh has incomplete face ranges or too many vertices.');
  }
  let offset = 0;
  for (const group of groups) {
    out.set(group, offset);
    offset += group.length;
  }
  return new Uint8Array(data);
}

export function readDisplayMesh(data) {
  const headerLength = 2 + materialCount;
  const header = new Uint32Array(data, 0, headerLength);
  if (header[0] !== 0x3847424d) throw new Error('Invalid engine-block display mesh.');
  const scalars = header[1], headerBytes = headerLength * 4;
  const positions = new Float32Array(data, headerBytes, scalars);
  const normals = new Float32Array(data, headerBytes + scalars * 4, scalars);
  const indices = new Uint16Array(data, headerBytes + scalars * 8);
  let offset = 0;
  const groups = Array.from(header.subarray(2), count => {
    const group = indices.subarray(offset, offset + count);
    offset += count;
    return group;
  });
  if (scalars % 3 || offset !== indices.length || groups.some(group => group.length === 0 || group.length % 3)) {
    throw new Error('Incomplete engine-block display mesh.');
  }
  return { positions, normals, indices, groups };
}