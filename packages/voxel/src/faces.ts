// Texture space of a voxel face, one definition for the bevel mesh (JS) and the renderer's shaders (WGSL generated
// here). Faces 0-5 are +x, -x, +y, -y, +z, -z; 6 and 7 are the two diagonal quads of a cross block. Tile coordinates
// (u, v) are in blocks, v running down the sides as in an image. A normal map's +x follows +u and its +y points up the
// image (-v), the glTF convention, so the tangent frame of a face is T = dP/du, B = N x T (= -dP/dv), N the outward
// normal.

/**
 * Per face: u = U . p + c * cell.x + k and v = V . p, as [Ux, Uy, Uz, c, k, Vx, Vy, Vz]. A cross quad's u runs along
 * its diagonal from its cell's corner.
 */
const TILE: readonly (readonly number[])[] = [
  [0, 0, -1, 0, 0, 0, -1, 0],
  [0, 0, 1, 0, 0, 0, -1, 0],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, -1],
  [1, 0, 0, 0, 0, 0, -1, 0],
  [-1, 0, 0, 0, 0, 0, -1, 0],
  [1, 0, 0, -1, 0, 0, -1, 0],
  [-1, 0, 0, 1, 1, 0, -1, 0],
];

/** Tile coordinate (u, v) of `point` on face `face` (cross faces: in cell `cellX`), as the shaders' `voxelTile`. */
export function tile(face: number, point: readonly number[], cellX = 0): [number, number] {
  const t = TILE[face];
  return [
    t[0] * point[0] + t[1] * point[1] + t[2] * point[2] + t[3] * cellX + t[4],
    t[5] * point[0] + t[6] * point[1] + t[7] * point[2],
  ];
}

// The WGSL text of a + b + ... for coefficient-term pairs, skipping zeros: `-l.z`, `cell.x+1.0-l.x`.
// Positive terms come first, so the text reads as written by hand (`l.x-cell.x`, `cell.x+1.0-l.x`) and rounds alike.
const sum = (terms: [number, string][]): string =>
  terms
    .filter(([c]) => c)
    .sort((a, b) => +(a[0] < 0) - +(b[0] < 0))
    .map(
      ([c, term], i) =>
        `${c < 0 ? '-' : i ? '+' : ''}${Math.abs(c) === 1 && term ? term : `${Math.abs(c)}.0${term && `*${term}`}`}`,
    )
    .join('') || '0.0';
const axes = (t: readonly number[], at: number, name: string): [number, string][] =>
  ['x', 'y', 'z'].map((a, i) => [t[at + i], `${name}.${a}`]);

/** WGSL `voxelTile(face, l, cell)`: the tile coordinates of chunk-local point l on a face of cell `cell`, from TILE. */
export const tileShader = /* wgsl */ `fn voxelTile(face:u32,l:vec3f,cell:vec3f)->vec2f {
 switch face {
${TILE.map((t, f) => `  ${f < 7 ? `case ${f}u` : 'default'} {return vec2f(${sum([...axes(t, 0, 'l'), [t[3], 'cell.x'], [t[4], '']])},${sum(axes(t, 5, 'l'))});}`).join('\n')}
 }
}
`;

const H = Math.SQRT1_2;
/** dP/du per face (unit length): the tangent of the normal-map frame. */
export const TANGENTS: readonly (readonly [number, number, number])[] = [
  [0, 0, -1],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [H, 0, H],
  [-H, 0, H],
];

// voxelNormal: the shading normal for tangent-space sample m (in [-1, 1]) on a surface with normal n and face tangent
// t; t is made perpendicular to n first, so tilted bevel strips and the up-facing cross normal get a valid frame.
export const normalShader = /* wgsl */ `fn voxelTangent(face:u32)->vec3f {var t=array<vec3f,8>(${TANGENTS.map((t) => `vec3f(${t.join(',')})`).join(',')});return t[face&7u];}
fn voxelNormal(n:vec3f,t:vec3f,m:vec3f)->vec3f {let u=normalize(t-n*dot(n,t));return normalize(u*m.x+cross(n,u)*m.y+n*m.z);}
`;
