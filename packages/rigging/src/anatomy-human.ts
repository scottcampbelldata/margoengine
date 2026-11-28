// The human table for `@margoengine/rigging/anatomy`: every joint of the body in ISO/IEC 19774 (HAnim) names, with its
// kind, neutral pose, motion axes and ranges of motion in two tiers, each number with the source it was read from and
// how it was checked, plus body proportions, segment masses, coupled motions and the bone names of common rigs.
//
// Names, hierarchy and the neutral pose: ISO/IEC 19774-1:2019, Humanoid animation (HAnim), part 1, clause 4.8.2
// ("standing ... facing in the +Z direction with +Y up and +X to the humanoid's left ... arms ... straight and parallel
// to the sides of the body with the palms of the hands facing inwards towards the thighs") and figures 4.10 to 4.13.
// The table holds the 139 joints of the body in figure 4.13 (level of articulation 4); the 7 joints of the face there
// (eyelids, eyeballs, eyebrows, jaw) belong to the face rig.
//
// Motion axes follow the ISB recommendations (Wu et al. 2002 and 2005; Grood and Suntay 1983): a flexion axis across
// the body, an abduction axis fore and aft, and rotation about the segment's long axis, each written out in the body
// frame so that a right-hand turn about it is the motion its name says.
//
// Ranges. The limb motions the CDC Normal Joint Range of Motion Study measured (Soucie et al. 2011) come straight from
// that dataset (anatomy-data-cdc.ts): the mean of adults of 20 to 44 years, the larger of the two sexes. Every other
// range is the AAOS 1965 value as a readable page reproduces it, with the AMA Guides (5th edition) value beside it.
// Where no readable page gives a number it is marked `recalled`, to be confirmed in print. The stop (the structural
// tier) of each motion is its largest source value rounded up to 5 degrees plus the allowance its row states: 15 for
// the swing or twist of a ball, saddle or condyloid joint and for a spine region, 10 for a hinge's flexion, 0 for the
// straight side of a hinge. Proportions come from the ANSUR II summary statistics (anatomy-data-ansur2.ts), segment
// masses from de Leva 1996 (anatomy-data-deleva.ts). No table, image or code of another program was read.
import {
  bound,
  defineSpecies,
  fitAnatomy,
  mirrorJoint,
  type AnatomicalRig,
  type Bound,
  type CouplingHook,
  type DofSpec,
  type FitOptions,
  type JointAngles,
  type JointNaming,
  type JointSpec,
  type ProportionNorm,
  type Provenance,
  type RegionSpec,
  type SegmentNorm,
  type SourceEntry,
  type SourceRow,
  type SpeciesTable,
  type Vec3,
} from './anatomy.js';
import { ANSUR2, ANSUR2_FILE, type ANSUR2Dimension } from './anatomy-data-ansur2.js';
import { CDC_FILE, cdcMean, type CDCAge, type CDCMotion } from './anatomy-data-cdc.js';
import { DE_LEVA_1996, DE_LEVA_FILE, type DeLevaSegmentName } from './anatomy-data-deleva.js';
import { detectSkeleton, humanoidBones, type SkeletonPreset } from './retarget.js';
import type { RigJoint, RigPose } from './rig.js';

// The datasets the table is built from, for anything else that needs the measured numbers.
export { ANSUR2, ANSUR2_FEMALES, ANSUR2_MALES, type ANSUR2Dimension, type ANSUR2Row } from './anatomy-data-ansur2.js';
export {
  CDC_AGES,
  CDC_MOTIONS,
  CDC_RANGE_OF_MOTION,
  type CDCAge,
  type CDCCell,
  type CDCMotion,
} from './anatomy-data-cdc.js';
export { DE_LEVA_1996, type DeLevaSegment, type DeLevaSegmentName } from './anatomy-data-deleva.js';

const HENDRIKS = 'https://cdn-links.lww.com/permalink/prsgo/b/prsgo_8_6_2020_04_17_hendriks_gox-d-20-00155r2_sdc1.pdf',
  OTBENCH = 'https://theotbench.com/rom/',
  GONIOMETER = 'https://goniometer.io/range-of-motion',
  WORKSHEET = 'https://workcompce.com/wp-content/uploads/2014/06/Guides_2014.pdf',
  DSHS = 'https://www.dshs.wa.gov/sites/default/files/FORMS/pdf/13-585a.pdf',
  MCCLURE = 'https://pages.uoregon.edu/biomech/obl/articles/2001_mcclure_jses2001.pdf',
  EUROPE_PMC = 'https://europepmc.org/article/MED/',
  LUMBAR_TABLE = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3699246/table/TB04006-3/',
  THORACIC_TABLE = 'https://musculoskeletalkey.com/of-the-spine/',
  PUBMED = 'https://pubmed.ncbi.nlm.nih.gov/',
  WINTER = 'https://courses.grainger.illinois.edu/me481/sp2021/Anthro-Winter.pdf';

const SOURCES: Readonly<Record<string, SourceEntry>> = {
  hanim: {
    cite: 'ISO/IEC 19774-1:2019, Information technology, Computer graphics, image processing and environmental data representation, Humanoid animation (HAnim), Part 1: Architecture',
    url: 'https://www.web3d.org/documents/specifications/19774/V2.0/Architecture/concepts.html',
  },
  isb2002: {
    cite: 'Wu G et al. 2002, ISB recommendation on definitions of joint coordinate system of various joints for the reporting of human joint motion, part I: ankle, hip, and spine, J Biomech 35(4):543-548',
    url: 'https://doi.org/10.1016/S0021-9290(01)00222-6',
  },
  isb2005: {
    cite: 'Wu G et al. 2005, ISB recommendation on definitions of joint coordinate systems of various joints for the reporting of human joint motion, part II: shoulder, elbow, wrist and hand, J Biomech 38(5):981-992',
    url: 'https://doi.org/10.1016/j.jbiomech.2004.05.042',
  },
  grood1983: {
    cite: 'Grood ES, Suntay WJ 1983, A joint coordinate system for the clinical description of three-dimensional motions: application to the knee, J Biomech Eng 105(2):136-144',
    url: 'https://doi.org/10.1115/1.3138397',
  },
  cdc2011: {
    cite: 'Soucie JM et al. 2011, Range of motion measurements: reference values and a database for comparison studies, Haemophilia 17(3):500-507; the CDC Normal Joint Range of Motion Study table',
    url: 'https://archive.cdc.gov/www_cdc_gov/ncbddd/jointrom/index.html',
  },
  aaos1965: {
    cite: 'American Academy of Orthopaedic Surgeons 1965, Joint Motion: Method of Measuring and Recording (print); each value is as the page named with it reproduces it',
  },
  ama2000: {
    cite: 'Cocchiarella L, Andersson GBJ (eds) 2000, Guides to the Evaluation of Permanent Impairment, 5th ed., American Medical Association (print); each value is as the worksheet named with it reproduces it',
  },
  hendriks2020: {
    cite: 'Hendriks et al. 2020, Plast Reconstr Surg Glob Open 8(6), supplemental content 1: normal range of motion values according to AAOS, with the values its authors added to that list',
    url: HENDRIKS,
  },
  dshs: {
    cite: 'Washington State Department of Social and Health Services, Range of Joint Motion Evaluation Chart, form 13-585A',
    url: DSHS,
  },
  paraskevas2004: {
    cite: 'Paraskevas G et al. 2004, Study of the carrying angle of the human elbow joint in full extension: a morphometric analysis, Surg Radiol Anat 26:19-23',
    url: 'https://doi.org/10.1007/s00276-003-0185-z',
  },
  inman1944: {
    cite: 'Inman VT, Saunders JB, Abbott LC 1944, Observations on the function of the shoulder joint, J Bone Joint Surg 26(1):1-30, as reported by McClure et al. 2001, J Shoulder Elbow Surg, and by the open paper named with each value',
    url: MCCLURE,
  },
  ludewig2009: {
    cite: 'Ludewig PM et al. 2009, Motion of the shoulder complex during multiplanar humeral elevation, J Bone Joint Surg Am 91(2):378-389',
    url: 'https://doi.org/10.2106/JBJS.G.01483',
  },
  white1990: {
    cite: 'White AA, Panjabi MM 1990, Clinical Biomechanics of the Spine, 2nd ed., Lippincott (print): representative rotations at each level',
  },
  pearcy1984: {
    cite: 'Pearcy MJ, Tibrewal SB 1984, Axial rotation and lateral bending in the normal lumbar spine measured by three-dimensional radiography, Spine 9(6):582-587',
    url: `${PUBMED}6495028/`,
  },
  bogduk2000: {
    cite: 'Bogduk N, Mercer S 2000, Biomechanics of the cervical spine I: normal kinematics, Clin Biomech 15(9):633-648',
    url: `${PUBMED}10946096/`,
  },
  kapandji: { cite: 'Kapandji IA, The Physiology of the Joints, vols 1 to 3 (print)' },
  bennell1998: {
    cite: 'Bennell K et al. 1998, Intra-rater and inter-rater reliability of a weight-bearing lunge measure of ankle dorsiflexion, Aust J Physiother 44(3):175-180 (print)',
  },
  rijpkema1991: {
    cite: 'Rijpkema H, Girard M 1991, Computer animation of knowledge-based human grasping, SIGGRAPH 91 (print)',
  },
  ansur2: {
    cite: 'Gordon CC et al., 2012 Anthropometric Survey of U.S. Army Personnel: Methods and Summary Statistics, NATICK/TR-15/007',
    url: 'https://tools.openlab.psu.edu/publicData/ANSURII-TR15-007.pdf',
  },
  winter2009: {
    cite: 'Drillis R, Contini R 1966, Body Segment Parameters, report 1166.03, New York University, as figure 4.1 of Winter DA 2009, Biomechanics and Motor Control of Human Movement, 4th ed., Wiley',
    url: WINTER,
  },
  deleva1996: {
    cite: "de Leva P 1996, Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters, J Biomech 29(9):1223-1230, table 4",
    url: 'https://doi.org/10.1016/0021-9290(95)00178-6',
  },
};

