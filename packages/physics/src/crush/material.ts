import { MargoError } from '@margoengine/math/errors';
import { hypot, pow } from '@margoengine/math/pinned';

/** Measured loading-curve data for a civilian energy-absorbing member. */
export interface CrushMaterial {
  /** Small-strain unloading stiffness, N/m. */
  readonly stiffness: number;
  /** Force at the first permanent deformation, N. */
  readonly yieldForce: number;
  /** Increase in yield force per metre of permanent stroke, N/m. Default 0. */
  readonly hardening?: number;
  /** Total permanent stroke available to the member, m. */
  readonly stroke: number;
  /** Elastic backing stiffness after the member has fully compacted, N/m. Default: unloading stiffness. */
  readonly backingStiffness?: number;
}

/** Work and deformation at the turning point of a one-dimensional normal impact. */
export interface CrushResult {
  /** Incident energy in the relative normal motion, J. */
  readonly incidentEnergy: number;
  /** Work retained in permanent deformation in this impact, J. */
  readonly absorbedEnergy: number;
  /** Elastic energy returned to the two bodies on release, J. */
  readonly elasticEnergy: number;
  /** Total permanent offset after release, m. */
  readonly permanentStroke: number;
  /** Largest total normal stroke from the undeformed geometry, m. */
  readonly peakStroke: number;
  /** Highest compressive force on the loading curve, N. */
  readonly peakForce: number;
  /** Relative speed on elastic release, m/s. */
  readonly reboundSpeed: number;
  /** Normal separating impulse transferred between the two bodies, N s. */
  readonly impulse: number;
}

/** Properties of a short square tube loaded axially in its progressive-folding regime. */
export interface SquareCrushTube {
  /** Width across the outside flats, m. */
  readonly width: number;
  /** Wall thickness, m. */
  readonly thickness: number;
  /** Length between the supports, m. */
  readonly length: number;
  /** Young's modulus of the wall material, Pa. */
  readonly young: number;
  /** Tensile proof stress of the wall material, Pa. */
  readonly yieldStress: number;
  /** Ultimate tensile strength of the wall material, Pa. */
  readonly tensileStrength: number;
}

/** Loading-envelope state after imposing a normal stroke. */
export interface CrushStrokeResult {
  /** Compressive force, N. */
  readonly force: number;
  /** Permanent stroke retained after release, m. */
  readonly permanentStroke: number;
  /** Incremental permanent work, J. */
  readonly absorbedEnergy: number;
  /** Recoverable elastic energy at the supplied stroke, J. */
  readonly elasticEnergy: number;
}

export function positive(value: number, name: string, minimum = Number.MIN_VALUE, maximum = Infinity): number {
  if (!(Number.isFinite(value) && value >= minimum && value <= maximum))
    throw new MargoError('state', `Choose crush ${name} as a finite value in [${minimum}, ${maximum}].`);
  return value;
}

export function crushMaterial(input: CrushMaterial): Required<CrushMaterial> {
  const stiffness = positive(input.stiffness, 'stiffness');
  const material = {
    stiffness,
    yieldForce: positive(input.yieldForce, 'yield force'),
    hardening: positive(input.hardening ?? 0, 'hardening', 0),
    stroke: positive(input.stroke, 'permanent stroke'),
    backingStiffness: positive(input.backingStiffness ?? stiffness, 'backing stiffness', stiffness),
  };
  const capacityForce = material.yieldForce + material.hardening * material.stroke;
  const compliance = capacityForce / stiffness; // float division: elastic stroke
  if (!Number.isFinite(stiffness + material.hardening + capacityForce * compliance))
    throw new MargoError('state', 'Choose smaller crush material values so their force and work remain representable.');
  return material;
}

/** Builds a reduced mean folding curve for a short square hollow tube from geometry and tensile data. */
export function squareTubeCrushMaterial(tube: SquareCrushTube): Required<CrushMaterial> {
  const width = positive(tube.width, 'tube width');
  const thickness = positive(tube.thickness, 'tube wall thickness');
  if (!(2 * thickness < width))
    throw new MargoError('state', 'Choose a wall thickness below half the square tube width.');
  const length = positive(tube.length, 'tube free length');
  const young = positive(tube.young, 'tube Young’s modulus');
  const yieldStress = positive(tube.yieldStress, 'tube proof stress');
  const tensile = positive(tube.tensileStrength, 'tube tensile strength', yieldStress);
  const flow = 0.5 * yieldStress + 0.5 * tensile;
  const area = 4 * thickness * (width - thickness);
  const stiffness = (young * area) / length; // float division: axial stiffness EA/L
  // Wierzbicki–Abramowicz (1983), equation 7.4. The factor has no units.
  const yieldForce = 9.56 * flow * thickness * pow(thickness, 2 / 3) * pow(width, 1 / 3); // float division
  return crushMaterial({ stiffness, yieldForce, stroke: 0.73 * length });
}

/** Evaluates incremental work and load at an imposed total normal stroke, measured from the undeformed shape. */
export function resolveCrushStroke(
  material: CrushMaterial,
  totalStroke: number,
  permanentStroke = 0,
): CrushStrokeResult {
  const curve = crushMaterial(material);
  const position = positive(totalStroke, 'total stroke', 0);
  const prior = positive(permanentStroke, 'prior permanent stroke', 0, curve.stroke);
  return crushStrokePrepared(curve, position, prior);
}

