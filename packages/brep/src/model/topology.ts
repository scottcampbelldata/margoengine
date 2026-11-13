// The modeler's boundary representation: bodies of shells of faces, each face bounded by loops of coedges, each coedge
// one use of an edge (two for an edge inside a solid, run in opposite directions), each edge between two vertices on
// a curve. Every face, edge and vertex has a persistent name: the operation that made it and what it was made from,
// so a reference to "the side face from sketch edge 3" survives later edits (operations record what they generate,
// modify and delete in a History).
import type { XYZ } from '../geometry/vec.js';
import type { CurveDef, SurfaceDef } from './geometry.js';

/** A persistent name, such as 'box1/face:+z' or 'extrude2/side:sketch1/e3'. */
export type Name = string;

/** A point where edges meet, with its persistent name and how far it may be from its edges' curves. */
export class Vertex {
  constructor(
    public name: Name,
    public point: XYZ,
    /** Largest distance the vertex may be from the curves of its edges, in metres. */
    public tolerance = 1e-7,
  ) {}
}

/** A bounded piece of a curve between two vertices (one, for a closed edge), used once each way by two face loops in a solid. */
export class Edge {
  /** The edge's uses by face loops: two, run in opposite directions, for an edge inside a solid. */
  readonly coedges: Coedge[] = [];
  constructor(
    public name: Name,
    public curve: CurveDef,
    public start: Vertex,
    public end: Vertex,
    /** Whether start to end runs in the curve's increasing parameter direction. */
    public sameSense = true,
    /** Largest distance from the edge to the surfaces of its faces, in metres. */
    public tolerance = 1e-7,
  ) {}
  /** A closed edge (a full circle) starts and ends at one vertex. */
  get closed(): boolean {
    return this.start === this.end;
  }
}

/** One use of an edge by a face loop, along the edge or against it. */
export class Coedge {
  constructor(
    public readonly edge: Edge,
    /** Whether the loop runs along the edge (start to end). */
    public readonly forward: boolean,
    public loop: Loop,
  ) {
    edge.coedges.push(this);
  }
  get start(): Vertex {
    return this.forward ? this.edge.start : this.edge.end;
  }
  get end(): Vertex {
    return this.forward ? this.edge.end : this.edge.start;
  }
}

/** A closed chain of coedges bounding a face; the face lies to their left seen from its normal. */
export class Loop {
  readonly coedges: Coedge[] = [];
  constructor(public face: Face) {}
  /** Adds the use of `edge` (forward or reversed) at the end of the loop. */
  use(edge: Edge, forward: boolean): Coedge {
    const c = new Coedge(edge, forward, this);
    this.coedges.push(c);
    return c;
  }
}

/** A bounded piece of a surface, its normal along the surface's or against it, bounded by loops. */
export class Face {
  readonly loops: Loop[] = [];
  constructor(
    public name: Name,
    public surface: SurfaceDef,
    /** Whether the face normal (out of a solid) is the surface's natural normal. */
    public sense: boolean,
    public shell?: Shell,
  ) {}
  /** A new loop on this face; the face lies to the left of its coedges, seen from the face normal. */
  loop(): Loop {
    const l = new Loop(this);
    this.loops.push(l);
    return l;
  }
}

/** A connected set of faces: a closed shell bounds a solid (or a cavity in one). */
export class Shell {
  readonly faces: Face[] = [];
  /** For a cavity's shell: the shell it lies inside. Its faces face into the cavity, out of the material. */
  outer?: Shell;
  constructor(public body?: Body) {}
  add(face: Face): Face {
    face.shell = this;
    this.faces.push(face);
    return face;
  }
}

/** A solid or a sheet: its shells, and the faces, edges and vertices they hold. */
export class Body {
  readonly shells: Shell[] = [];
  constructor(
    public name: Name,
    /** 'solid': closed shells bounding material; 'sheet': open or closed surfaces with no inside. */
    public kind: 'solid' | 'sheet',
  ) {}
  shell(): Shell {
    const s = new Shell(this);
    this.shells.push(s);
    return s;
  }
  get faces(): Face[] {
    return this.shells.flatMap((s) => s.faces);
  }
  get edges(): Edge[] {
    const out = new Set<Edge>();
    for (const f of this.faces) for (const l of f.loops) for (const c of l.coedges) out.add(c.edge);
    return [...out];
  }
  get vertices(): Vertex[] {
    const out = new Set<Vertex>();
    for (const e of this.edges) out.add(e.start).add(e.end);
    return [...out];
  }
}

/**
 * One operation's effect on names: what it made new (and from what), what continued under other names (a face split
 * by a cut continues as its pieces), and what it removed.
 */
export interface HistoryEntry {
  readonly operation: Name;
  /** New entities and the entities they were made from (a side face from a sketch segment, an edge where two faces met). */
  readonly generated: readonly (readonly [Name, readonly Name[]])[];
  /** Entities that continue as others: [from, to], several for one `from` when it was split. */
  readonly modified: readonly (readonly [Name, Name])[];
  readonly deleted: readonly Name[];
}

/** The record of operations that lets a name stored before an edit find what became of it. */
export class History {
  readonly entries: HistoryEntry[] = [];
  record(entry: HistoryEntry): void {
    this.entries.push(entry);
  }
  /**
   * The current names of what `name` became: itself when nothing changed it, the names it continued as (a face split
   * by a cut becomes two), or none when it was deleted.
   */
  resolve(name: Name): Name[] {
    return this.follow([name], 0);
  }
  /** The current names of what was made from `name` (the side face swept from a sketch segment), followed to now. */
  generatedFrom(name: Name): Name[] {
    const out: Name[] = [];
    this.entries.forEach((e, i) => {
      for (const [to, from] of e.generated) if (from.includes(name)) out.push(...this.follow([to], i + 1));
    });
    return [...new Set(out)];
  }
  private follow(names: Name[], first: number): Name[] {
    let current = names;
    for (const e of this.entries.slice(first)) {
      const next: Name[] = [];
      for (const n of current) {
        if (e.deleted.includes(n)) continue;
        const modified = e.modified.filter(([from]) => from === n).map(([, to]) => to);
        next.push(...(modified.length ? modified : [n]));
      }
      current = [...new Set(next)];
    }
    return current;
  }
}