const row = (source: string, value: number, what: string, provenance: Provenance, via?: string): SourceRow => ({
  source,
  value,
  what,
  provenance,
  ...(via ? { via } : {}),
});
const aaos = (value: number, what: string, via = HENDRIKS) => row('aaos1965', value, what, 'online', via);
const ama = (value: number, what: string) => row('ama2000', value, what, 'online', WORKSHEET);
const recalled = (source: string, value: number, what: string) => row(source, value, what, 'recalled');

const UP: Vec3 = [0, 1, 0],
  DOWN: Vec3 = [0, -1, 0],
  LEFT: Vec3 = [1, 0, 0],
  RIGHT: Vec3 = [-1, 0, 0],
  FRONT: Vec3 = [0, 0, 1],
  BACK: Vec3 = [0, 0, -1],
  SLANT: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2],
  SLANT_ACROSS: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
const dof = (
  axis: Vec3,
  positive: string,
  negative: string,
  max: Bound,
  min: Bound,
  extra: Partial<DofSpec> = {},
): DofSpec => ({
  axis,
  positive,
  negative,
  max,
  min,
  ...extra,
});
/** A direction a joint's kind does not allow, with the degrees a solver may leave there before the stop. */
const give = (degrees = 0): Bound => bound(degrees);
const other = (id: string): string =>
  id.startsWith('r_') ? `l_${id.slice(2)}` : id.startsWith('l_') ? `r_${id.slice(2)}` : id;

/** One motion segment of the spine: [joint, level, flexion plus extension, side bend to one side, rotation to one side], degrees. */
type SpineLevel = readonly [id: string, level: string, flexionExtension: number, sideBend: number, rotation: number];
/**
 * The spine's motion segments, proximal first, with the rotation each takes: the weights that share a region's
 * clinical range among its levels. Lumbar flexion plus extension of L1-L2 to L4-L5 is White and Panjabi 1990 as an
 * open paper tabulates it, and lumbar side bend and rotation are Pearcy and Tibrewal 1984 (abstract); L5-S1 flexion
 * plus extension, and every thoracic and cervical level, are White and Panjabi's representative values from recall.
 * The thoracic levels are scaled to that book's thoracic totals as a readable page gives them (62, 36 and 32.5
 * degrees): the per-level values were measured without the rib cage.
 */
export const HUMAN_SPINE_LEVELS: Readonly<Record<'lumbar' | 'thoracic' | 'cervical', readonly SpineLevel[]>> = {
  lumbar: [
    ['vl5', 'L5-S1', 17, 3, 2],
    ['vl4', 'L4-L5', 17, 6, 2],
    ['vl3', 'L3-L4', 15, 10, 2],
    ['vl2', 'L2-L3', 14, 10, 2],
    ['vl1', 'L1-L2', 12, 10, 2],
  ],
  thoracic: [
    ['vt12', 'T12-L1', 12, 8, 2],
    ['vt11', 'T11-T12', 12, 9, 2],
    ['vt10', 'T10-T11', 9, 7, 2],
    ['vt9', 'T9-T10', 6, 6, 4],
    ['vt8', 'T8-T9', 6, 6, 6],
    ['vt7', 'T7-T8', 6, 6, 7],
    ['vt6', 'T6-T7', 5, 6, 7],
    ['vt5', 'T5-T6', 4, 6, 8],
    ['vt4', 'T4-T5', 4, 6, 8],
    ['vt3', 'T3-T4', 4, 5, 8],
    ['vt2', 'T2-T3', 4, 6, 8],
    ['vt1', 'T1-T2', 4, 5, 9],
  ],
  cervical: [
    ['vc7', 'C7-T1', 9, 4, 2],
    ['vc6', 'C6-C7', 17, 7, 6],
    ['vc5', 'C5-C6', 20, 8, 7],
    ['vc4', 'C4-C5', 20, 11, 7],
    ['vc3', 'C3-C4', 15, 11, 7],
    ['vc2', 'C2-C3', 10, 10, 3],
    ['vc1', 'C1-C2', 20, 5, 40],
    ['skullbase', 'C0-C1', 25, 5, 5],
  ],
};
/** White and Panjabi's totals for the thoracic spine: flexion plus extension, side bend and rotation to one side. */
const THORACIC_TOTALS = [62, 36, 32.5] as const;
const MOTIONS = ['flexion plus extension', 'side bend to one side', 'rotation to one side'] as const;

/** Who a table is for. */
export interface HumanGroup {
  /** Uses that sex's rows of the range of motion study and of the anthropometric survey. Default: both. */
  readonly sex?: 'female' | 'male';
  /** Age in years: picks the study's age group (2 to 8, 9 to 19, 20 to 44, 45 to 69). Default 30. */
  readonly age?: number;
}

/**
 * The human table for one group of people: the range of motion study's rows for that sex and age, and the survey's
 * proportions for that sex. `human` is this with no group: adults of 20 to 44 years, the larger mean of the two sexes.
 * @example
 * import { humanTable } from '@margoengine/rigging/anatomy/human';
 * import { fitAnatomy } from '@margoengine/rigging/anatomy';
 *
 * const child = fitAnatomy(rig, { species: humanTable({ age: 6 }) });
 * @throws RangeError for an age that is not a positive number or a sex other than `female` or `male`.
 */
