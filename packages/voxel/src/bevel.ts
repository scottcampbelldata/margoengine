// Chamfer a voxel surface. The greedy mesher's quads stay on the block grid, so a fractional bevel cannot live in that
// format. This builds a triangle mesh: each cube face keeps an inset panel, and corners move in along the average of
// the faces that meet there so neighbouring faces still share those vertices.
import { tile } from './faces.js';

/** A cube face {@link bevelQuads} can chamfer. A decoded chunk quad satisfies this. */
export interface CubeFace {
  /** Cell x of the face's origin. */
  x: number;
  /** Cell y of the face's origin. */
  y: number;
  /** Cell z of the face's origin. */
  z: number;
  /** 0-5: +x, −x, +y, −y, +z, −z. Faces 6 and 7 (crosses) are skipped. */
  face: number;
  /** Width in cells along the face's u axis: z on x faces, x on y and z faces. */
  w: number;
  /** Height in cells along the face's v axis: y on x and z faces, z on y faces. */
  h: number;
  /** Id copied onto every vertex of this face. Default 0. */
  material?: number;
  /** Mesher corner AO (0-3) in the corner order (0,0), (w,0), (w,h), (0,h). Default 3 (open). */
  ao?: readonly number[];
  /** Mesher corner sky light (0-15), same order. Default 15. */
  sky?: readonly number[];
  /** Mesher corner block light (0-15), same order. Default 0. */
  block?: readonly number[];
}

/** Triangle mesh from {@link bevelQuads}. Positions are in blocks, the same space as the input cells. */
export interface BevelMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Unit normal per vertex: the face's on its inset panel, the slope's on a chamfer strip. */
  normals: Float32Array;
  /** Three vertex indices per triangle, counterclockwise seen from outside. */
  indices: Uint32Array;
  /** `CubeFace.material` per vertex. */
  materials: Uint32Array;
  /** Face tile coordinates per vertex, the same (u, v) as the chunk shader's `voxelTile`. */
  uv: Float32Array;
  /** AO, sky and block light per vertex, bilinear over the face's corners, in the mesher's units. */
  lighting: Float32Array;
}

const NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const OPEN = [3, 3, 3, 3],
  SKY = [15, 15, 15, 15],
  DARK = [0, 0, 0, 0];

// Corner (u, v) of a face: (u, v) = (z, y) on ±x, (x, z) on ±y, (x, y) on ±z, as the chunk mesher lays them out.
function corner({ x, y, z, face }: CubeFace, u: number, v: number): [number, number, number] {
  if (face < 2) return [x + +!face, y + v, z + u];
  if (face < 4) return [x + u, y + +(face === 2), z + v];
  return [x + u, y + v, z + +(face === 4)];
}

