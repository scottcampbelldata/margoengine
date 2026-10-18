// A small STEP (ISO 10303-21) writer for the kernel's converters (ACIS SAT, Parasolid XT): entities numbered from #100
// under one product whose shape representation holds the converted bodies, in one length unit, so the kernel's own
// STEP reader and tessellator take the result like any AP214 file.

/** A B-spline with standard (clamped: end multiplicity degree + 1) knot vectors, control points already in place. */
export interface WriterSpline {
  /** One degree for a curve, [u, v] for a surface. */
  readonly degrees: readonly number[];
  /** Control points per direction ([n] for a curve, [nu, nv] for a surface). */
  readonly counts: readonly number[];
  /** Distinct knots per direction. */
  readonly knots: readonly (readonly number[])[];
  /** Their multiplicities. */
  readonly multiplicities: readonly (readonly number[])[];
  /** Control points; for a surface, u varies fastest (index j * nu + i). */
  readonly points: readonly (readonly number[])[];
  /** Weights, when rational, in the order of `points`. */
  readonly weights?: readonly number[];
}

const fail = (message: string): never => {
  throw new TypeError(message);
};

export class StepWriter {
  private readonly lines: string[] = [];
  private next = 100;
  private readonly styled: string[] = [];

  /** Lines of entities reserved and not yet filled, by id. */
  private readonly reserved = new Map<string, number>();