export function humanTable(group: HumanGroup = {}): SpeciesTable {
  const { sex } = group,
    years = group.age ?? 30;
  if (!(years > 0 && Number.isFinite(years)))
    throw new RangeError('humanTable: age must be a positive number of years');
  if (sex !== undefined && sex !== 'female' && sex !== 'male')
    throw new RangeError("humanTable: sex must be 'female' or 'male'");
  const age: CDCAge = years < 9 ? '2-8' : years < 20 ? '9-19' : years < 45 ? '20-44' : '45-69';
  const cdc = (motion: CDCMotion): SourceRow[] => {
    const one = (of: 'female' | 'male'): SourceRow => ({
      source: 'cdc2011',
      value: cdcMean(of, age, motion),
      what: `${motion}, ${of === 'female' ? 'women' : 'men'} ${age} years, mean`,
      provenance: 'dataset',
      file: CDC_FILE,
    });
    if (sex) return [one(sex)];
    const f = one('female'),
      m = one('male');
    return f.value >= m.value ? [f, m] : [m, f];
  };

  // The spine: each region's clinical range, shared among its levels by their weights.
  const trunkTotals: readonly [Bound, Bound, Bound, Bound] = [
      bound(
        15,
        aaos(80, 'thoracolumbar spine flexion', `${OTBENCH}spine`),
        row('dshs', 90, 'back flexion', 'online', DSHS),
      ),
      bound(15, aaos(25, 'thoracolumbar spine extension', `${OTBENCH}spine`), ama(25, 'lumbar spine extension')),
      bound(
        15,
        aaos(35, 'thoracolumbar spine lateral flexion, each side', `${OTBENCH}spine`),
        ama(25, 'lumbar spine lateral flexion, each side'),
      ),
      bound(
        15,
        aaos(45, 'thoracolumbar spine rotation, each side', `${OTBENCH}spine`),
        ama(30, 'thoracic spine rotation, each side'),
      ),
    ],
    neckTotals: readonly [Bound, Bound, Bound, Bound] = [
      bound(15, aaos(45, 'cervical spine flexion'), ama(50, 'cervical spine flexion')),
      bound(15, aaos(45, 'cervical spine extension'), ama(60, 'cervical spine extension')),
      bound(
        15,
        aaos(45, 'cervical spine lateral flexion, each side'),
        ama(45, 'cervical spine lateral flexion, each side'),
      ),
      bound(15, aaos(60, 'cervical spine rotation, each side'), ama(80, 'cervical spine rotation, each side')),
    ];
  const weigh = (
    part: keyof typeof HUMAN_SPINE_LEVELS,
    level: SpineLevel,
  ): { weight: number[]; rows: SourceRow[][] } => {
    const levels = HUMAN_SPINE_LEVELS[part],
      weight: number[] = [],
      rows: SourceRow[][] = [];
    for (let m = 0; m < 3; m++) {
      const value = level[2 + m] as number,
        what = `${level[1]} ${MOTIONS[m]}`;
      if (part === 'thoracic') {
        const sum = levels.reduce((total, each) => total + (each[2 + m] as number), 0);
        weight.push((THORACIC_TOTALS[m] * value) / sum);
        rows.push([
          row('white1990', THORACIC_TOTALS[m], `thoracic spine ${MOTIONS[m]}, total`, 'online', THORACIC_TABLE),
          recalled('white1990', value, `${what}, representative`),
        ]);
      } else if (part === 'cervical' || (m === 0 && level[0] === 'vl5')) {
        weight.push(value);
        rows.push([recalled('white1990', value, `${what}, representative`)]);
      } else {
        weight.push(value);
        rows.push([
          m === 0
            ? row('white1990', value, `${what}, representative`, 'online', LUMBAR_TABLE)
            : row('pearcy1984', value, `${what}, about`, 'online', `${PUBMED}6495028/`),
        ]);
      }
    }
    return { weight, rows };
  };
  const spine = (
    parts: readonly (keyof typeof HUMAN_SPINE_LEVELS)[],
    region: string,
    totals: readonly [Bound, Bound, Bound, Bound],
    above: string,
    reference?: string,
  ): JointSpec[] => {
    const all = parts.flatMap((part) => HUMAN_SPINE_LEVELS[part].map((level) => ({ level, ...weigh(part, level) }))),
      sums = [0, 1, 2].map((m) => all.reduce((total, each) => total + each.weight[m], 0));
    const part = (total: Bound, m: number, each: (typeof all)[number]): Bound => ({
      normal: (total.normal * each.weight[m]) / sums[m],
      structural: (total.structural * each.weight[m]) / sums[m],
      allowance: total.allowance,
      rows: [...total.rows, ...each.rows[m]],
      rule: "this level's share of the region's range, by its weight among the region's levels",
    });
    return all.map(
      (each, i): JointSpec => ({
        id: each.level[0],
        parent: i ? all[i - 1].level[0] : above,
        ...(i === 0 && reference ? { reference } : {}),
        segment: each.level[0] === 'skullbase' ? 'skull' : each.level[0].slice(1),
        kind: each.level[0] === 'vc1' ? 'pivot' : 'ball',
        side: 'centre',
        neutral: 'rest',
        long: UP,
        region,
        dofs: [
          dof(LEFT, 'flexion', 'extension', part(totals[0], 0, each), part(totals[1], 0, each)),
          dof(FRONT, 'right bend', 'left bend', part(totals[2], 1, each), part(totals[2], 1, each)),
          dof(UP, 'left rotation', 'right rotation', part(totals[3], 2, each), part(totals[3], 2, each)),
        ],
      }),
    );
  };
  const centre: JointSpec[] = [
    { id: 'humanoid_root', parent: null, segment: 'sacrum', kind: 'free', side: 'centre', neutral: 'rest', long: UP },
    {
      id: 'sacroiliac',
      parent: 'humanoid_root',
      segment: 'pelvis',
      kind: 'free',
      side: 'centre',
      neutral: 'rest',
      long: UP,
    },
    ...spine(['lumbar', 'thoracic'], 'trunk', trunkTotals, 'humanoid_root', 'sacroiliac'),
    ...spine(['cervical'], 'neck', neckTotals, 'vt1'),
  ];

  // The right side; the left is its mirror image.
  const foot = (
    id: string,
    parent: string,
    segment: string,
    flexion: Bound,
    extension: Bound,
    extra: Partial<JointSpec> = {},
  ): JointSpec => ({
    id,
    parent,
    segment,
    kind: 'glide',
    side: 'right',
    mirror: other(id),
    neutral: 'rest',
    long: FRONT,
    dofs: [
      dof(RIGHT, 'dorsiflexion', 'plantar flexion', flexion, extension),
      dof(DOWN, 'abduction', 'adduction', give(5), give(5)),
      dof(FRONT, 'inversion', 'eversion', give(5), give(5)),
    ],
    ...extra,
  });
  const toe = (
    id: string,
    parent: string,
    segment: string,
    kind: JointSpec['kind'],
    flexion: Bound,
    extension: Bound,
  ): JointSpec => ({
    id,
    parent,
    segment,
    kind,
    side: 'right',
    mirror: other(id),
    neutral: 'rest',
    long: FRONT,
    dofs: [
      dof(LEFT, 'flexion', 'extension', flexion, extension),
      dof(DOWN, 'abduction', 'adduction', give(kind === 'hinge' ? 5 : 10), give(kind === 'hinge' ? 5 : 10)),
      dof(FRONT, 'inversion', 'eversion', give(5), give(5)),
    ],
  });
  const leg: JointSpec[] = [
    {
      id: 'r_hip',
      parent: 'sacroiliac',
      segment: 'r_thigh',
      kind: 'ball',
      side: 'right',
      mirror: 'l_hip',
      neutral: 'body',
      long: DOWN,
      distal: ['r_knee'],
      dofs: [
        dof(
          RIGHT,
          'flexion',
          'extension',
          bound(15, ...cdc('hip flexion'), aaos(120, 'hip flexion'), ama(100, 'hip flexion')),
          bound(15, ...cdc('hip extension'), aaos(20, 'hip extension'), ama(30, 'hip extension')),
        ),
        dof(
          BACK,
          'abduction',
          'adduction',
          bound(15, aaos(40, 'hip abduction'), ama(40, 'hip abduction')),
          bound(15, aaos(20, 'hip adduction'), ama(20, 'hip adduction')),
        ),
        dof(
          UP,
          'internal rotation',
          'external rotation',
          bound(15, aaos(45, 'hip internal rotation', `${OTBENCH}hip-knee-ankle`), ama(40, 'hip internal rotation')),
          bound(15, aaos(45, 'hip external rotation', `${OTBENCH}hip-knee-ankle`), ama(50, 'hip external rotation')),
        ),
      ],
    },
    {
      id: 'r_knee',
      parent: 'r_hip',
      segment: 'r_calf',
      kind: 'hinge',
      side: 'right',
      mirror: 'l_knee',
      neutral: 'straight',
      long: DOWN,
      distal: ['r_talocrural'],
      dofs: [
        dof(
          LEFT,
          'flexion',
          'hyperextension',
          bound(10, ...cdc('knee flexion'), aaos(135, 'knee flexion'), ama(150, 'knee flexion')),
          bound(0, ...cdc('knee extension')),
        ),
        dof(BACK, 'valgus', 'varus', give(10), give(10)),
        dof(
          UP,
          'internal rotation',
          'external rotation',
          bound(10, recalled('kapandji', 30, 'tibial internal rotation, knee flexed 90 degrees')),
          bound(10, recalled('kapandji', 40, 'tibial external rotation, knee flexed 90 degrees')),
          { gate: { by: 0, from: 0, to: 90, floor: 5 } },
        ),
      ],
    },
    {
      id: 'r_talocrural',
      parent: 'r_knee',
      segment: 'r_talus',
      kind: 'hinge',
      side: 'right',
      mirror: 'l_talocrural',
      neutral: 'rest',
      long: FRONT,
      distal: ['r_metatarsophalangeal_2', 'r_metatarsophalangeal_1', 'r_metatarsophalangeal_3'],
      region: 'r_hindfoot',
      dofs: [
        dof(
          RIGHT,
          'dorsiflexion',
          'plantar flexion',
          bound(
            0,
            ...cdc('ankle dorsiflexion'),
            aaos(20, 'ankle dorsiflexion'),
            row('dshs', 20, 'ankle dorsal flexion', 'online', DSHS),
            recalled('bennell1998', 45, 'ankle dorsiflexion bearing weight in a lunge, about'),
          ),
          bound(
            10,
            ...cdc('ankle plantar flexion'),
            aaos(50, 'ankle plantar flexion'),
            row('dshs', 40, 'ankle plantar flexion', 'online', DSHS),
          ),
        ),
        dof(DOWN, 'abduction', 'adduction', give(), give()),
        dof(FRONT, 'inversion', 'eversion', give(), give()),
      ],
    },
    {
      id: 'r_talocalcaneonavicular',
      parent: 'r_talocrural',
      segment: 'r_navicular',
      kind: 'glide',
      side: 'right',
      mirror: 'l_talocalcaneonavicular',
      neutral: 'rest',
      long: FRONT,
      region: 'r_hindfoot',
      dofs: [
        dof(RIGHT, 'dorsiflexion', 'plantar flexion', give(), give()),
        dof(
          DOWN,
          'abduction',
          'adduction',
          bound(10, recalled('aaos1965', 10, 'forefoot abduction')),
          bound(10, recalled('aaos1965', 20, 'forefoot adduction')),
        ),
        dof(
          FRONT,
          'inversion',
          'eversion',
          bound(15, aaos(35, 'foot inversion', GONIOMETER), ama(30, 'foot inversion')),
          bound(15, aaos(15, 'foot eversion', GONIOMETER), ama(20, 'foot eversion')),
        ),
      ],
    },
    ...[1, 2, 3].map((n) =>
      foot(`r_cuneonavicular_${n}`, 'r_talocalcaneonavicular', `r_cuneiform_${n}`, give(5), give(5)),
    ),
    ...[1, 2, 3].map((n) =>
      foot(`r_tarsometatarsal_${n}`, `r_cuneonavicular_${n}`, `r_metatarsal_${n}`, give(5), give(5)),
    ),
    foot('r_calcaneocuboid', 'r_talocrural', 'r_calcaneus', give(5), give(5)),
    foot('r_transversetarsal', 'r_calcaneocuboid', 'r_cuboid', give(5), give(5)),
    ...[4, 5].map((n) => foot(`r_tarsometatarsal_${n}`, 'r_transversetarsal', `r_metatarsal_${n}`, give(5), give(5))),
    toe(
      'r_metatarsophalangeal_1',
      'r_tarsometatarsal_1',
      'r_tarsal_proximal_phalanx_1',
      'condyloid',
      bound(10, aaos(45, 'great toe MTP flexion')),
      bound(10, aaos(70, 'great toe MTP extension')),
    ),
    ...[2, 3, 4, 5].map((n) =>
      toe(
        `r_metatarsophalangeal_${n}`,
        `r_tarsometatarsal_${n}`,
        `r_tarsal_proximal_phalanx_${n}`,
        'condyloid',
        bound(10, recalled('aaos1965', 40, 'lesser toe MTP flexion')),
        bound(10, recalled('aaos1965', 40, 'lesser toe MTP extension')),
      ),
    ),
    toe(
      'r_tarsal_interphalangeal_1',
      'r_metatarsophalangeal_1',
      'r_tarsal_distal_phalanx_1',
      'hinge',
      bound(10, recalled('aaos1965', 90, 'great toe IP flexion')),
      give(),
    ),
    ...[2, 3, 4, 5].map((n) =>
      toe(
        `r_tarsal_proximal_interphalangeal_${n}`,
        `r_metatarsophalangeal_${n}`,
        `r_tarsal_middle_phalanx_${n}`,
        'hinge',
        bound(10, recalled('aaos1965', 35, 'lesser toe PIP flexion')),
        give(),
      ),
    ),
    ...[2, 3, 4, 5].map((n) =>
      toe(
        `r_tarsal_distal_interphalangeal_${n}`,
        `r_tarsal_proximal_interphalangeal_${n}`,
        `r_tarsal_distal_phalanx_${n}`,
        'hinge',
        bound(10, recalled('aaos1965', 60, 'lesser toe DIP flexion')),
        bound(0, recalled('aaos1965', 30, 'lesser toe DIP extension')),
      ),
    ),
  ];
  const carpal = (id: string, parent: string, segment: string, flexion: Bound): JointSpec => ({
    id,
    parent,
    segment,
    kind: 'glide',
    side: 'right',
    mirror: other(id),
    neutral: 'rest',
    long: DOWN,
    dofs: [
      dof(FRONT, 'flexion', 'extension', flexion, give(5)),
      dof(RIGHT, 'radial deviation', 'ulnar deviation', give(5), give(5)),
      dof(UP, 'pronation', 'supination', give(5), give(5)),
    ],
  });
  const knuckle = (
    id: string,
    parent: string,
    segment: string,
    far: string | null,
    flexion: Bound,
    back: Bound,
    thumb = false,
  ): JointSpec => ({
    id,
    parent,
    segment,
    kind: 'hinge',
    side: 'right',
    mirror: other(id),
    neutral: 'straight',
    long: DOWN,
    ...(far ? { distal: [far] } : {}),
    dofs: [
      dof(thumb ? SLANT : FRONT, 'flexion', 'hyperextension', flexion, back),
      dof(
        thumb ? SLANT_ACROSS : RIGHT,
        thumb ? 'abduction' : 'radial deviation',
        thumb ? 'adduction' : 'ulnar deviation',
        give(5),
        give(5),
      ),
      dof(UP, 'pronation', 'supination', give(5), give(5)),
    ],
  });
  const fingerFlexion = (joint: string, aaosValue: number, amaValue: number, added: number) =>
    bound(
      10,
      aaos(aaosValue, `finger ${joint} flexion`, `${OTBENCH}wrist-hand`),
      ama(amaValue, `finger ${joint} flexion`),
      row('hendriks2020', added, `finger ${joint} flexion, from Richard and Parry`, 'online', HENDRIKS),
    );
  const fingerBack = (joint: string, ...more: SourceRow[]) =>
    bound(
      0,
      row('hendriks2020', 0, `finger ${joint} extension, from Richard and Parry`, 'online', HENDRIKS),
      ama(30, `finger ${joint} extension`),
      ...more,
    );
  const arm: JointSpec[] = [
    {
      id: 'r_sternoclavicular',
      parent: 'vt1',
      segment: 'r_clavicle',
      kind: 'saddle',
      side: 'right',
      mirror: 'l_sternoclavicular',
      neutral: 'rest',
      long: RIGHT,
      distal: ['r_shoulder'],
      dofs: [
        dof(
          BACK,
          'elevation',
          'depression',
          bound(15, row('inman1944', 30, 'clavicular elevation during arm raising, about', 'online', MCCLURE)),
          bound(5, recalled('kapandji', 10, 'clavicular depression')),
        ),
        dof(
          UP,
          'protraction',
          'retraction',
          bound(10, recalled('kapandji', 15, 'clavicular protraction')),
          bound(10, recalled('kapandji', 20, 'clavicular retraction')),
        ),
        dof(
          RIGHT,
          'posterior rotation',
          'anterior rotation',
          bound(
            15,
            row('inman1944', 40, 'posterior rotation of the clavicle, about', 'online', MCCLURE),
            row('ludewig2009', 31, 'sternoclavicular posterior rotation, average', 'online', `${EUROPE_PMC}19181982`),
          ),
          give(5),
        ),
      ],
    },
    {
      id: 'r_acromioclavicular',
      parent: 'r_sternoclavicular',
      segment: 'r_scapula',
      kind: 'glide',
      side: 'right',
      mirror: 'l_acromioclavicular',
      neutral: 'rest',
      long: RIGHT,
      dofs: [
        dof(
          BACK,
          'upward rotation',
          'downward rotation',
          bound(10, recalled('ludewig2009', 11, 'scapular upward rotation on the clavicle, average')),
          give(5),
        ),
        dof(
          UP,
          'internal rotation',
          'external rotation',
          bound(10, recalled('ludewig2009', 8, 'scapular internal rotation on the clavicle, average')),
          give(5),
        ),
        dof(
          RIGHT,
          'posterior tilt',
          'anterior tilt',
          bound(
            10,
            row('ludewig2009', 19, 'acromioclavicular posterior tilt, average', 'online', `${EUROPE_PMC}19181982`),
          ),
          give(5),
        ),
      ],
    },
    {
      id: 'r_shoulder',
      parent: 'r_acromioclavicular',
      reference: 'vt1',
      segment: 'r_upperarm',
      kind: 'ball',
      side: 'right',
      mirror: 'l_shoulder',
      neutral: 'body',
      long: DOWN,
      distal: ['r_elbow'],
      dofs: [
        dof(
          RIGHT,
          'flexion',
          'extension',
          bound(15, ...cdc('shoulder flexion'), aaos(180, 'shoulder flexion'), ama(180, 'shoulder flexion')),
          bound(15, aaos(60, 'shoulder extension'), ama(50, 'shoulder extension')),
        ),
        dof(
          BACK,
          'abduction',
          'adduction',
          bound(15, aaos(180, 'shoulder abduction'), ama(180, 'shoulder abduction')),
          bound(
            15,
            ama(50, 'shoulder adduction'),
            row('hendriks2020', 40, 'shoulder adduction, added by the authors', 'online', HENDRIKS),
          ),
        ),
        dof(
          UP,
          'internal rotation',
          'external rotation',
          bound(15, aaos(70, 'shoulder internal rotation'), ama(90, 'shoulder internal rotation')),
          bound(15, aaos(90, 'shoulder external rotation'), ama(90, 'shoulder external rotation')),
        ),
      ],
    },
    {
      id: 'r_elbow',
      parent: 'r_shoulder',
      segment: 'r_forearm',
      kind: 'hinge',
      side: 'right',
      mirror: 'l_elbow',
      neutral: 'straight',
      long: DOWN,
      distal: ['r_radiocarpal'],
      dofs: [
        dof(
          RIGHT,
          'flexion',
          'hyperextension',
          bound(10, ...cdc('elbow flexion'), aaos(150, 'elbow flexion'), ama(140, 'elbow flexion')),
          bound(0, ...cdc('elbow extension')),
        ),
        dof(
          BACK,
          'valgus',
          'varus',
          bound(
            5,
            row(
              'paraskevas2004',
              20.02,
              'carrying angle, women, mean 15.07 plus one standard deviation 4.95',
              'online',
              `${EUROPE_PMC}14648036`,
            ),
            row(
              'paraskevas2004',
              15.24,
              'carrying angle, men, mean 10.97 plus one standard deviation 4.27',
              'online',
              `${EUROPE_PMC}14648036`,
            ),
            row('paraskevas2004', 12.88, 'carrying angle, all, mean', 'online', `${EUROPE_PMC}14648036`),
          ),
          give(5),
        ),
        dof(
          UP,
          'pronation',
          'supination',
          bound(
            15,
            ...cdc('elbow pronation'),
            aaos(80, 'forearm pronation', `${OTBENCH}elbow-forearm`),
            ama(80, 'forearm pronation'),
          ),
          bound(
            15,
            ...cdc('elbow supination'),
            aaos(80, 'forearm supination', `${OTBENCH}elbow-forearm`),
            ama(80, 'forearm supination'),
          ),
        ),
      ],
    },
    {
      id: 'r_radiocarpal',
      parent: 'r_elbow',
      segment: 'r_carpal',
      kind: 'condyloid',
      side: 'right',
      mirror: 'l_radiocarpal',
      neutral: 'straight',
      long: DOWN,
      distal: ['r_metacarpophalangeal_3', 'r_metacarpophalangeal_2', 'r_metacarpophalangeal_4'],
      across: {
        // The index and middle knuckles first: the second and third metacarpals are the hand's fixed central unit,
        // while the fourth and fifth sit lower toward the palm in the transverse metacarpal arch (Kapandji vol. 1),
        // so a line to the little finger's knuckle is tilted by the arch and rolls every finger's flexion axis
        // about 18 degrees (KB-RIG-HANDARCH1).
        pairs: [
          ['r_metacarpophalangeal_3', 'r_metacarpophalangeal_2'],
          ['r_metacarpophalangeal_4', 'r_metacarpophalangeal_2'],
          ['r_metacarpophalangeal_5', 'r_metacarpophalangeal_2'],
          ['r_metacarpophalangeal_5', 'r_metacarpophalangeal_3'],
        ],
        neutral: FRONT,
      },
      dofs: [
        dof(
          FRONT,
          'flexion',
          'extension',
          bound(15, aaos(80, 'wrist flexion'), ama(60, 'wrist flexion')),
          bound(15, aaos(70, 'wrist extension'), ama(60, 'wrist extension')),
        ),
        dof(
          RIGHT,
          'radial deviation',
          'ulnar deviation',
          bound(15, aaos(20, 'wrist radial deviation', `${OTBENCH}wrist-hand`), ama(20, 'wrist radial deviation')),
          bound(15, aaos(30, 'wrist ulnar deviation', `${OTBENCH}wrist-hand`), ama(30, 'wrist ulnar deviation')),
        ),
        dof(
          UP,
          'pronation',
          'supination',
          bound(5, recalled('kapandji', 10, 'passive rotation at the wrist, each way')),
          bound(5, recalled('kapandji', 10, 'passive rotation at the wrist, each way')),
          { spill: true },
        ),
      ],
    },
    carpal('r_midcarpal_1', 'r_radiocarpal', 'r_trapezium', give(5)),
    carpal('r_midcarpal_2', 'r_radiocarpal', 'r_trapezoid', give(5)),
    carpal('r_midcarpal_3', 'r_radiocarpal', 'r_capitate', give(5)),
    carpal('r_midcarpal_4_5', 'r_radiocarpal', 'r_hamate', give(5)),
    {
      id: 'r_carpometacarpal_1',
      parent: 'r_midcarpal_1',
      segment: 'r_metacarpal_1',
      kind: 'saddle',
      side: 'right',
      mirror: 'l_carpometacarpal_1',
      neutral: 'body',
      long: DOWN,
      distal: ['r_metacarpophalangeal_1'],
      dofs: [
        dof(
          FRONT,
          'palmar abduction',
          'retroposition',
          bound(
            15,
            aaos(60, 'thumb CMC palmar abduction', `${OTBENCH}wrist-hand`),
            row('hendriks2020', 60, 'thumb CMC palmar abduction, added by the authors', 'online', HENDRIKS),
          ),
          bound(10, recalled('kapandji', 15, 'thumb retroposition')),
        ),
        dof(
          RIGHT,
          'radial abduction',
          'adduction',
          bound(
            15,
            row('hendriks2020', 60, 'thumb CMC radial abduction, added by the authors', 'online', HENDRIKS),
            ama(50, 'thumb CMC radial abduction'),
          ),
          bound(10, recalled('kapandji', 10, 'thumb adduction across the palm')),
        ),
        dof(
          UP,
          'pronation',
          'supination',
          bound(10, recalled('kapandji', 30, 'thumb rotation in opposition')),
          give(10),
        ),
      ],
    },
    carpal(
      'r_carpometacarpal_2',
      'r_midcarpal_2',
      'r_metacarpal_2',
      bound(5, recalled('kapandji', 2, 'second carpometacarpal flexion')),
    ),
    carpal(
      'r_carpometacarpal_3',
      'r_midcarpal_3',
      'r_metacarpal_3',
      bound(5, recalled('kapandji', 2, 'third carpometacarpal flexion')),
    ),
    carpal(
      'r_carpometacarpal_4',
      'r_midcarpal_4_5',
      'r_metacarpal_4',
      bound(5, recalled('kapandji', 15, 'fourth carpometacarpal flexion')),
    ),
    carpal(
      'r_carpometacarpal_5',
      'r_midcarpal_4_5',
      'r_metacarpal_5',
      bound(5, recalled('kapandji', 25, 'fifth carpometacarpal flexion')),
    ),
    knuckle(
      'r_metacarpophalangeal_1',
      'r_carpometacarpal_1',
      'r_carpal_proximal_phalanx_1',
      'r_carpal_interphalangeal_1',
      bound(10, aaos(50, 'thumb MCP flexion'), ama(60, 'thumb MP flexion')),
      bound(0, aaos(0, 'thumb MCP extension'), ama(40, 'thumb MP extension')),
      true,
    ),
    ...[2, 3, 4, 5].map(
      (n): JointSpec => ({
        id: `r_metacarpophalangeal_${n}`,
        parent: `r_carpometacarpal_${n}`,
        segment: `r_carpal_proximal_phalanx_${n}`,
        kind: 'condyloid',
        side: 'right',
        mirror: `l_metacarpophalangeal_${n}`,
        neutral: 'straight',
        long: DOWN,
        distal: [`r_carpal_proximal_interphalangeal_${n}`],
        dofs: [
          dof(
            FRONT,
            'flexion',
            'hyperextension',
            fingerFlexion('MCP', 90, 90, 80),
            bound(0, ama(20, 'finger MP extension'), recalled('aaos1965', 45, 'finger MCP hyperextension')),
          ),
          dof(
            RIGHT,
            'radial deviation',
            'ulnar deviation',
            bound(10, recalled('kapandji', 20, 'finger MCP abduction, each way')),
            bound(10, recalled('kapandji', 20, 'finger MCP abduction, each way')),
          ),
          dof(UP, 'pronation', 'supination', give(10), give(10)),
        ],
      }),
    ),
    knuckle(
      'r_carpal_interphalangeal_1',
      'r_metacarpophalangeal_1',
      'r_carpal_distal_phalanx_1',
      null,
      bound(10, aaos(80, 'thumb IP flexion'), ama(80, 'thumb IP flexion')),
      bound(0, aaos(0, 'thumb IP extension'), ama(30, 'thumb IP extension')),
      true,
    ),
    ...[2, 3, 4, 5].map((n) =>
      knuckle(
        `r_carpal_proximal_interphalangeal_${n}`,
        `r_metacarpophalangeal_${n}`,
        `r_carpal_middle_phalanx_${n}`,
        `r_carpal_distal_interphalangeal_${n}`,
        fingerFlexion('PIP', 100, 100, 90),
        fingerBack('PIP'),
      ),
    ),
    ...[2, 3, 4, 5].map((n) =>
      knuckle(
        `r_carpal_distal_interphalangeal_${n}`,
        `r_carpal_proximal_interphalangeal_${n}`,
        `r_carpal_distal_phalanx_${n}`,
        null,
        fingerFlexion('DIP', 90, 70, 65),
        fingerBack('DIP', recalled('aaos1965', 10, 'finger DIP hyperextension')),
      ),
    ),
  ];
  const left = (spec: JointSpec): JointSpec => {
    const mirrored = mirrorJoint(spec, other);
    return spec.region ? { ...mirrored, region: other(spec.region) } : mirrored;
  };
  const joints = [...centre, ...leg, ...leg.map(left), ...arm, ...arm.map(left)];
  const regions: RegionSpec[] = [
    {
      id: 'trunk',
      joints: [...HUMAN_SPINE_LEVELS.lumbar, ...HUMAN_SPINE_LEVELS.thoracic].map((level) => level[0]),
      shared: true,
    },
    { id: 'neck', joints: HUMAN_SPINE_LEVELS.cervical.map((level) => level[0]), shared: true },
    { id: 'r_hindfoot', joints: ['r_talocrural', 'r_talocalcaneonavicular'], shared: false },
    { id: 'l_hindfoot', joints: ['l_talocrural', 'l_talocalcaneonavicular'], shared: false },
  ];

  // Proportions, as shares of stature, from the survey's means.
  const sexes: readonly ('female' | 'male')[] = sex ? [sex] : ['female', 'male'],
    mean = (of: 'female' | 'male', dimension: ANSUR2Dimension): number => ANSUR2[dimension][of === 'female' ? 0 : 2],
    measured = (dimension: ANSUR2Dimension): SourceRow[] =>
      (['female', 'male'] as const).map((of) => ({
        source: 'ansur2',
        value: mean(of, dimension),
        what: `${dimension}, ${of === 'female' ? 'women' : 'men'}, mean, cm`,
        provenance: 'dataset' as const,
        file: ANSUR2_FILE,
      }));
  const proportion = (
    id: string,
    what: string,
    plus: ANSUR2Dimension,
    minus: ANSUR2Dimension | null,
    winter?: number,
  ): ProportionNorm => {
    const share = (of: 'female' | 'male') => (mean(of, plus) - (minus ? mean(of, minus) : 0)) / mean(of, 'stature'),
      spread = (of: 'female' | 'male') => ANSUR2[plus][of === 'female' ? 1 : 3] / mean(of, 'stature');
    return {
      id,
      what,
      share: sexes.reduce((total, of) => total + share(of), 0) / sexes.length,
      female: share('female'),
      male: share('male'),
      ...(minus ? {} : { spread: sexes.reduce((total, of) => total + spread(of), 0) / sexes.length }),
      rows: [
        ...measured(plus),
        ...(minus ? measured(minus) : []),
        ...measured('stature'),
        ...(winter === undefined ? [] : [row('winter2009', winter, `${what}, share of stature`, 'online', WINTER)]),
      ],
    };
  };
  const proportions: ProportionNorm[] = [
    proportion('shoulderHeight', 'shoulder height', 'acromial height', null, 0.818),
    proportion('neckBaseHeight', 'height of the base of the neck', 'cervicale height', null),
    proportion('elbowHeight', 'elbow height, arm hanging', 'acromial height', 'acromion-radiale length', 0.63),
    proportion('wristHeight', 'wrist height, arm hanging', 'wrist height', null, 0.485),
    proportion('fingertipHeight', 'fingertip height, arm hanging', 'wrist height', 'hand length', 0.377),
    proportion('hipHeight', 'hip height', 'trochanterion height', null, 0.53),
    proportion('crotchHeight', 'crotch height', 'crotch height', null),
    proportion('kneeHeight', 'knee height', 'lateral femoral epicondyle height', null, 0.285),
    proportion('ankleHeight', 'ankle height', 'lateral malleolus height', null, 0.039),
    proportion('upperArmLength', 'upper arm length', 'acromion-radiale length', null, 0.186),
    proportion('forearmLength', 'forearm length', 'radiale-stylion length', null, 0.146),
    proportion('handLength', 'hand length', 'hand length', null, 0.108),
    proportion('thighLength', 'thigh length', 'trochanterion height', 'lateral femoral epicondyle height'),
    proportion('shankLength', 'shank length', 'lateral femoral epicondyle height', 'lateral malleolus height'),
    proportion('footLength', 'foot length', 'foot length', null, 0.152),
    proportion('shoulderBreadth', 'breadth across the shoulder joints', 'biacromial breadth', null),
    proportion('hipBreadth', 'hip breadth', 'hip breadth', null),
    proportion('armSpan', 'arm span', 'span', null),
    proportion('sittingHeight', 'sitting height', 'sitting height', null),
    proportion('trunkLength', 'shoulder height above the hip', 'acromial height', 'trochanterion height'),
    proportion('legLength', 'hip height above the ankle', 'trochanterion height', 'lateral malleolus height'),
  ];
  const shareOf = (id: string) => proportions.find((norm) => norm.id === id)!.share;

  // Segment masses and centres of mass.
  const pick = (pair: readonly [number, number]) =>
    (sex ? pair[sex === 'female' ? 0 : 1] : (pair[0] + pair[1]) / 2) / 100;
  const segment = (id: DeLevaSegmentName, carried: readonly string[]): SegmentNorm => {
    const data = DE_LEVA_1996[id];
    return {
      id,
      joints: carried,
      mass: pick(data.mass),
      centre: pick(data.centre),
      massBySex: [data.mass[0] / 100, data.mass[1] / 100],
      centreBySex: [data.centre[0] / 100, data.centre[1] / 100],
      landmarks: [data.from, data.to],
      rows: (['mass', 'centre'] as const).flatMap((measure) =>
        [0, 1].map((of) => ({
          source: 'deleva1996',
          value: data[measure][of],
          what: `${id} ${measure === 'mass' ? 'mass, percent of body mass' : 'centre of mass, percent of its length'}, ${of ? 'men' : 'women'}`,
          provenance: 'dataset' as const,
          file: DE_LEVA_FILE,
        })),
      ),
    };
  };
  const both = (joint: string) => [`l_${joint}`, `r_${joint}`];
  const segments: SegmentNorm[] = [
    segment('head', ['skullbase']),
    segment('trunk', ['humanoid_root']),
    segment('upperTrunk', ['vt1']),
    segment('middleTrunk', ['vt12']),
    segment('lowerTrunk', ['vl5']),
    segment('upperArm', both('shoulder')),
    segment('forearm', both('elbow')),
    segment('hand', both('radiocarpal')),
    segment('thigh', both('hip')),
    segment('shank', both('knee')),
    segment('foot', both('talocrural')),
  ];

  const couplings: CouplingHook[] = [
    {
      id: 'shoulder-girdle',
      kind: 'ratio',
      joints: ['r_shoulder', 'r_sternoclavicular', 'r_acromioclavicular'],
      note: 'Raising the arm turns the shoulder blade and collarbone with it: about two degrees at the shoulder joint for each degree of the shoulder blade, after a setting phase of the first 30 degrees of abduction or 60 of flexion. The collarbone rolls backward mostly past 90 degrees. The same holds on the left.',
      values: { glenohumeral: 2, scapulothoracic: 1, settingAbduction: 30, settingFlexion: 60, clavicleRollFrom: 90 },
      rows: [
        row('inman1944', 2, 'glenohumeral elevation for each degree of scapular upward rotation', 'online', MCCLURE),
        row(
          'inman1944',
          30,
          'setting phase of abduction, degrees',
          'online',
          'https://pmc.ncbi.nlm.nih.gov/articles/PMC2841046/',
        ),
        row(
          'inman1944',
          60,
          'setting phase of flexion, degrees',
          'online',
          'https://pmc.ncbi.nlm.nih.gov/articles/PMC2841046/',
        ),
        row('inman1944', 90, 'humeral elevation past which the clavicle mostly rotates', 'online', MCCLURE),
      ],
    },
    {
      id: 'carrying-angle',
      kind: 'offset',
      joints: ['r_elbow'],
      note: 'A straight, supinated elbow leaves the forearm angled away from the body: the carrying angle. A rig may model it as a valgus of the elbow at rest.',
      values: { mean: 12.88, deviation: 5.92, men: 10.97, menDeviation: 4.27, women: 15.07, womenDeviation: 4.95 },
      rows: [
        row('paraskevas2004', 12.88, 'carrying angle, all, mean', 'online', `${EUROPE_PMC}14648036`),
        row('paraskevas2004', 5.92, 'carrying angle, all, standard deviation', 'online', `${EUROPE_PMC}14648036`),
        row('paraskevas2004', 10.97, 'carrying angle, men, mean', 'online', `${EUROPE_PMC}14648036`),
        row('paraskevas2004', 4.27, 'carrying angle, men, standard deviation', 'online', `${EUROPE_PMC}14648036`),
        row('paraskevas2004', 15.07, 'carrying angle, women, mean', 'online', `${EUROPE_PMC}14648036`),
        row('paraskevas2004', 4.95, 'carrying angle, women, standard deviation', 'online', `${EUROPE_PMC}14648036`),
      ],
    },
    {
      id: 'forearm-rotation',
      kind: 'spill',
      joints: ['r_radiocarpal', 'r_elbow'],
      note: 'The wrist itself barely twists: a hand turned over turns the forearm. Twist past the wrist range belongs to the forearm, whose pronation and supination range then holds the whole turn.',
      values: { wrist: 10 },
      rows: [recalled('kapandji', 10, 'passive rotation at the wrist, each way')],
    },
    {
      id: 'knee-rotation',
      kind: 'gate',
      joints: ['r_knee'],
      note: 'A straight knee is locked against twisting; its rotation opens as it bends and is widest near 90 degrees of flexion.',
      values: { from: 0, to: 90, floor: 5 },
      rows: [recalled('kapandji', 90, 'knee flexion at which tibial rotation is widest')],
    },
    {
      id: 'finger-curl',
      kind: 'follow',
      joints: ['r_carpal_proximal_interphalangeal_2', 'r_carpal_distal_interphalangeal_2'],
      note: 'The last joint of a finger bends with the middle one, at about two thirds of its angle; the same holds for fingers 3 to 5 and the left hand.',
      values: { ratio: 2 / 3 },
      rows: [
        recalled(
          'rijpkema1991',
          2 / 3,
          'distal interphalangeal flexion as a fraction of proximal interphalangeal flexion',
        ),
      ],
    },
    {
      id: 'head-rotation',
      kind: 'share',
      joints: ['vc1', 'skullbase'],
      note: 'About half of the turn of the head happens between the first two neck vertebrae; nodding happens mostly at the skull. The level weights of the neck region carry this.',
      values: { atlantoaxialRotation: 40, cervicalRotation: 77 },
      // Bogduk and Mercer 2000 state the pattern (C0-C1 mainly nods, C1-C2 mainly turns) without a number a page shows.
      rows: [recalled('white1990', 40, 'C1-C2 rotation to one side, representative')],
    },
  ];

  return defineSpecies({
    id: 'human',
    standard: 'ISO/IEC 19774-1:2019 (HAnim), level of articulation 4',
    joints,
    regions,
    frame: {
      pairs: [
        ['l_hip', 'r_hip'],
        ['l_shoulder', 'r_shoulder'],
      ],
      top: [...HUMAN_SPINE_LEVELS.cervical, ...HUMAN_SPINE_LEVELS.thoracic, ...HUMAN_SPINE_LEVELS.lumbar]
        .map((level) => level[0])
        .reverse(),
      bottom: ['l_knee', 'r_knee', 'l_talocrural', 'r_talocrural'],
      ahead: ['l', 'r'].flatMap((s) =>
        [1, 2, 3].map((n) => [`${s}_talocrural`, `${s}_metatarsophalangeal_${n}`] as const),
      ),
    },
    stature: [
      { from: 'l_talocrural', to: 'l_hip', share: shareOf('legLength') },
      { from: 'r_talocrural', to: 'r_hip', share: shareOf('legLength') },
      { from: 'l_knee', to: 'l_hip', share: shareOf('thighLength') },
      { from: 'r_knee', to: 'r_hip', share: shareOf('thighLength') },
      { from: 'l_hip', to: 'l_shoulder', share: shareOf('trunkLength') },
      { from: 'r_hip', to: 'r_shoulder', share: shareOf('trunkLength') },
    ],
    proportions,
    segments,
    couplings,
    sources: SOURCES,
    naming: nameHuman,
    describeRest,
  });
}

