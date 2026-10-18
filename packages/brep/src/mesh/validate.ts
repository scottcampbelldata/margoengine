// Checks meshes against the validation properties a STEP file states about its own shape: the exporting system's
// volume, area, centre, bounding box and facet count, so every file that carries them tests the kernel by itself.

import {
  invert,
  multiply,
  type STEPBody,
  type STEPPoint,
  type STEPStructure,
  type STEPValidationProperty,
} from '../step/structure.js';
import type { BodyMesh } from './tessellate.js';

/** Options of {@link validateSTEP}. */
export interface ValidationOptions {
  /**
   * Largest difference that passes (default 0.005): of volume and area relative to the stated value, of the centre and
   * the box corners relative to the box's diagonal. Facet counts must match exactly.
   */
  readonly tolerance?: number;
}

/** What the meshes measure for the quantities a property states, in its frame and units (metres). */
export interface STEPMeasured {
  readonly volume?: number;
  readonly area?: number;
  readonly centroid?: STEPPoint;
  readonly box?: readonly [STEPPoint, STEPPoint];
  readonly facets?: number;
}

/** One stated property checked against the meshes. */
export interface STEPValidationCheck {
  readonly property: STEPValidationProperty;
  readonly measured: STEPMeasured;
  /** Volume and area: |measured / stated - 1|; centroid and box: largest distance over the box diagonal; facets: count. */
  readonly differences: {
    readonly volume?: number;
    readonly area?: number;
    readonly centroid?: number;
    readonly box?: number;
    readonly facets?: number;
  };
  /** Every stated quantity within tolerance, measured on meshes with no failed face. */
  readonly ok: boolean;
  /** Why a quantity could not be measured, or which bodies' faces failed. */
  readonly note?: string;
}

/** Running sums over triangles in one frame: volume and its centre, area and its centre, box, written facets. */
class Sums {
  volume = 0;
  area = 0;
  readonly volumeCentre = [0, 0, 0];
  readonly areaCentre = [0, 0, 0];
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];
  facets: number | undefined = 0;
  failed = 0;

  /** Adds a mesh, its positions scaled to metres and then mapped by `matrix` (column-major) when given. */
  add(mesh: BodyMesh, matrix?: Float64Array): void {
    const p = mesh.positions,
      u = mesh.unit,
      at = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] * u,
        y = p[i + 1] * u,
        z = p[i + 2] * u;
      for (let k = 0; k < 3; k++) {
        const v = matrix ? matrix[k] * x + matrix[4 + k] * y + matrix[8 + k] * z + matrix[12 + k] : [x, y, z][k];
        at[i + k] = v;
        if (v < this.min[k]) this.min[k] = v;
        if (v > this.max[k]) this.max[k] = v;
      }
    }
    const t = mesh.indices;
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i] * 3,
        b = t[i + 1] * 3,
        c = t[i + 2] * 3,
        ax = at[a],
        ay = at[a + 1],
        az = at[a + 2],
        bx = at[b],
        by = at[b + 1],
        bz = at[b + 2],
        cx = at[c],
        cy = at[c + 1],
        cz = at[c + 2],
        // Twice the triangle's area, and six times the signed volume of its tetrahedron with the origin.
        nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay),
        ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
        nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
        area = Math.hypot(nx, ny, nz) / 2,
        volume = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      this.area += area;
      this.volume += volume;
      this.areaCentre[0] += (area * (ax + bx + cx)) / 3;
      this.areaCentre[1] += (area * (ay + by + cy)) / 3;
      this.areaCentre[2] += (area * (az + bz + cz)) / 3;
      this.volumeCentre[0] += (volume * (ax + bx + cx)) / 4;
      this.volumeCentre[1] += (volume * (ay + by + cy)) / 4;
      this.volumeCentre[2] += (volume * (az + bz + cz)) / 4;
    }
    this.facets = this.facets === undefined || mesh.facets === undefined ? undefined : this.facets + mesh.facets;
    this.failed += mesh.failures.length;
  }
}

const point = (v: readonly number[], over: number): STEPPoint => [v[0] / over, v[1] / over, v[2] / over];
const relative = (measured: number, stated: number) =>
  stated ? Math.abs(measured / stated - 1) : Math.abs(measured) > 0 ? Infinity : 0;

/**
 * Checks meshes of a STEP model against the validation properties the file states (`model.validation`): volume, area,
 * centre, bounding box and facet count, each measured in the property's own frame. A product's property covers its
 * components' solids (its surface bodies when it has no solid; its independent surfaces for those properties), and
 * its area may count its surface bodies too, as some exporters do; a tessellated property is checked against the
 * tessellated bodies, a geometric one against the B-rep.
 *
 * @param meshes One mesh per body, in `model.bodies` order (what `tessellateSTEP` returns).
 */