/** Applies the compression-only material return map to a validated contact curve. */
export function crushStrokePrepared(
  material: Required<CrushMaterial>,
  position: number,
  prior: number,
): CrushStrokeResult {
  const { stiffness: k, yieldForce, hardening, stroke, backingStiffness } = material;
  const loading = Math.max(0, position - prior);
  const priorForce = yieldForce + hardening * prior;
  const yieldOffset = priorForce / k; // float division: recoverable stroke at yield
  const trial = Math.max(0, loading - yieldOffset) * (k / (k + hardening)); // float division: plastic share
  const permanent = Math.min(stroke, prior + trial);
  const plastic = permanent - prior;
  const flow = priorForce + hardening * plastic;
  const elastic = loading - plastic;
  const cap = flow / k; // float division: recoverable stroke at the end of plastic flow
  const past = permanent === stroke ? Math.max(0, elastic - cap) : 0;
  const spring = past > 0 ? cap : elastic;
  const direct = plastic > 0 ? flow : k * spring;
  const force = direct + backingStiffness * past;
  const stored = 0.5 * direct * spring + past * (direct + 0.5 * backingStiffness * past);
  const work = (priorForce + 0.5 * hardening * plastic) * plastic;
  if (!Number.isFinite(force + stored + work))
    throw new MargoError('state', 'Choose a representable combination of crush stroke and material stiffness.');
  return { force, permanentStroke: permanent, absorbedEnergy: work, elasticEnergy: stored };
}

function distance(energy: number, force: number, stiffness: number): number {
  // Rationalized root of W = F dx + k dx²/2. This form retains small excursions from a large pre-load.
  return energy / (0.5 * force + 0.5 * hypot(force, Math.SQRT2 * Math.sqrt(stiffness) * Math.sqrt(energy))); // float division: work inversion
}

interface PeakLoad {
  readonly force: number;
  readonly permanent: number;
  readonly distance: number;
  readonly elastic: number;
}

function peakLoad(material: Required<CrushMaterial>, prior: number, energy: number): PeakLoad {
  const { stiffness: k, yieldForce, hardening, stroke, backingStiffness } = material;
  const yieldAtPrior = yieldForce + hardening * prior;
  const elasticLimit = yieldAtPrior / k; // float division: stroke at yield
  const energyAtYield = 0.5 * yieldAtPrior * elasticLimit;
  if (energy <= energyAtYield) {
    const displacement = Math.sqrt((2 * energy) / k); // float division: inverse spring work
    return { force: k * displacement, permanent: prior, distance: prior + displacement, elastic: energy };
  }
  const plasticShare = k / (k + hardening); // float division: plastic part of the incremental stroke
  const tangent = hardening * plasticShare;
  const compaction = (stroke - prior) / plasticShare; // float division: stroke to bottoming
  const energyAtCompaction = compaction * (yieldAtPrior + 0.5 * tangent * compaction);
  const available = energy - energyAtYield;
  const flowDistance = Math.min(compaction, distance(Math.min(available, energyAtCompaction), yieldAtPrior, tangent));
  const flowForce = yieldAtPrior + tangent * flowDistance;
  const elasticAtFlow = 0.5 * flowForce * (flowForce / k); // float division: recoverable unloading work
  const pastCompaction = available - energyAtCompaction;
  if (pastCompaction <= 0) {
    const permanent = Math.min(stroke, prior + flowDistance * plasticShare);
    return { force: flowForce, permanent, distance: prior + elasticLimit + flowDistance, elastic: elasticAtFlow };
  }
  const backing = distance(pastCompaction, flowForce, backingStiffness);
  return {
    force: flowForce + backingStiffness * backing,
    permanent: stroke,
    distance: prior + elasticLimit + compaction + backing,
    elastic: elasticAtFlow + pastCompaction,
  };
}

export function crushPrepared(
  material: Required<CrushMaterial>,
  effectiveMass: number,
  closingSpeed: number,
  prior: number,
): CrushResult {
  const energy = 0.5 * effectiveMass * closingSpeed * closingSpeed;
  const peak = peakLoad(material, prior, energy);
  const elasticEnergy = Math.min(peak.elastic, energy);
  const reboundSpeed = Math.sqrt((2 * elasticEnergy) / effectiveMass); // float division: energy returned to relative motion
  const impulse = effectiveMass * (closingSpeed + reboundSpeed);
  if (!Number.isFinite(energy + peak.force + peak.distance + impulse))
    throw new MargoError('state', 'Choose a representable mass, closing speed, and measured crush response.');
  return {
    incidentEnergy: energy,
    absorbedEnergy: energy - elasticEnergy,
    elasticEnergy,
    permanentStroke: peak.permanent,
    peakStroke: peak.distance,
    peakForce: peak.force,
    reboundSpeed,
    impulse,
  };
}

/** Computes the peak, permanent work and recoil of a single normal impact from a measured force-displacement curve. */
export function resolveCrush(
  material: CrushMaterial,
  effectiveMass: number,
  closingSpeed: number,
  permanentStroke = 0,
): CrushResult {
  const ready = crushMaterial(material);
  return crushPrepared(
    ready,
    positive(effectiveMass, 'effective normal mass'),
    positive(closingSpeed, 'closing speed', 0),
    positive(permanentStroke, 'prior permanent stroke', 0, ready.stroke),
  );
}