/** Names a rest pose by how far the arms are held out to the sides. */
function describeRest(rest: Readonly<Record<string, JointAngles>>): string {
  const arms = [rest.l_shoulder, rest.r_shoulder].filter((arm) => arm !== undefined);
  if (!arms.length) return 'unknown';
  const out = arms.reduce((total, arm) => total + arm.abduction, 0) / arms.length,
    forward = arms.reduce((total, arm) => total + Math.abs(arm.flexion), 0) / arms.length;
  return forward > 30 ? 'other' : out >= 65 ? 'T' : out >= 20 ? 'A' : 'arms-down';
}

/** The table joint each bone of `@margoengine/rigging/retarget`'s humanoid naming turns at. */
const HUMANOID: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    hips: 'humanoid_root',
    spine: 'vl5',
    chest: 'vt12',
    upperChest: 'vt6',
    neck: 'vc7',
    head: 'vc1',
  };
  for (const [side, s] of [
    ['left', 'l'],
    ['right', 'r'],
  ] as const) {
    Object.assign(map, {
      [`${side}Shoulder`]: `${s}_sternoclavicular`,
      [`${side}UpperArm`]: `${s}_shoulder`,
      [`${side}LowerArm`]: `${s}_elbow`,
      [`${side}Hand`]: `${s}_radiocarpal`,
      [`${side}UpperLeg`]: `${s}_hip`,
      [`${side}LowerLeg`]: `${s}_knee`,
      [`${side}Foot`]: `${s}_talocrural`,
      [`${side}Toes`]: `${s}_metatarsophalangeal_1`,
      [`${side}ThumbMetacarpal`]: `${s}_carpometacarpal_1`,
      [`${side}ThumbProximal`]: `${s}_metacarpophalangeal_1`,
      [`${side}ThumbDistal`]: `${s}_carpal_interphalangeal_1`,
    });
    ['Index', 'Middle', 'Ring', 'Little'].forEach((finger, i) => {
      map[`${side}${finger}Proximal`] = `${s}_metacarpophalangeal_${i + 2}`;
      map[`${side}${finger}Intermediate`] = `${s}_carpal_proximal_interphalangeal_${i + 2}`;
      map[`${side}${finger}Distal`] = `${s}_carpal_distal_interphalangeal_${i + 2}`;
    });
  }
  return map;
})();

