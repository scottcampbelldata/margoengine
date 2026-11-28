// Dataset: ANSUR II, the 2012 Anthropometric Survey of U.S. Army Personnel, published summary statistics.
//
// Source: Gordon CC and others, "2012 Anthropometric Survey of U.S. Army Personnel: Methods and Summary Statistics",
// U.S. Army Natick Soldier Research, Development and Engineering Center, technical report NATICK/TR-15/007
// (DTIC ADA611869). Read from the copy the Penn State OPEN Design Lab hosts,
// https://tools.openlab.psu.edu/publicData/ANSURII-TR15-007.pdf (the survey page is
// https://www.openlab.psu.edu/ansur2/). The sample is "4,082 men and 1,986 women, measured between October 4, 2010
// and April 5, 2012".
//
// Licence: a work of the United States Army; the report's distribution statement is "Approved for public release;
// distribution is unlimited". Credit: THIRD-PARTY-NOTICES.md.
//
// Read: on 2026-11-28, from the statistics page the report prints for each dimension. Values are centimetres (weight
// is kilograms), [female mean, female SD, male mean, male SD]; every dimension here has 1,986 women and 4,082 men.
// The per-person files of the survey are not held here: only these published means and standard deviations.
// Ten rows were read from pages whose text layout was scrambled and were settled by matching the centimetre and inch
// columns: ball of foot length, bimalleolar breadth, heel breadth, lateral malleolus height, foot breadth, hand
// length, head length, head breadth, palm length and tragion to top of head. Their standard deviations matched in
// both units.
// Girths: on 2026-11-28 a second read, for the pose checker's body volumes, took the circumferences, depths and
// breadths below from the same report's statistics pages (biceps circumference flexed, forearm circumference flexed,
// thigh, lower thigh, calf, ankle and wrist circumference, chest and waist depth, chest and waist breadth). Each was
// checked against its inch column and its coefficient of variation; the wrist page's layout was scrambled and was
// settled the same way.

/** Women measured for every dimension here. */
export const ANSUR2_FEMALES = 1986;
/** Men measured for every dimension here. */
export const ANSUR2_MALES = 4082;

/** Female mean and SD, then male mean and SD, in centimetres (kilograms for weight). */
export type ANSUR2Row = readonly [femaleMean: number, femaleSD: number, maleMean: number, maleSD: number];

/** The dimensions, keyed by the report's own names in lower case. */
export const ANSUR2 = {
  stature: [162.85, 6.42, 175.62, 6.86],
  'acromial height': [133.51, 5.81, 144.07, 6.33],
  'cervicale height': [139.57, 5.95, 151.73, 6.33],
  'chest height': [117.16, 5.55, 129.11, 5.7],
  'waist height (omphalion)': [98.01, 5.0, 105.65, 5.22],
  'iliocristale height': [99.57, 4.97, 106.16, 5.2],
  'trochanterion height': [84.54, 4.47, 90.09, 4.92],
  'crotch height': [78.23, 4.46, 84.59, 4.65],
  'lateral femoral epicondyle height': [46.59, 2.71, 49.17, 2.66],
  'knee height, midpatella': [44.9, 2.6, 48.84, 2.81],
  'tibial height': [43.78, 2.5, 46.82, 2.66],
  'lateral malleolus height': [6.27, 0.51, 7.29, 0.57],
  'shoulder-elbow length': [33.43, 1.73, 36.37, 1.82],
  'radiale-stylion length': [24.13, 1.52, 26.79, 1.54],
  'forearm-hand length': [43.99, 2.34, 48.02, 2.33],
  'hand length': [18.11, 1.01, 19.33, 0.99],
  'palm length': [10.87, 0.59, 11.65, 0.62],
  'wrist height': [79.42, 3.82, 84.75, 4.17],
  'acromion-radiale length': [31.12, 1.72, 33.52, 1.75],
  span: [166.03, 8.3, 181.42, 8.46],
  'biacromial breadth': [36.53, 1.83, 41.57, 1.92],
  'bideltoid breadth': [45.03, 2.87, 51.04, 3.25],
  'hip breadth': [35.38, 2.67, 34.57, 2.42],
  'bimalleolar breadth': [6.7, 0.35, 7.48, 0.41],
  'foot length': [24.63, 1.24, 27.12, 1.31],
  'ball of foot length': [18.21, 0.96, 20.09, 1.05],
  'foot breadth, horizontal': [9.27, 0.48, 10.19, 0.52],
  'heel breadth': [6.72, 0.52, 7.25, 0.55],
  'head length': [18.98, 0.74, 19.95, 0.7],
  'head breadth': [14.78, 0.52, 15.43, 0.55],
  'tragion-top of head': [12.65, 0.65, 13.11, 0.62],
  'sitting height': [85.66, 3.31, 91.83, 3.57],
  'eye height, sitting': [74.77, 3.04, 80.45, 3.32],
  'buttock-knee length': [59.06, 3.26, 61.8, 3.06],
  'buttock-popliteal length': [48.51, 2.87, 50.29, 2.74],
  'functional leg length': [104.43, 5.4, 113.02, 5.61],
  'weight (kg)': [67.76, 10.98, 85.52, 14.22],
  'biceps circumference, flexed': [30.56, 3.08, 35.81, 3.46],
  'forearm circumference, flexed': [26.41, 1.85, 31.01, 2.2],
  'wrist circumference': [15.48, 0.78, 17.59, 0.9],
  'thigh circumference': [61.61, 5.58, 62.51, 5.85],
  'lower thigh circumference': [40.07, 3.52, 40.93, 3.19],
  'calf circumference': [37.33, 2.85, 39.23, 2.97],
  'ankle circumference': [21.57, 1.49, 22.93, 1.46],
  'chest depth': [24.74, 2.73, 25.38, 2.62],
  'waist depth': [21.3, 3.14, 23.78, 3.47],
  'chest breadth': [26.93, 1.86, 28.94, 1.83],
  'waist breadth': [29.99, 3.3, 32.64, 3.47],
} as const satisfies Readonly<Record<string, ANSUR2Row>>;

/** A dimension of {@link ANSUR2}. */
export type ANSUR2Dimension = keyof typeof ANSUR2;

/** Where this dataset lives in the repository, for the provenance of the rows read from it. */
export const ANSUR2_FILE = 'packages/rigging/src/anatomy-data-ansur2.ts';

/** The mean of a dimension for one sex, centimetres (kilograms for weight). */
export function ansur2Mean(sex: 'female' | 'male', dimension: ANSUR2Dimension): number {
  return ANSUR2[dimension][sex === 'female' ? 0 : 2];
}
