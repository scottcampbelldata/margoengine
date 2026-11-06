import type { MutableVec2, MutableVec3 } from '@margoengine/math';
import { faceGeometryError } from './polygon.js';
import { loopFaces } from './polygon-split.js';
import { createMeshEditResult } from './result.js';
import type { MeshEditResult, PolygonFace, PolygonMesh } from './types.js';

/** Collects output faces, splitting any that a move left warped, and records which input face each came from. */
export class FaceSink {
  readonly faces: PolygonFace[] = [];
  readonly faceMap: Record<string, string[]> = {};
  split = 0;

  constructor(
    source: PolygonMesh,
    readonly vertices: MutableVec3[],
  ) {
    for (const face of source.faces) this.faceMap[face.id] = [];
  }

  /** Add one face under `id`, from input face `from` (null for a new face); pieces of a warped face take the IDs `id~t1`, `id~t2` and so on. */
  add(from: string | null, id: string, vertices: readonly number[], uv: readonly (readonly number[])[]): void {
    const corners: number[] = [],
      uvs: MutableVec2[] = [];
    vertices.forEach((v, i) => {
      if (v === corners[corners.length - 1]) return;
      corners.push(v);
      uvs.push([uv[i][0], uv[i][1]]);
    });
    while (corners.length > 1 && corners[0] === corners[corners.length - 1]) {
      corners.pop();
      uvs.pop();
    }
    if (corners.length < 3) return;
    if (!faceGeometryError(this.vertices, corners)) {
      this.faces.push({ id, vertices: corners, uv: uvs });
      if (from !== null) this.faceMap[from].push(id);
      return;
    }
    let next = 0;
    const pieces = loopFaces(this.vertices, corners, uvs, id, () => `${id}~t${++next}`);
    if (!pieces) {
      this.split++;
      return;
    }
    if (pieces.length > 1) this.split++;
    for (const piece of pieces) {
      this.faces.push(piece);
      if (from !== null) this.faceMap[from].push(piece.id);
    }
  }

  /** The edit: `vertexMap` lists each input vertex's outputs. Input faces that were not added come out empty. */
  result(source: PolygonMesh, vertexMap: number[][], diagnostics: string[] = []): MeshEditResult {
    const mesh = { vertices: this.vertices, faces: this.faces };
    if (this.split) diagnostics.push(`${this.split} warped faces were split or dropped to stay valid.`);
    return createMeshEditResult(source, mesh, {
      vertexMap,
      faceMap: this.faceMap,
      createdVertices: vertexMap.flatMap((list, v) => list.filter((x) => x !== v)),
      removedVertices: [],
      diagnostics,
    });
  }
}