const keyOf = (p: readonly number[]): string =>
  `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;

/**
 * Bevels cube faces by `bevel` blocks. `0` returns each face as two flat triangles. Faces 6 and 7 are skipped. Pass
 * only faces of full cubes: a lowered liquid top is not a cube. Corners shared by several faces move once, along their
 * average outward normal, so the mesh stays welded; corner AO and light are interpolated over panels and strips.
 * @throws RangeError when `bevel` is not in [0, 0.5).
 */
export function bevelQuads(quads: readonly CubeFace[], bevel: number): BevelMesh {
  if (!(bevel >= 0 && bevel < 0.5)) throw new RangeError(`Voxel bevel ${bevel} must be in [0, 0.5) blocks`);
  const faces = quads.filter((quad) => quad.face < 6),
    // Counterclockwise from outside: u x v points inward on +x, +y and -z, so those loops run the other way.
    loops = faces.map((q) => {
      const raw = [corner(q, 0, 0), corner(q, q.w, 0), corner(q, q.w, q.h), corner(q, 0, q.h)];
      return q.face === 0 || q.face === 2 || q.face === 5 ? [raw[0], raw[3], raw[2], raw[1]] : raw;
    }),
    sums = new Map<string, [number, number, number]>();
  loops.forEach((loop, i) => {
    const n = NORMALS[faces[i].face];
    for (const point of loop) {
      const key = keyOf(point),
        sum = sums.get(key) ?? [0, 0, 0];
      sums.set(key, [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]]);
    }
  });
  const outer = (point: readonly number[]): number[] => {
    const n = sums.get(keyOf(point))!,
      scale = bevel / (Math.hypot(n[0], n[1], n[2]) || 1);
    return point.map((p, a) => p - n[a] * scale);
  };
  const positions: number[] = [],
    normals: number[] = [],
    materials: number[] = [],
    lighting: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  faces.forEach((quad, i) => {
    const loop = loops[i],
      material = quad.material ?? 0,
      ao = quad.ao ?? OPEN,
      sky = quad.sky ?? SKY,
      block = quad.block ?? DARK,
      center = [0, 1, 2].map((a) => (loop[0][a] + loop[2][a]) / 2);
    // Bilinear corner values at a point of the face's (u, v) rectangle.
    const push = (point: readonly number[], at: readonly number[], normal: readonly number[]): number => {
      const u = (quad.face < 2 ? at[2] - quad.z : at[0] - quad.x) / quad.w,
        v = (quad.face === 2 || quad.face === 3 ? at[2] - quad.z : at[1] - quad.y) / quad.h,
        mix = (c: readonly number[]) => (c[0] * (1 - u) + c[1] * u) * (1 - v) + (c[3] * (1 - u) + c[2] * u) * v;
      positions.push(point[0], point[1], point[2]);
      normals.push(normal[0], normal[1], normal[2]);
      materials.push(material);
      uv.push(...tile(quad.face, at));
      lighting.push(mix(ao), mix(sky), mix(block));
      return positions.length / 3 - 1;
    };
    const inner = loop.map((point) => {
      const to = point.map((p, a) => center[a] - p),
        reach = Math.hypot(to[0], to[1], to[2]),
        step = Math.min(bevel, reach * 0.49) / reach;
      return point.map((p, a) => p + to[a] * step);
    });
    const panel = inner.map((point) => push(point, point, NORMALS[quad.face]));
    indices.push(panel[0], panel[1], panel[2], panel[0], panel[2], panel[3]);
    if (!bevel) return;
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4,
        o0 = outer(loop[edge]),
        o1 = outer(loop[next]),
        e = o1.map((p, a) => p - o0[a]),
        f = inner[next].map((p, a) => p - o0[a]),
        n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]],
        length = Math.hypot(n[0], n[1], n[2]) || 1,
        slope = n.map((c) => c / length),
        // Texture and light come from the face point each strip vertex was moved from.
        a = push(o0, loop[edge], slope),
        b = push(o1, loop[next], slope),
        c = push(inner[next], inner[next], slope),
        d = push(inner[edge], inner[edge], slope);
      indices.push(a, b, c, a, c, d);
    }
  });
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    materials: Uint32Array.from(materials),
    uv: Float32Array.from(uv),
    lighting: Float32Array.from(lighting),
  };
}

/** A bevel for `VoxelRendererOptions.bevel`, from {@link voxelBevel}. */
export interface VoxelBevel {
  /** Blocks the cube faces are chamfered by, in (0, 0.5). */
  readonly amount: number;
  /** @internal The chunk mesh: interleaved vertices (`layout`, world blocks), indices, and triangle centres in chunk blocks. */
  mesh(
    faces: readonly CubeFace[],
    origin: readonly number[],
  ): { vertices: Float32Array; indices: Uint32Array; centers: Float32Array };
  /** @internal The vertex layout: position, normal, uv, light, then material | face << 12. */
  readonly layout: GPUVertexBufferLayout;
  /** @internal WGSL of the bevel beauty shader between the shared lit part and the shared shading end. */
  readonly shader: string;
  /** @internal WGSL of the bevel shadow casters (bevelVertex, bevelCutout). */
  readonly shadow: string;
}

const WORDS = 12;
const BEVEL = {
  layout: {
    arrayStride: WORDS * 4,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x3' },
      { shaderLocation: 4, offset: 44, format: 'uint32' },
    ],
  } as GPUVertexBufferLayout,
  // The fragment reads its material by id and its face's tangent from the material word; the rest is the quads' end.
  shader: /* wgsl */ `