  /** Adds an entity (its text without the id) and returns its id, such as '#123'. */
  add(entity: string): string {
    const id = `#${this.next++}`;
    this.lines.push(`${id}=${entity};`);
    return id;
  }
  /** An id for an entity written later with {@link StepWriter.fill}; one never filled is left out of the file. */
  reserve(): string {
    const id = `#${this.next++}`;
    this.reserved.set(id, this.lines.push('') - 1);
    return id;
  }
  fill(id: string, entity: string): void {
    const at = this.reserved.get(id);
    if (at === undefined) fail(`StepWriter: ${id} was not reserved`);
    this.lines[at!] = `${id}=${entity};`;
    this.reserved.delete(id);
  }
  /** The entities so far as a STEP file, for evaluating converted geometry before the conversion finishes. */
  draft(): string {
    return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${this.lines.filter(Boolean).join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
  }
  /** A STEP real: a decimal point always, before any exponent. */
  real(v: number): string {
    if (!Number.isFinite(v)) fail('Invalid model: a coordinate or size is not finite');
    const s = v
      .toPrecision(17)
      .replace(/(\.\d*?)0+(e|$)/, '$1$2')
      .replace(/\.(e|$)/, '.0$1');
    return s.includes('.') ? s.replace('e', 'E') : `${s}.`;
  }
  point(p: readonly number[]): string {
    return this.add(`CARTESIAN_POINT('',(${p.map((v) => this.real(v)).join(',')}))`);
  }
  direction(d: readonly number[]): string {
    return this.add(`DIRECTION('',(${d.map((v) => this.real(v)).join(',')}))`);
  }
  /** AXIS2_PLACEMENT_3D at `origin`, z axis `z`, x towards `x` (made perpendicular; any perpendicular when parallel). */
  axis(origin: readonly number[], z: readonly number[], x: readonly number[]): string {
    const zl = Math.hypot(z[0], z[1], z[2]);
    if (!(zl > 0)) fail('Invalid model: an axis has zero length');
    const zz = z.map((v) => v / zl),
      along = x[0] * zz[0] + x[1] * zz[1] + x[2] * zz[2],
      px = [x[0] - along * zz[0], x[1] - along * zz[1], x[2] - along * zz[2]],
      l = Math.hypot(px[0], px[1], px[2]),
      unit = (a: number[]) => {
        const n = Math.hypot(a[0], a[1], a[2]);
        return a.map((v) => v / n);
      };
    const ref =
      l > 1e-12
        ? px.map((v) => v / l)
        : Math.abs(zz[0]) < 0.9
          ? unit([1 - zz[0] * zz[0], -zz[0] * zz[1], -zz[0] * zz[2]])
          : unit([-zz[1] * zz[0], 1 - zz[1] * zz[1], -zz[1] * zz[2]]);
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.direction(zz)},${this.direction(ref)})`);
  }
  /** A B-spline curve (one degree) or surface (two degrees), rational when it has weights. */
  spline(s: WriterSpline): string {
    const surface = s.degrees.length === 2,
      pts = s.points.map((p) => this.point(p));
    if (pts.length !== s.counts.reduce((a, b) => a * b, 1))
      fail('Invalid model: a spline has the wrong number of points');
    const grid = <T>(at: (k: number) => T) =>
      `(${Array.from({ length: s.counts[0] }, (_, i) => `(${Array.from({ length: s.counts[1] }, (_, j) => at(j * s.counts[0] + i)).join(',')})`).join(',')})`;
    const list = surface ? grid((k) => pts[k]) : `(${pts.join(',')})`,
      knots = s.knots.map((k) => `(${k.map((v) => this.real(v)).join(',')})`),
      mults = s.multiplicities.map((m) => `(${m.join(',')})`);
    if (surface) {
      const body = `${s.degrees[0]},${s.degrees[1]},${list},.UNSPECIFIED.,.F.,.F.,.F.`,
        withKnots = `${mults[0]},${mults[1]},${knots[0]},${knots[1]},.UNSPECIFIED.`;
      if (!s.weights) return this.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${body},${withKnots})`);
      return this.add(
        `(BOUNDED_SURFACE()B_SPLINE_SURFACE(${body})B_SPLINE_SURFACE_WITH_KNOTS(${withKnots})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${grid((k) => this.real(s.weights![k]))})REPRESENTATION_ITEM('')SURFACE())`,
      );
    }
    const body = `${s.degrees[0]},${list},.UNSPECIFIED.,.F.,.F.`,
      withKnots = `${mults[0]},${knots[0]},.UNSPECIFIED.`;
    if (!s.weights) return this.add(`B_SPLINE_CURVE_WITH_KNOTS('',${body},${withKnots})`);
    return this.add(
      `(BOUNDED_CURVE()B_SPLINE_CURVE(${body})B_SPLINE_CURVE_WITH_KNOTS(${withKnots})CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE((${s.weights.map((v) => this.real(v)).join(',')}))REPRESENTATION_ITEM(''))`,
    );
  }
  /**
   * A shape representation of `items` (with an origin placement) that mapped items can place: returns the map, for
   * {@link StepWriter.place}.
   */
  shape(items: readonly string[]): string {
    const origin = this.axis([0, 0, 0], [0, 0, 1], [1, 0, 0]),
      representation = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[...items, origin].join(',')}),#10)`);
    return this.add(`REPRESENTATION_MAP(${origin},${representation})`);
  }
  /** A mapped item placing a {@link StepWriter.shape} at `origin` with axes `z` and `x`. */
  place(map: string, origin: readonly number[], z: readonly number[], x: readonly number[]): string {
    return this.add(`MAPPED_ITEM('',${map},${this.axis(origin, z, x)})`);
  }
  /** Gives `item` (a face or body) a surface colour, red, green and blue in 0..1. */
  style(item: string, rgb: readonly number[]): void {
    const colour = this.add(`COLOUR_RGB('',${rgb.map((v) => this.real(v)).join(',')})`),
      fill = this.add(`FILL_AREA_STYLE('',(${this.add(`FILL_AREA_STYLE_COLOUR('',${colour})`)}))`),
      side = this.add(`SURFACE_SIDE_STYLE('',(${this.add(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`),
      usage = this.add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`),
      assignment = this.add(`PRESENTATION_STYLE_ASSIGNMENT((${usage}))`);
    this.styled.push(this.add(`STYLED_ITEM('',(${assignment}),${item})`));
  }
  /**
   * The finished file: one product whose shape holds `items` (solids, shell models, mapped items), lengths in
   * millimetres or metres.
   */
  finish(items: readonly string[], { unit, source }: { unit: 'mm' | 'm'; source: string }): string {
    if (!items.length) fail('Invalid model: no body with faces');
    const representation = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${items.join(',')},#12),#10)`);
    this.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,${representation})`);
    if (this.styled.length)
      this.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${this.styled.join(',')}),#10)`);
    return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('converted from ${source.replace(/'/g, "''")}'),'2;1');
FILE_NAME('model.stp','',(''),(''),'Margo kernel','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('part','part','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${unit === 'mm' ? '.MILLI.' : '$'},.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
${this.lines.filter(Boolean).join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  }
}
