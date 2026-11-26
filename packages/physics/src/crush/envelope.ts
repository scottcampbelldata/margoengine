import { MargoError } from '@margoengine/math/errors';
import type { CompressionStep } from './continuous.js';
import { crushResultAtPeak, positive, type CrushResult, type CrushStrokeResult } from './material.js';

/** One measured point on the virgin force versus total compression envelope. */
export interface CrushLoadingPoint {
  readonly stroke: number;
  readonly force: number;
}

/** A staged crush envelope, including trigger peaks and their lower folding forces. */
export interface CrushEnvelope {
  /** Linear unloading stiffness in N/m. The first control point lies on this line. */
  readonly stiffness: number;
  /** At least two ordered points in metres and newtons, starting at first yield. */
  readonly loading: readonly CrushLoadingPoint[];
  /** Backing stiffness after the last control point. Default: the unloading stiffness. */
  readonly backingStiffness?: number;
}

interface Point extends CrushLoadingPoint {
  readonly permanent: number;
}

export interface PreparedEnvelope {
  readonly stiffness: number;
  readonly backingStiffness: number;
  readonly stroke: number;
  readonly points: readonly Point[];
}

interface Segment {
  readonly from: Point;
  readonly to: Point;
  readonly slope: number;
}

export function prepareEnvelope(material: CrushEnvelope): PreparedEnvelope {
  const stiffness = positive(material.stiffness, 'unloading stiffness');
  const backingStiffness = positive(material.backingStiffness ?? stiffness, 'backing stiffness', stiffness);
  if (!Array.isArray(material.loading) || material.loading.length < 2)
    throw new MargoError('state', 'Give the crush envelope at least two loading points.');
  let lastStroke = 0;
  let lastPermanent = -1;
  let lastForce = 0;
  const loading = material.loading.map((entry, index) => {
    const force = positive(entry.force, 'envelope force');
    const supplied = positive(entry.stroke, 'envelope stroke');
    const recovered = force / stiffness; // float division: unloading displacement
    if (index === 0 && Math.abs(supplied - recovered) > 1e-12 * supplied)
      throw new MargoError(
        'state',
        'Place the first crush envelope point at yield. Set its stroke to force / stiffness.',
      );
    const stroke = index === 0 ? recovered : supplied;
    const permanent = stroke - recovered;
    const slope = (force - lastForce) / (stroke - lastStroke); // float division: envelope tangent
    if (!(stroke > lastStroke && permanent > lastPermanent) || !Number.isFinite(force * stroke + Math.abs(slope)))
      throw new MargoError(
        'state',
        'Use increasing total and permanent strokes and representable work in the crush envelope.',
      );
    lastStroke = stroke;
    lastPermanent = permanent;
    lastForce = force;
    return { stroke, force, permanent };
  });
  return { stiffness, backingStiffness, stroke: lastPermanent, points: loading };
}

function segment(from: Point, to: Point): Segment {
  return { from, to, slope: (to.force - from.force) / (to.stroke - from.stroke) }; // float division
}

/** Elastic reload, remaining measured stages, then compacted elastic support. */
function* segments(envelope: PreparedEnvelope, prior: number): Generator<Segment> {
  const points = envelope.points;
  const next = points.findIndex((point) => point.permanent > prior);
  let yieldPoint: Point;
  if (next < 0) {
    yieldPoint = points.at(-1)!;
  } else {
    const b = points[next]!;
    const a = points[next - 1]!;
    const blend = (prior - a.permanent) / (b.permanent - a.permanent); // float division
    const force = a.force + blend * (b.force - a.force);
    yieldPoint = { permanent: prior, force, stroke: prior + force / envelope.stiffness }; // float division
  }
  yield segment({ permanent: prior, force: 0, stroke: prior }, yieldPoint);
  if (next >= 0) {
    if (yieldPoint.stroke < points[next]!.stroke) yield segment(yieldPoint, points[next]!);
    for (let i = next + 1; i < points.length; i++) yield segment(points[i - 1]!, points[i]!);
  }
  yield {
    from: points.at(-1)!,
    to: { stroke: Infinity, force: Infinity, permanent: envelope.stroke },
    slope: envelope.backingStiffness,
  };
}

function finishStroke(k: number, part: Segment, delta: number, previousWork: number): CrushStrokeResult {
  const { from, to, slope } = part;
  if (to.stroke === Infinity) {
    const force = from.force + slope * delta;
    const elasticEnergy = 0.5 * from.force * (from.force / k) + delta * (from.force + 0.5 * slope * delta); // float division
    return { force, permanentStroke: from.permanent, absorbedEnergy: previousWork, elasticEnergy };
  }
  const width = to.stroke - from.stroke;
  const blend = Math.min(1, delta / width); // float division
  const plastic = (to.permanent - from.permanent) * blend;
  const force = (1 - blend) * from.force + blend * to.force;
  const absorbedEnergy = previousWork + (0.5 * from.force + 0.5 * force) * plastic;
  const elasticEnergy = 0.5 * force * (force / k); // float division
  return { force, permanentStroke: from.permanent + plastic, absorbedEnergy, elasticEnergy };
}