/** A bone name without its namespace or rig prefix, in lower case with only letters and digits. */
const tidy = (name: string): string =>
  name
    .replace(/^.*[:|]/, '')
    .replace(/^mixamorig\d*_?/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** This file's own bone namings: tidy bone name to joint id. */
const ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = (() => {
  // HAnim 1.x names for the joints HAnim 2.0 renamed (from recall; the 2.0 text lists no alias table).
  const hanim: Record<string, string> = {},
    // Segment-named rigs: Mixamo, and the BVH conversion of the CMU captures (LowerBack, Neck1, LThumb).
    segments: Record<string, string> = {
      hips: 'humanoid_root',
      lowerback: 'vl5',
      spine: 'vl3',
      spine1: 'vt12',
      spine2: 'vt6',
      neck: 'vc7',
      neck1: 'vc4',
      head: 'vc1',
    },
    // Joint-named rigs: the 100STYLE captures and other Xsens-style BVH files (a bone is named for the joint it turns at).
    jointed: Record<string, string> = {
      hips: 'humanoid_root',
      chest: 'vl5',
      chest2: 'vl2',
      chest3: 'vt9',
      chest4: 'vt4',
      neck: 'vc7',
      head: 'vc1',
    };
  for (const [side, s] of [
    ['left', 'l'],
    ['right', 'r'],
  ] as const) {
    Object.assign(hanim, {
      [`${s}ankle`]: `${s}_talocrural`,
      [`${s}subtalar`]: `${s}_talocalcaneonavicular`,
      [`${s}metatarsal`]: `${s}_metatarsophalangeal_2`,
      [`${s}wrist`]: `${s}_radiocarpal`,
      [`${s}thumb1`]: `${s}_carpometacarpal_1`,
      [`${s}thumb2`]: `${s}_metacarpophalangeal_1`,
      [`${s}thumb3`]: `${s}_carpal_interphalangeal_1`,
    });
    ['index', 'middle', 'ring', 'pinky'].forEach((finger, i) => {
      hanim[`${s}${finger}0`] = `${s}_carpometacarpal_${i + 2}`;
      hanim[`${s}${finger}1`] = `${s}_metacarpophalangeal_${i + 2}`;
      hanim[`${s}${finger}2`] = `${s}_carpal_proximal_interphalangeal_${i + 2}`;
      hanim[`${s}${finger}3`] = `${s}_carpal_distal_interphalangeal_${i + 2}`;
      segments[`${side}hand${finger}1`] = `${s}_metacarpophalangeal_${i + 2}`;
      segments[`${side}hand${finger}2`] = `${s}_carpal_proximal_interphalangeal_${i + 2}`;
      segments[`${side}hand${finger}3`] = `${s}_carpal_distal_interphalangeal_${i + 2}`;
    });
    Object.assign(segments, {
      [`${side}shoulder`]: `${s}_sternoclavicular`,
      [`${side}arm`]: `${s}_shoulder`,
      [`${side}forearm`]: `${s}_elbow`,
      [`${side}hand`]: `${s}_radiocarpal`,
      [`${side}upleg`]: `${s}_hip`,
      [`${side}leg`]: `${s}_knee`,
      [`${side}foot`]: `${s}_talocrural`,
      [`${side}toebase`]: `${s}_metatarsophalangeal_1`,
      [`${side}handthumb1`]: `${s}_carpometacarpal_1`,
      [`${side}handthumb2`]: `${s}_metacarpophalangeal_1`,
      [`${side}handthumb3`]: `${s}_carpal_interphalangeal_1`,
      [`${s}thumb`]: `${s}_carpometacarpal_1`,
    });
    Object.assign(jointed, {
      [`${side}collar`]: `${s}_sternoclavicular`,
      [`${side}shoulder`]: `${s}_shoulder`,
      [`${side}elbow`]: `${s}_elbow`,
      [`${side}wrist`]: `${s}_radiocarpal`,
      [`${side}hip`]: `${s}_hip`,
      [`${side}knee`]: `${s}_knee`,
      [`${side}ankle`]: `${s}_talocrural`,
      [`${side}toe`]: `${s}_metatarsophalangeal_1`,
    });
  }
  return { hanim, segments, joints: jointed };
})();
/** Bones a preset of `@margoengine/rigging/retarget` leaves out that the table has a joint for. */
const EXTRA: Readonly<Record<string, string>> = { ccbasepelvis: 'sacroiliac', ccbasenecktwist02: 'vc4' };
/**
 * A second hand bone that carries the wrist's bend (the CMU skeleton's lhand under lwrist, LeftFingerBase under LeftHand
 * in its BVH form) is where the wrist is read: the bone above it only twists, and the two count as one wrist.
 */
const PREFER: Readonly<Record<string, string>> = {
  lhand: 'l_radiocarpal',
  rhand: 'r_radiocarpal',
  leftfingerbase: 'l_radiocarpal',
  rightfingerbase: 'r_radiocarpal',
};
const RETARGET_PRESETS: readonly SkeletonPreset[] = [
  'mixamo',
  'roblox',
  'godot',
  'margo',
  'cmu',
  'mpfb',
  'characterCreator',
  'humanoid',
];

/**
 * The bone namings the human table knows: `hanim` (ISO/IEC 19774 joint names, with the HAnim 1.x names of renamed
 * joints), `segments` (Mixamo-style names and the BVH form of the CMU captures), `joints` (the 100STYLE captures and
 * other files that name a bone for its joint), then the presets of `@margoengine/rigging/retarget`.
 */
export const HUMAN_NAMINGS: readonly string[] = ['hanim', 'segments', 'joints', ...RETARGET_PRESETS];

let canonical: Map<string, string> | null = null;
/** Finds the human joints among bone names: under `preset`, or under the naming that matches the most bones. */
function nameHuman(names: readonly string[], preset?: string): JointNaming | null {
  if (preset !== undefined && !HUMAN_NAMINGS.includes(preset))
    throw new RangeError(`Human naming "${preset}" must be one of ${HUMAN_NAMINGS.join(', ')}`);
  canonical ??= new Map(human.joints.map((joint) => [tidy(joint.id), joint.id]));
  const tidied = names.map((name) => (typeof name === 'string' ? tidy(name) : ''));
  let best: JointNaming | null = null;
  const offer = (id: string, find: (bone: string) => string | undefined) => {
    if (preset !== undefined && preset !== id) return;
    const joints = new Map<string, number>();
    tidied.forEach((bone, i) => {
      const joint = find(bone) ?? EXTRA[bone];
      if (joint && !joints.has(joint) && ![...joints.values()].includes(i)) joints.set(joint, i);
    });
    tidied.forEach((bone, i) => {
      if (PREFER[bone] && joints.has(PREFER[bone])) joints.set(PREFER[bone], i);
    });
    if (joints.has('humanoid_root') && (!best || joints.size > best.joints.size)) best = { preset: id, joints };
  };
  offer('hanim', (bone) => canonical!.get(bone) ?? ALIASES.hanim[bone]);
  offer('segments', (bone) => ALIASES.segments[bone]);
  offer('joints', (bone) => ALIASES.joints[bone]);
  const detected = preset === undefined ? detectSkeleton([...names])?.preset : undefined;
  for (const id of RETARGET_PRESETS) {
    if (preset === undefined ? id !== detected : id !== preset) continue;
    const byIndex = new Map<number, string>();
    for (const [bone, index] of humanoidBones([...names], id)) if (HUMANOID[bone]) byIndex.set(index, HUMANOID[bone]);
    const lookup = new Map(tidied.map((bone, i) => [bone, byIndex.get(i)] as const));
    offer(id, (bone) => lookup.get(bone));
  }
  return best;
}

/**
 * The human table for adults of 20 to 44 years, both sexes: 139 joints in ISO/IEC 19774 (HAnim) names from
 * `humanoid_root`, neutral with the arms down and the palms to the thighs.
 * @example
 * import { fitAnatomy, clampPose } from '@margoengine/rigging/anatomy';
 * import { human } from '@margoengine/rigging/anatomy/human';
 *
 * const body = fitAnatomy(rig, { species: human });
 * clampPose(body, pose);
 */
export const human: SpeciesTable = humanTable();

/** Options of {@link fitHuman}: those of `fitAnatomy` without the species, and who the body is. */
export interface FitHumanOptions extends Omit<FitOptions, 'species'>, HumanGroup {}

/**
 * Fits the human table to a rig, with limits on: `fitAnatomy(rig, { species: human })`, or the table of a sex or age
 * when one is given.
 * @example
 * import { fitHuman } from '@margoengine/rigging/anatomy/human';
 *
 * const body = fitHuman(rig);
 * console.log(body.preset, body.restPose, body.stature);
 * @throws As `fitAnatomy` and `humanTable` do.
 */
export function fitHuman(rig: RigPose | readonly RigJoint[], options: FitHumanOptions = {}): AnatomicalRig {
  const { sex, age, ...rest } = options;
  return fitAnatomy(rig, {
    ...rest,
    species: sex === undefined && age === undefined ? human : humanTable({ sex, age }),
  });
}