struct In {@location(0) p:vec3f,@location(1) n:vec3f,@location(2) uv:vec2f,@location(3) lighting:vec3f,@location(4) material:u32}
struct Out {@builtin(position) clip:vec4f,@location(0) n:vec3f,@location(1) @interpolate(flat) material:u32,@location(2) uv:vec2f,@location(3) world:vec3f,@location(4) lighting:vec3f}
@vertex fn vertex(v:In)->Out {var o:Out;o.clip=f.camera*vec4f(v.p,1.0);o.n=v.n;o.material=v.material;o.uv=v.uv;o.world=v.p;o.lighting=v.lighting;return o;}
@fragment fn fragment(o:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let id=(o.material&4095u)*2u;let m=voxelMaterials[id];let maps=voxelMaterials[id+1u];
 let uv=o.uv;let dx=dpdx(uv);let dy=dpdy(uv);let lit=o.lighting;
 var i:VoxelPixel;i.clip=o.clip;i.position=o.world;
 let outward=normalize(o.n);let normal=outward*select(-1.0,1.0,front);let tangent=voxelTangent(o.material>>12u);`,
  shadow: /* wgsl */ `
struct BevelOut {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) material:u32,@location(1) uv:vec2f}
@vertex fn bevelVertex(@location(0) p:vec3f,@location(2) uv:vec2f,@location(4) material:u32)->BevelOut {return BevelOut(shadow.matrix*vec4f(p,1.0),material,uv);}
@fragment fn bevelCutout(o:BevelOut) {if(!voxelOpaque(voxelMaterials[(o.material&4095u)*2u],o.uv,shadow.time.x)){discard;}}
`,
};

/**
 * A bevel of `amount` blocks for `VoxelRenderer.attach(engine, { bevel: voxelBevel(0.15) })`: each chunk's cube faces
 * become a chamfered triangle mesh ({@link bevelQuads}), lit, shadowed and replayed like the quads. Its own entry, so
 * worlds without a bevel carry none of it.
 * @throws RangeError when `amount` is not in (0, 0.5).
 */
export function voxelBevel(amount: number): VoxelBevel {
  if (!(amount > 0 && amount < 0.5)) throw new RangeError(`voxelBevel ${amount} must be in (0, 0.5) blocks`);
  return {
    amount,
    ...BEVEL,
    mesh(faces, origin) {
      const built = bevelQuads(faces, amount),
        { positions: p, indices } = built,
        n = built.materials.length,
        vertices = new Float32Array(n * WORDS),
        words = new Uint32Array(vertices.buffer),
        centers = new Float32Array(indices.length);
      for (let v = 0, o = 0; v < n; v++, o += WORDS) {
        for (let a = 0; a < 3; a++) {
          vertices[o + a] = p[v * 3 + a] + origin[a];
          vertices[o + 3 + a] = built.normals[v * 3 + a];
          vertices[o + 8 + a] = built.lighting[v * 3 + a];
        }
        vertices[o + 6] = built.uv[v * 2];
        vertices[o + 7] = built.uv[v * 2 + 1];
        words[o + 11] = built.materials[v];
      }
      for (let i = 0; i < indices.length; i++)
        for (let a = 0; a < 3; a++) centers[i - (i % 3) + a] += p[indices[i] * 3 + a] / 3;
      return { vertices, indices, centers };
    },
  };
}