function absorbed(part: Segment): number {
  return (0.5 * part.from.force + 0.5 * part.to.force) * (part.to.permanent - part.from.permanent);
}

function checkStroke(result: CrushStrokeResult): void {
  if (!(result.force >= 0 && Number.isFinite(result.force + result.absorbedEnergy + result.elasticEnergy)))
    throw new MargoError('state', 'Choose a representable combination of envelope stroke, force and stiffness.');
}

export function stepEnvelope(
  material: PreparedEnvelope,
  prior: number,
  current: number,
  speed: number,
  inverseMass: number,
  dt: number,
): CompressionStep | undefined {
  const free = current + dt * speed;
  if (free <= prior || dt === 0) return undefined;
  const compliance = dt * dt * inverseMass;
  let work = 0;
  for (const part of segments(material, prior)) {
    const { from, to, slope } = part;
    const denominator = 1 + compliance * slope;
    if (!(denominator > 0))
      throw new MargoError('state', 'Increase crush rate so the step resolves the falling load in the envelope.');
    if (to.stroke === Infinity || free <= to.stroke + compliance * to.force) {
      const delta = (free - from.stroke - compliance * from.force) / denominator; // float division
      const result = finishStroke(material.stiffness, part, Math.max(0, delta), work);
      checkStroke(result);
      const totalStroke = from.stroke + Math.max(0, delta);
      const impulse = dt * result.force;
      if (!Number.isFinite(totalStroke + impulse))
        throw new MargoError('state', 'Choose representable mass and time step for the crush envelope.');
      return { ...result, totalStroke, impulse };
    }
    work += absorbed(part);
  }
  return undefined;
}

export function envelopeImpact(
  material: PreparedEnvelope,
  effectiveMass: number,
  closingSpeed: number,
  prior: number,
): CrushResult {
  const energy = 0.5 * effectiveMass * closingSpeed * closingSpeed;
  let remaining = energy;
  let peak = 0;
  for (const part of segments(material, prior)) {
    const { from, to, slope } = part;
    const capacity = (0.5 * from.force + 0.5 * to.force) * (to.stroke - from.stroke);
    if (remaining <= capacity) {
      const magnitude = Math.SQRT2 * Math.sqrt(Math.abs(slope)) * Math.sqrt(remaining);
      const scale = Math.max(from.force, magnitude);
      const u = scale > 0 ? from.force / scale : 0; // float division: normalized incident force
      const m = scale > 0 ? magnitude / scale : 0; // float division: normalized slope term
      const radical = scale * Math.sqrt(Math.max(0, u * u + Math.sign(slope) * m * m));
      const delta = remaining === 0 ? 0 : remaining / (0.5 * from.force + 0.5 * radical); // float division: work inversion
      const result = finishStroke(material.stiffness, part, delta, 0);
      return crushResultAtPeak(energy, effectiveMass, closingSpeed, {
        force: Math.max(peak, result.force),
        distance: from.stroke + delta,
        permanent: result.permanentStroke,
        elastic: result.elasticEnergy,
      });
    }
    peak = Math.max(peak, to.force);
    remaining -= capacity;
  }
  throw new MargoError('state', 'Choose a representable incident energy for the crush envelope.');
}

/** Evaluates the staged load and incremental work at an imposed total compression. */
export function resolveCrushEnvelopeStroke(
  material: CrushEnvelope,
  totalStroke: number,
  permanentStroke = 0,
): CrushStrokeResult {
  const envelope = prepareEnvelope(material);
  const stroke = positive(totalStroke, 'total stroke', 0);
  const prior = positive(permanentStroke, 'prior permanent stroke', 0, envelope.stroke);
  if (stroke <= prior) return { force: 0, permanentStroke: prior, absorbedEnergy: 0, elasticEnergy: 0 };
  let work = 0;
  for (const part of segments(envelope, prior)) {
    if (stroke <= part.to.stroke) {
      const result = finishStroke(envelope.stiffness, part, stroke - part.from.stroke, work);
      checkStroke(result);
      return result;
    }
    work += absorbed(part);
  }
  throw new MargoError('state', 'Choose a representable imposed stroke for the crush envelope.');
}

/** Evaluates work and recoil of a single normal impact against a staged crush envelope. */
export function resolveCrushEnvelope(
  material: CrushEnvelope,
  effectiveMass: number,
  closingSpeed: number,
  permanentStroke = 0,
): CrushResult {
  const envelope = prepareEnvelope(material);
  return envelopeImpact(
    envelope,
    positive(effectiveMass, 'effective normal mass'),
    positive(closingSpeed, 'closing speed', 0),
    positive(permanentStroke, 'prior permanent stroke', 0, envelope.stroke),
  );
}
