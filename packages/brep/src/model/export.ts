// Bodies to STEP (each face, edge and vertex keeps its persistent name as the STEP entity's name), and to meshes
// through the kernel's own STEP reader and tessellator.
import type { STEPModel } from '../index.js';
import { Tessellator, type BodyMesh, type TessellationOptions } from '../mesh/tessellate.js';
import { STEPFile, stepText } from '../step/file.js';
import { readStructure } from '../step/structure.js';
import { StepWriter } from '../step/write.js';
import { writeCurve, writeSurface } from './geometry.js';
import type { Body, Edge, Face, Name, Shell, Vertex } from './topology.js';

const text = (name: Name) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** An AP214 STEP file of the bodies, in metres. */
export function bodiesToSTEP(bodies: readonly Body[]): string {
  const w = new StepWriter(),
    vertices = new Map<Vertex, string>(),
    edges = new Map<Edge, string>(),
    items: string[] = [];
  const vertex = (v: Vertex) => {
    let id = vertices.get(v);
    if (!id) vertices.set(v, (id = w.add(`VERTEX_POINT(${text(v.name)},${w.point(v.point)})`)));
    return id;
  };
  const edge = (e: Edge) => {
    let id = edges.get(e);
    if (!id)
      edges.set(
        e,
        (id = w.add(
          `EDGE_CURVE(${text(e.name)},${vertex(e.start)},${vertex(e.end)},${writeCurve(w, e.curve)},${e.sameSense ? '.T.' : '.F.'})`,
        )),
      );
    return id;
  };
  // A face as written; `inverted` writes it facing the other way (a cavity's faces, which STEP turns back round).
  const face = (f: Face, inverted: boolean) => {
    const bounds = f.loops
      .filter((l) => l.coedges.length)
      .map((l) => {
        const oriented = l.coedges.map((c) =>
          w.add(`ORIENTED_EDGE('',*,*,${edge(c.edge)},${c.forward ? '.T.' : '.F.'})`),
        );
        return w.add(`FACE_BOUND('',${w.add(`EDGE_LOOP('',(${oriented.join(',')}))`)},${inverted ? '.F.' : '.T.'})`);
      });
    return w.add(
      `ADVANCED_FACE(${text(f.name)},(${bounds.join(',')}),${writeSurface(w, f.surface)},${f.sense !== inverted ? '.T.' : '.F.'})`,
    );
  };
  const closed = (s: Shell, inverted = false) =>
    w.add(`CLOSED_SHELL('',(${s.faces.map((f) => face(f, inverted)).join(',')}))`);
  for (const body of bodies)
    for (const shell of body.shells) {
      if (!shell.faces.length || shell.outer) continue;
      if (body.kind !== 'solid') {
        const faces = shell.faces.map((f) => face(f, false));
        items.push(
          w.add(`SHELL_BASED_SURFACE_MODEL(${text(body.name)},(${w.add(`OPEN_SHELL('',(${faces.join(',')}))`)}))`),
        );
        continue;
      }
      // A cavity is a closed shell facing out of the empty space, turned round by an oriented shell.
      const voids = body.shells
        .filter((s) => s.outer === shell && s.faces.length)
        .map((s) => w.add(`ORIENTED_CLOSED_SHELL('',*,${closed(s, true)},.F.)`));
      items.push(
        voids.length
          ? w.add(`BREP_WITH_VOIDS(${text(body.name)},${closed(shell)},(${voids.join(',')}))`)
          : w.add(`MANIFOLD_SOLID_BREP(${text(body.name)},${closed(shell)})`),
      );
    }
  return w.finish(items, { unit: 'm', source: 'Margo modeler' });
}

/** Meshes of bodies through STEP, with each mesh face run's persistent face name. */
export interface BodyMeshes {
  readonly model: STEPModel;
  readonly meshes: BodyMesh[];
  /** The persistent name of the face a mesh run (`mesh.faces[i].id`) belongs to. */
  faceName(id: number): Name | undefined;
}

/** Tessellates bodies with the kernel's tessellator (`options` as for tessellateSTEP). */
export function meshBodies(bodies: readonly Body[], options: TessellationOptions = {}): BodyMeshes {
  // As parseSTEP and tessellateSTEP do (imported here directly: the package index imports this module).
  const file = new STEPFile(stepText(bodiesToSTEP(bodies))),
    model: STEPModel = { header: file.header, file, ...readStructure(file) },
    tessellator = new Tessellator(model.file, model.faceColors, options),
    meshes = model.bodies.map((b) => tessellator.body(b));
  return {
    model,
    meshes,
    faceName: (id) => {
      const name = model.file.get(id).args[0];
      return typeof name === 'string' ? name : undefined;
    },
  };
}
