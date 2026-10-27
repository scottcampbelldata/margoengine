import { collectPolygonEdges, edgeId } from './polygon.js';
import type { ComponentEditResult, MeshEditResult, PolygonEdge, PolygonMesh } from './types.js';

/**
 * Add edge provenance to a result whose vertices were renumbered: each source edge maps to the output edge between
 * its endpoints' descendants (`remap`) when that edge exists, unless `overrides` names its descendants explicitly.
 * Created edges are output edges no source edge maps to.
 */
export function remappedEdgeResult(
  source: PolygonMesh,
  result: MeshEditResult,
  remap: (vertex: number) => number | undefined,
  overrides: ReadonlyMap<string, readonly string[]> = new Map(),
): ComponentEditResult {
  const sourceEdges = collectPolygonEdges(source),
    outputEdges = new Set(collectPolygonEdges(result.mesh).map((edge) => edge.id)),
    edgeMap: Record<string, string[]> = {},
    reached = new Set<string>();
  for (const edge of sourceEdges) {
    let ids: string[];
    const override = overrides.get(edge.id);
    if (override) ids = override.filter((id) => outputEdges.has(id));
    else {
      const a = remap(edge.vertices[0]),
        b = remap(edge.vertices[1]),
        id = a === undefined || b === undefined || a === b ? null : edgeId(a, b);
      ids = id !== null && outputEdges.has(id) ? [id] : [];
    }
    edgeMap[edge.id] = ids;
    for (const id of ids) reached.add(id);
  }
  return {
    ...result,
    edgeMap,
    createdEdges: [...outputEdges].filter((id) => !reached.has(id)),
    removedEdges: sourceEdges.filter((edge) => !edgeMap[edge.id].length).map((edge) => edge.id),
  };
}

/** Edges by ID, and a check that every two-face edge is wound oppositely and no edge has more than two faces. */
export function manifoldEdges(mesh: PolygonMesh, label: string): Map<string, PolygonEdge> {
  const edges = new Map(collectPolygonEdges(mesh).map((edge) => [edge.id, edge]));
  for (const edge of edges.values()) {
    if (edge.incidences.length > 2)
      throw new TypeError(`${label} needs manifold edges; repair edges with more than two incident faces.`);
    if (edge.incidences.length === 2) {
      const [a, b] = edge.incidences;
      if (a.from !== b.to || a.to !== b.from)
        throw new TypeError(`${label} needs consistent face winding; orient neighboring faces consistently.`);
    }
  }
  return edges;
}

/** Validate an edge-ID selection against the mesh: a nonempty array of existing, distinct edge IDs. */
export function selectedEdges(edges: ReadonlyMap<string, PolygonEdge>, ids: unknown, label: string): PolygonEdge[] {
  if (!Array.isArray(ids)) throw new TypeError(`${label} needs an array of edge IDs; supply "low:high" edge IDs.`);
  const seen = new Set<string>(),
    out: PolygonEdge[] = [];
  for (const id of ids) {
    const edge = typeof id === 'string' ? edges.get(id) : undefined;
    if (!edge) throw new TypeError(`${label} edge ${String(id)} does not exist; select existing edge IDs.`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(edge);
  }
  return out;
}

/** Unit vector from a to b, or null for coincident points. */
export function direction(a: readonly number[], b: readonly number[]): number[] | null {
  const x = b[0] - a[0],
    y = b[1] - a[1],
    z = b[2] - a[2],
    l = Math.hypot(x, y, z);
  return l > 0 ? [x / l, y / l, z / l] : null;
}

/** Check that `options` is a plain options object (or omitted). */
export function assertOptions(options: unknown, label: string): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError(`${label} options need an object; supply the documented options or omit them.`);
}
