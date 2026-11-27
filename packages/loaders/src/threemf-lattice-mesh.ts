// Adds a 3MF beam lattice's triangles to its mesh object, for `parse3MFEvaluated`: the shells of
// `mesh3MFBeamLattice`, cut by the clipping mesh when the lattice names one, with the properties the beam lattice
// extension gives them (https://github.com/3MFConsortium/spec_beamlattice, chapter 2: a beam's property runs along its
// axis, a surface takes that of the nearest point of the axis, and a clipped surface takes the clipping mesh's).
import { mesh3MFBeamLattice } from './threemf-beams.js';
import { booleanMesh } from './threemf-csg.js';
import type { ThreeMFEvaluatedLattice, ThreeMFEvaluateOptions } from './threemf-evaluate.js';
import type { ThreeMFBeamLattice } from './threemf-lattice.js';
import {
  cornerProperty,
  type ThreeMFExtension,
  type ThreeMFMesh,
  type ThreeMFModel,
  type ThreeMFObject,
} from './threemf.js';
import { LoaderError } from './types.js';
import { floats, limits, uints } from './util.js';

const F = '3MF';
const NONE = 0xffffffff;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

type Color = [number, number, number, number];

/** A lattice's shells as a mesh with the properties of their beams and balls. */
function shells(
  model: ThreeMFModel,
  object: ThreeMFObject,
  lattice: ThreeMFBeamLattice,
  vertices: Float32Array,
  gradients: ReadonlySet<string>,
  options: { segments: number | undefined; maxTriangles: number },
): ThreeMFMesh {
  const made = mesh3MFBeamLattice(vertices, lattice, options),
    out: ThreeMFMesh = { vertices: floats(), triangles: uints(), pid: uints(), p: uints(), flat: [] },
    blended: Color[] = [];
  let blendedAt = -1;
  for (let v = 0; v < made.positions.length; v += 3)
    out.vertices.push3(made.positions[v], made.positions[v + 1], made.positions[v + 2]);
  for (const { kind, index, triangleStart, triangleCount } of made.parts) {
    const beam = kind === 'beam' ? lattice.beams[index] : undefined,
      ball = kind === 'ball' ? lattice.effectiveBalls[index] : undefined,
      pid = (beam ?? ball!).pid,
      first = beam ? beam.p1 : ball!.property,
      second = beam ? (beam.p2 ?? first) : first,
      group = pid === undefined ? undefined : model.properties.get(pid),
      a = first === undefined ? undefined : group?.[first],
      b = second === undefined ? undefined : group?.[second],
      at = pid === undefined ? NONE : model.propertyIds.indexOf(pid),
      // Only a colour group blends; a base material holds for the whole beam.
      blend = a && b && gradients.has(pid!) && String(a) !== String(b);
    for (let t = triangleStart; t < triangleStart + triangleCount; t++) {
      const corners = [made.indices[t * 3], made.indices[t * 3 + 1], made.indices[t * 3 + 2]];
      out.triangles.push3(corners[0], corners[1], corners[2]);
      out.flat!.push(a);
      if (blend) {
        if (blendedAt < 0) {
          blendedAt = model.propertyIds.length;
          const id = `\0lattice ${object.id}`;
          model.propertyIds.push(id);
          model.properties.set(id, blended);
        }
        for (const v of corners) {
          const s = made.along[v];
          blended.push([0, 1, 2, 3].map((k) => a[k] + (b[k] - a[k]) * s) as Color);
        }
        out.pid.push(blendedAt);
        out.p.push3(blended.length - 3, blended.length - 2, blended.length - 1);
      } else {
        // A property the colour groups do not hold, such as a texture's, gives the surface none here.
        out.pid.push(at < 0 ? NONE - 1 : at);
        const index = first ?? NONE;
        out.p.push3(index, index, index);
      }
    }
  }
  return out;
}

/** One mesh of two, each triangle keeping its group colour. */
function appended(model: ThreeMFModel, object: ThreeMFObject, meshes: readonly ThreeMFMesh[]): ThreeMFMesh {
  const out: ThreeMFMesh = { vertices: floats(), triangles: uints(), pid: uints(), p: uints(), flat: [] };
  for (const mesh of meshes) {
    const base = out.vertices.length / 3,
      count = mesh.vertices.length / 3,
      source = mesh.vertices.array;
    for (let v = 0; v < count; v++) out.vertices.push3(source[v * 3], source[v * 3 + 1], source[v * 3 + 2]);
    for (let t = 0; t < mesh.triangles.length / 3; t++) {
      const [a, b, c] = mesh.triangles.array.subarray(t * 3, t * 3 + 3),
        // An index past its own mesh stays past the joined one, for the reader to refuse.
        at = (v: number): number => (v < count ? base + v : NONE);
      out.triangles.push3(at(a), at(b), at(c));
      out.pid.push(mesh.pid.array[t]);
      out.p.push3(mesh.p.array[t * 3], mesh.p.array[t * 3 + 1], mesh.p.array[t * 3 + 2]);
      const property = cornerProperty(model, object, mesh, t, 0);
      out.flat!.push(mesh.flat ? mesh.flat[t] : property && model.properties.get(property.id)?.[property.index]);
    }
  }
  return out;
}

/** The lattice step of the evaluating reader. */
export function lattices(options: ThreeMFEvaluateOptions) {
  /** The colour groups of each model part, whose properties blend along a beam. */
  const gradients = new Map<ThreeMFModel, Set<string>>(),
    found: ThreeMFEvaluatedLattice[] = [];
  const hooks: ThreeMFExtension = {
    element(model, name, a) {
      if (name !== 'colorgroup' || !a.id) return;
      let ids = gradients.get(model);
      if (!ids) gradients.set(model, (ids = new Set()));
      ids.add(a.id);
    },
    bucket: () => '',
    corner() {},
    group() {},
  };
  return {
    hooks,
    async add(
      model: ThreeMFModel,
      own: ReadonlyMap<string, ThreeMFBeamLattice>,
      surfaces: ReadonlyMap<string, ThreeMFMesh>,
      modelPath: string | undefined,
    ): Promise<void> {
      const { maxTriangles } = limits(options, F);
      for (const [objectId, lattice] of own) {
        const object = model.objects.get(objectId)!;
        found.push({ objectId, ...(modelPath === undefined ? {} : { modelPath }), lattice });
        let made = shells(model, object, lattice, object.mesh!.vertices.result(), gradients.get(model) ?? new Set(), {
          segments: options.beamSegments,
          maxTriangles,
        });
        if (!made.triangles.length) continue;
        if (lattice.clippingMode !== 'none') {
          const clip = model.objects.get(lattice.clippingMesh!),
            surface = surfaces.get(lattice.clippingMesh!);
          if (!clip || !surface || clip === object)
            throw new LoaderError(F, 'range', `the lattice of object ${objectId.slice(0, 32)} names no clipping mesh`);
          made = await booleanMesh(
            model,
            `${objectId} lattice`,
            lattice.clippingMode === 'inside' ? 'intersection' : 'difference',
            [
              { model, object: { ...object, mesh: made }, transform: IDENTITY },
              { model, object: { ...clip, mesh: surface }, transform: IDENTITY },
            ],
            maxTriangles,
          );
        }
        object.mesh = appended(model, object, [object.mesh!, made]);
      }
    },
    result: () => found,
  };
}