export function validateSTEP(
  model: STEPStructure,
  meshes: readonly BodyMesh[],
  { tolerance = 0.005 }: ValidationOptions = {},
): STEPValidationCheck[] {
  if (!(tolerance >= 0)) throw new RangeError('tolerance must be 0 or more (a fraction, such as 0.005)');
  if (meshes.length !== model.bodies.length)
    throw new RangeError(
      `validateSTEP needs one mesh per body (${model.bodies.length}), got ${meshes.length}: pass tessellateSTEP's result`,
    );
  const below = new Map<number, number[]>();
  model.occurrences.forEach((o, i) => {
    if (o.parent >= 0) below.set(o.parent, [...(below.get(o.parent) ?? []), i]);
  });
  return model.validation.map((property) => {
    const sums = new Sums(),
      // A product's surface bodies beside its solids: exporters differ on whether its area counts them.
      surfaces = new Sums(),
      notes: string[] = [];
    /**
     * The bodies a property measures, among those of its shape: a tessellated property the tessellated ones; a
     * product's geometric property its solids (surface bodies only when it has none), independent surfaces its
     * surface bodies; named bodies their B-rep.
     */
    const kind = (bodies: readonly number[]) => {
      const of = (...kinds: STEPBody['kind'][]) => bodies.filter((b) => kinds.includes(model.bodies[b].kind));
      const first = (...lists: number[][]) => lists.find((l) => l.length) ?? bodies;
      if (property.tessellated) return first(of('tessellated'));
      if (property.independent) return first(of('shell'));
      if (property.bodies) return first(of('solid', 'faceted', 'shell'));
      return first(of('solid', 'faceted'), of('shell'), of('tessellated'));
    };
    let measuredBodies: readonly number[] = [];
    if (property.bodies) {
      measuredBodies = kind(property.bodies);
      for (const b of measuredBodies) sums.add(meshes[b]);
    } else {
      const root = model.occurrences.findIndex((o) => o.product === property.product);
      if (root < 0) notes.push('the product is not placed in the model');
      else {
        const within = new Set<number>(),
          stack = [root];
        while (stack.length) {
          const o = stack.pop()!;
          within.add(o);
          stack.push(...(below.get(o) ?? []));
        }
        const instances = model.instances.filter((i) => within.has(i.occurrence)),
          keep = new Set(kind([...new Set(instances.map((i) => i.body))])),
          toProduct = invert(model.occurrences[root].matrix);
        measuredBodies = [...keep];
        for (const instance of instances) {
          const kept = keep.has(instance.body);
          if (kept || (!property.tessellated && model.bodies[instance.body].kind === 'shell'))
            (kept ? sums : surfaces).add(meshes[instance.body], multiply(toProduct, instance.matrix));
        }
      }
    }
    const failed = measuredBodies.filter((b) => meshes[b].failures.length);
    if (failed.length) notes.push(`faces failed in ${failed.length} of ${measuredBodies.length} bodies`);

    const box: [STEPPoint, STEPPoint] | undefined =
        sums.min[0] <= sums.max[0] ? [point(sums.min, 1), point(sums.max, 1)] : undefined,
      surface =
        property.surfaceCentroid ||
        (measuredBodies.length > 0 && measuredBodies.every((b) => model.bodies[b].kind === 'shell')),
      centroid =
        surface || !sums.volume
          ? sums.area
            ? point(sums.areaCentre, sums.area)
            : undefined
          : point(sums.volumeCentre, sums.volume),
      reference = property.box ?? box,
      diagonal = reference
        ? Math.hypot(
            reference[1][0] - reference[0][0],
            reference[1][1] - reference[0][1],
            reference[1][2] - reference[0][2],
          )
        : 0;
    const measured: { -readonly [K in keyof STEPMeasured]: STEPMeasured[K] } = {},
      differences: { -readonly [K in keyof STEPValidationCheck['differences']]: number } = {};
    if (!measuredBodies.length) notes.push('no body to measure');
    else {
      if (property.volume !== undefined) {
        measured.volume = sums.volume;
        differences.volume = relative(sums.volume, property.volume);
      }
      if (property.area !== undefined) {
        const solids = relative(sums.area, property.area),
          all = relative(sums.area + surfaces.area, property.area);
        measured.area = all < solids ? sums.area + surfaces.area : sums.area;
        differences.area = Math.min(solids, all);
      }
      if (property.centroid && centroid) {
        measured.centroid = centroid;
        const d = Math.hypot(
          centroid[0] - property.centroid[0],
          centroid[1] - property.centroid[1],
          centroid[2] - property.centroid[2],
        );
        differences.centroid = diagonal ? d / diagonal : d ? Infinity : 0;
      }
      if (property.box && box) {
        measured.box = box;
        let d = 0;
        for (let corner = 0; corner < 2; corner++)
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(box[corner][k] - property.box[corner][k]));
        differences.box = diagonal ? d / diagonal : d ? Infinity : 0;
      }
      if (property.facets !== undefined) {
        if (sums.facets === undefined) notes.push('facets: the meshes are not the tessellation the file carries');
        else {
          measured.facets = sums.facets;
          differences.facets = Math.abs(sums.facets - property.facets);
        }
      }
    }
    const ok =
      !notes.length &&
      Object.entries(differences).every(([key, d]) => (key === 'facets' ? d === 0 : d <= tolerance)) &&
      Object.keys(differences).length > 0;
    return { property, measured, differences, ok, ...(notes.length ? { note: notes.join('; ') } : {}) };
  });
}
