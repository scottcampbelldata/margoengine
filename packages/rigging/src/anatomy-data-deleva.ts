// Dataset: body segment mass shares and centres of mass, de Leva 1996.
//
// Source: de Leva P, "Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters", Journal of Biomechanics
// 29(9):1223-1230, 1996, Table 4, https://doi.org/10.1016/0021-9290(95)00178-6 . The table's caption: "Segment masses
// are relative to body mass; segment CM positions are referenced either to proximal or cranial endpoints (origin)."
// Its subjects average 73.0 kg and 1.741 m (men) and 61.9 kg and 1.735 m (women).
//
// Licence: the paper is copyright Elsevier. Only the table's measured values are held here, as cited facts with
// credit; none of its text or figures is copied. Credit: THIRD-PARTY-NOTICES.md.
//
// Read: on 2026-11-28 from a copy of the paper, and every mass and centre value checked against a second,
// machine-readable copy of the table; they agree. Values are [female, male]. Mass is a percentage of body mass; the
// centre of mass is a percentage of the segment's length from its first named end. The table's segment lengths and
// radii of gyration are not held here: the copy read did not give them reliably. The shank's far end is the ankle;
// the paper lists rows for the lateral malleolus and for the ankle joint centre, which differ by under one percent
// of the segment's length.

/** Female value, then male value. */
export type DeLevaPair = readonly [female: number, male: number];

/** One body segment of the table. */
export interface DeLevaSegment {
  /** Landmark the centre of mass is measured from. */
  readonly from: string;
  /** Landmark at the segment's other end. */
  readonly to: string;
  /** Mass, percent of body mass. */
  readonly mass: DeLevaPair;
  /** Centre of mass, percent of the way from `from` to `to`. */
  readonly centre: DeLevaPair;
}

/** The segments. The whole trunk is also given as its upper, middle and lower parts, which add up to it. */
export const DE_LEVA_1996 = {
  head: { from: 'vertex', to: 'mid gonion', mass: [6.68, 6.94], centre: [58.94, 59.76] },
  trunk: { from: 'suprasternale', to: 'mid hip', mass: [42.57, 43.46], centre: [41.51, 44.86] },
  upperTrunk: { from: 'suprasternale', to: 'xiphion', mass: [15.45, 15.96], centre: [20.77, 29.99] },
  middleTrunk: { from: 'xiphion', to: 'omphalion', mass: [14.65, 16.33], centre: [45.12, 45.02] },
  lowerTrunk: { from: 'omphalion', to: 'mid hip', mass: [12.47, 11.17], centre: [49.2, 61.15] },
  upperArm: { from: 'shoulder joint centre', to: 'elbow joint centre', mass: [2.55, 2.71], centre: [57.54, 57.72] },
  forearm: { from: 'elbow joint centre', to: 'wrist joint centre', mass: [1.38, 1.62], centre: [45.59, 45.74] },
  hand: { from: 'wrist joint centre', to: 'third metacarpale', mass: [0.56, 0.61], centre: [74.74, 79.0] },
  thigh: { from: 'hip joint centre', to: 'knee joint centre', mass: [14.78, 14.16], centre: [36.12, 40.95] },
  shank: { from: 'knee joint centre', to: 'ankle', mass: [4.81, 4.33], centre: [44.16, 44.59] },
  foot: { from: 'heel', to: 'toe tip', mass: [1.29, 1.37], centre: [40.14, 44.15] },
} as const satisfies Readonly<Record<string, DeLevaSegment>>;

/** A segment of {@link DE_LEVA_1996}. */
export type DeLevaSegmentName = keyof typeof DE_LEVA_1996;

/** Where this dataset lives in the repository, for the provenance of the rows read from it. */
export const DE_LEVA_FILE = 'packages/rigging/src/anatomy-data-deleva.ts';
