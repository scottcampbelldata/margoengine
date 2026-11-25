// B-rep formats (STEP, IGES, ACIS SAT, Parasolid XT, JT) through Margo's own kernel, @margoengine/brep: read the
// file, mesh each placed body once from its exact geometry, and place it as often as the assembly does. Runs inside the
// CAD worker (bundled into cad-runtime.js), never on the page.
import { parseIGES, parseJT, parseSAT, parseSTEP, parseXT, Tessellator } from '@margoengine/brep';
import type { BodyMesh, JTModel, STEPModel } from '@margoengine/brep';
import { meshBuffers, type MeshBuffers } from '../internal/buffers.js';

/** A B-rep format the kernel reads. */
export type BRepFormat = 'step' | 'iges' | 'sat' | 'xt' | 'jt';

/** Largest vertex count of one geometry; a body's colour group above it is split at face boundaries. */
const maxVertices = 1_000_000;

/** One mesh of a placed body: its geometry (index into `geometries`), name, colour and transform. */
export interface BRepPlacement {
  geometry: number;
  name: string;
  color: string | null;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

/** What {@link readBRep} made. */
export interface BRepRead {
  /** One geometry per body and colour, in the body's own frame in metres; shared by every placement of the body. */
  geometries: MeshBuffers[];
  /** Every placed mesh, in file order. */
  placements: BRepPlacement[];
  /** Faces the kernel could not mesh (each left out of its body). */
  failedFaces: number;
  /** What the reader left out or assumed. */
  warnings: string[];
}

export interface BRepReadOptions {
  /** Largest chord distance from the true surface, in metres (default: the kernel's, 0.001 of each body's size). */
  deflection?: number;
  /** Exact surface normals (true) or one flat normal per triangle (false). */
  smoothing: boolean;
  /** Called with 0 to 1 as bodies are meshed. */
  progress(fraction: number): void;
  /** Throws once the placed meshes pass the caller's cap. */
  checkParts(count: number): void;
  /** Throws once the distinct triangles pass the caller's cap. */
  checkIndices(count: number): void;
}

/** sRGB display colour (0..1) as '#rrggbb'. */
const hex = (c: readonly number[]) =>
  `#${[0, 1, 2]
    .map((k) =>
      Math.round(Math.min(1, Math.max(0, c[k])) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Column-major 4x4 product a * b. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

/**
 * A rigid placement as position, rotation (quaternion x, y, z, w) and scale, a mirror going into a negative x scale;
 * undefined for a singular or sheared matrix (column dot products above 1e-6 once normalized), which is baked instead.
 */
function split(
  m: ArrayLike<number>,
):
  | { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] }
  | undefined {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]),
    sz = Math.hypot(m[8], m[9], m[10]),
    det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (!sx || !sy || !sz || !det || ![sx, sy, sz, det, m[12], m[13], m[14]].every(Number.isFinite)) return undefined;
  if (m[3] || m[7] || m[11] || m[15] !== 1) return undefined;
  const scale: [number, number, number] = [det < 0 ? -sx : sx, sy, sz],
    // Rotation columns.
    r = [0, 1, 2].map((c) => [0, 1, 2].map((k) => m[c * 4 + k] / scale[c]));
  for (const [a, b] of [
    [0, 1],
    [0, 2],
    [1, 2],
  ])
    if (Math.abs(r[a][0] * r[b][0] + r[a][1] * r[b][1] + r[a][2] * r[b][2]) > 1e-6) return undefined;
  // Element (row i, column j) is r[j][i].
  const [m00, m10, m20] = r[0],
    [m01, m11, m21] = r[1],
    [m02, m12, m22] = r[2],
    trace = m00 + m11 + m22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const l = Math.hypot(...q);
  return { position: [m[12], m[13], m[14]], rotation: q.map((x) => x / l) as typeof q, scale };
}

/**
 * A body's triangles as geometries in metres, one per colour (a face's own colour, else `bodyColor`): vertices
 * renumbered per group, with the kernel's exact surface normals, or one flat normal per triangle without smoothing.
 * `matrix` (column-major, metres to metres) is baked in when given: a placement with shear cannot be a mesh transform.
 */
function colourGroups(
  mesh: BodyMesh,
  bodyColor: string | null,
  smoothing: boolean,
  matrix?: ArrayLike<number>,
): { color: string | null; geometry: MeshBuffers }[] {
  const runs = new Map<string, { first: number; count: number }[]>();
  for (const face of mesh.faces) {
    const key = face.color ? hex(face.color) : (bodyColor ?? '');
    let list = runs.get(key);
    if (!list) runs.set(key, (list = []));
    list.push({ first: face.first, count: face.count });
  }
  const out: { color: string | null; geometry: MeshBuffers }[] = [],
    p = mesh.positions,
    n = mesh.normals,
    t = mesh.indices,
    u = mesh.unit,
    m = matrix,
    // Normals move with the inverse transpose; for a baked matrix that is its cofactor matrix (renormalized below).
    cof = m && [
      m[5] * m[10] - m[6] * m[9],
      m[6] * m[8] - m[4] * m[10],
      m[4] * m[9] - m[5] * m[8],
      m[2] * m[9] - m[1] * m[10],
      m[0] * m[10] - m[2] * m[8],
      m[1] * m[8] - m[0] * m[9],
      m[1] * m[6] - m[2] * m[5],
      m[2] * m[4] - m[0] * m[6],
      m[0] * m[5] - m[1] * m[4],
    ],
    slot = new Int32Array(p.length / 3).fill(-1);
  let positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [],
    used: number[] = [];
  const point = (x: number, y: number, z: number) => {
      if (!m) positions.push(x, y, z);
      else
        positions.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
    },
    direction = (x: number, y: number, z: number) => {
      if (!cof) return void normals.push(x, y, z);
      const a = cof[0] * x + cof[1] * y + cof[2] * z,
        b = cof[3] * x + cof[4] * y + cof[5] * z,
        c = cof[6] * x + cof[7] * y + cof[8] * z,
        l = Math.hypot(a, b, c) || 1;
      normals.push(a / l, b / l, c / l);
    };
  for (const [key, list] of runs) {
    const flush = () => {
      for (const v of used) slot[v] = -1;
      if (indices.length) out.push({ color: key || null, geometry: meshBuffers(positions, normals, indices) });
      positions = [];
      normals = [];
      indices = [];
      used = [];
    };
    for (const { first, count } of list) {
      // A face never spans two geometries: the group is cut before a face that would pass the vertex limit.
      if (positions.length / 3 + count > maxVertices) flush();
      for (let i = first; i < first + count; i += 3) {
        if (!smoothing) {
          const a = t[i] * 3,
            b = t[i + 1] * 3,
            c = t[i + 2] * 3,
            ux = p[b] - p[a],
            uy = p[b + 1] - p[a + 1],
            uz = p[b + 2] - p[a + 2],
            vx = p[c] - p[a],
            vy = p[c + 1] - p[a + 1],
            vz = p[c + 2] - p[a + 2],
            nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx,
            l = Math.hypot(nx, ny, nz);
          for (const v of [a, b, c]) {
            indices.push(positions.length / 3);
            point(p[v] * u, p[v + 1] * u, p[v + 2] * u);
            // A zero-area triangle draws nothing; it keeps +Z rather than a zero normal.
            if (l) direction(nx / l, ny / l, nz / l);
            else direction(0, 0, 1);
          }
          continue;
        }
        for (let k = 0; k < 3; k++) {
          const v = t[i + k];
          if (slot[v] < 0) {
            slot[v] = positions.length / 3;
            used.push(v);
            point(p[v * 3] * u, p[v * 3 + 1] * u, p[v * 3 + 2] * u);
            direction(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
          }
          indices.push(slot[v]);
        }
      }
    }
    flush();
  }
  return out;
}

/** One body to mesh and the placements (metres to the model's world, in metres) that show it. */
interface Job {
  model: STEPModel;
  body: number;
  color: string | null;
  uses: { name: string; matrix: ArrayLike<number> }[];
}

/** The jobs of a STEP-like model: each placed body once, with every placement of it. */
function stepJobs(model: STEPModel, outer?: ArrayLike<number>, partName?: string, partColor?: string | null): Job[] {
  const jobs = new Map<number, Job>();
  for (const instance of model.instances) {
    const body = model.bodies[instance.body];
    let job = jobs.get(instance.body);
    if (!job)
      jobs.set(
        instance.body,
        (job = { model, body: instance.body, color: body.color ? hex(body.color) : (partColor ?? null), uses: [] }),
      );
    const product = instance.product >= 0 ? model.products[instance.product]?.name : '';
    job.uses.push({
      name: partName || product || body.name || `body ${instance.body}`,
      matrix: outer ? multiply(outer, instance.matrix) : instance.matrix,
    });
  }
  return [...jobs.values()];
}

/** The jobs of a JT file: each part's B-rep bodies, placed by the part's instances times the body's own placements. */
function jtJobs(model: JTModel): Job[] {
  const jobs: Job[] = [];
  model.parts.forEach((part, index) => {
    if (!part.brep) return;
    const uses = model.instances.filter((instance) => instance.part === index);
    for (const instance of uses)
      for (const job of stepJobs(part.brep, instance.matrix, part.name, instance.color ? hex(instance.color) : null)) {
        const same = jobs.find((other) => other.model === job.model && other.body === job.body);
        if (same) same.uses.push(...job.uses);
        else jobs.push(job);
      }
  });
  return jobs;
}

/**
 * Reads a B-rep file and meshes it: each placed body once (one geometry per colour), placed by a transform per use.
 * Bodies the kernel cannot mesh count all their faces as failed and leave the rest of the file standing.
 */
export function readBRep(buffer: ArrayBuffer, format: BRepFormat, options: BRepReadOptions): BRepRead {
  let jobs: Job[], warnings: string[];
  if (format === 'jt') {
    const model = parseJT(buffer);
    jobs = jtJobs(model);
    warnings = [...model.warnings];
    if (!jobs.length && model.parts.some((part) => part.shapes.some((shape) => shape.mesh)))
      warnings.push('The JT file has triangle LODs but no exact B-rep; only exact B-rep parts are read.');
  } else {
    const model =
      format === 'step'
        ? parseSTEP(buffer)
        : format === 'iges'
          ? parseIGES(buffer)
          : format === 'sat'
            ? parseSAT(buffer)
            : parseXT(buffer);
    jobs = stepJobs(model);
    warnings = [...model.warnings];
  }
  const tessellators = new Map<STEPModel, Tessellator>(),
    tessellator = (model: STEPModel) => {
      let t = tessellators.get(model);
      if (!t)
        tessellators.set(
          model,
          (t = new Tessellator(
            model.file,
            model.faceColors,
            options.deflection === undefined ? {} : { deflection: options.deflection },
          )),
        );
      return t;
    },
    geometries: MeshBuffers[] = [],
    placements: BRepPlacement[] = [];
  let failedFaces = 0,
    indexCount = 0;
  const add = (geometry: MeshBuffers) => {
    indexCount += geometry.indices.length;
    options.checkIndices(indexCount);
    return geometries.push(geometry) - 1;
  };
  jobs.forEach((job, j) => {
    const body = job.model.bodies[job.body];
    let mesh: BodyMesh;
    try {
      mesh = tessellator(job.model).body(body);
    } catch (error) {
      // One body the kernel cannot mesh (a face over the vertex cap, a malformed entity) leaves the others standing.
      failedFaces += Math.max(1, body.faces.length);
      warnings.push(`Body ${body.name || job.body} was left out: ${error instanceof Error ? error.message : error}`);
      options.progress((j + 1) / jobs.length);
      return;
    }
    failedFaces += mesh.failures.length;
    let shared: { color: string | null; geometry: number }[] | undefined;
    for (const use of job.uses) {
      const placed = split(use.matrix);
      if (placed) {
        shared ??= colourGroups(mesh, job.color, options.smoothing).map(({ color, geometry }) => ({
          color,
          geometry: add(geometry),
        }));
        for (const { color, geometry } of shared) {
          options.checkParts(placements.length + 1);
          placements.push({
            geometry,
            name: use.name,
            color,
            position: placed.position,
            rotation: placed.rotation,
            scale: placed.scale,
          });
        }
      }
      // A sheared or singular placement: its own copy of the body with the matrix baked in.
      else
        for (const { color, geometry } of colourGroups(mesh, job.color, options.smoothing, use.matrix)) {
          options.checkParts(placements.length + 1);
          placements.push({
            geometry: add(geometry),
            name: use.name,
            color,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          });
        }
    }
    options.progress((j + 1) / jobs.length);
  });
  return { geometries, placements, failedFaces, warnings };
}
