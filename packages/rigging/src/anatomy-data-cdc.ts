// Dataset: CDC Normal Joint Range of Motion Study, published reference values.
//
// Source: Centers for Disease Control and Prevention, "Joint Range of Motion Study" page (last reviewed 2023-04-28),
// the table of means and 95% confidence intervals by sex and age group,
// https://archive.cdc.gov/www_cdc_gov/ncbddd/jointrom/index.html . The study is Soucie JM, Wang C, Forsyth A, Funk S,
// Denney M, Roach KE, Boone D and the Hemophilia Treatment Center Network, "Range of motion measurements: reference
// values and a database for comparison studies", Haemophilia 17(3):500-507, 2011 (online 2010),
// https://doi.org/10.1111/j.1365-2516.2010.02399.x .
//
// Licence: a publication of a United States federal agency. The page prints no licence statement (read 2026-11-28).
// Only the published group table is held here. The study's downloadable per-person dataset has its own data use
// restrictions ("may be used only for the purpose of health statistical reporting and analysis") and is neither used
// nor redistributed. Credit: THIRD-PARTY-NOTICES.md.
//
// Read: the table cells were read from the page's HTML twice on 2026-11-28 by two separate readers and agree in every
// cell. Values are degrees, [mean, low, high], where low and high bound the 95% confidence interval of the mean.
// Extension rows are degrees past the straight joint, so the one negative mean (men 45 to 69, elbow) stops short of it.

/** Age groups of the study, in years. */
export const CDC_AGES = ['2-8', '9-19', '20-44', '45-69'] as const;
/** The eleven motions the study measured, as the page names them. */
export const CDC_MOTIONS = [
  'hip extension',
  'hip flexion',
  'knee flexion',
  'knee extension',
  'ankle dorsiflexion',
  'ankle plantar flexion',
  'shoulder flexion',
  'elbow flexion',
  'elbow extension',
  'elbow pronation',
  'elbow supination',
] as const;

/** One of {@link CDC_AGES}. */
export type CDCAge = (typeof CDC_AGES)[number];
/** One of {@link CDC_MOTIONS}. */
export type CDCMotion = (typeof CDC_MOTIONS)[number];
/** Mean, then the low and high ends of its 95% confidence interval, degrees. */
export type CDCCell = readonly [mean: number, low: number, high: number];

/** The table: sex, age group, then one cell per motion in {@link CDC_MOTIONS} order. */
export const CDC_RANGE_OF_MOTION: Readonly<Record<'female' | 'male', Readonly<Record<CDCAge, readonly CDCCell[]>>>> = {
  female: {
    '2-8': [
      [26.2, 23.9, 28.5],
      [140.8, 139.2, 142.4],
      [152.6, 151.2, 154.0],
      [5.4, 3.9, 6.9],
      [24.8, 22.5, 27.1],
      [67.1, 64.8, 69.4],
      [178.6, 176.9, 180.3],
      [152.9, 151.5, 154.3],
      [6.8, 5.2, 8.4],
      [84.6, 82.8, 86.4],
      [93.7, 91.4, 96.0],
    ],
    '9-19': [
      [20.5, 18.6, 22.4],
      [134.9, 133.0, 136.8],
      [142.3, 140.8, 143.8],
      [2.4, 1.5, 3.3],
      [17.3, 15.6, 19.0],
      [57.3, 54.8, 59.8],
      [171.8, 169.8, 173.8],
      [149.7, 148.5, 150.9],
      [6.4, 4.7, 8.1],
      [81.2, 79.6, 82.8],
      [90.0, 88.0, 92.0],
    ],
    '20-44': [
      [18.1, 17.0, 19.2],
      [133.8, 132.5, 135.1],
      [141.9, 140.9, 142.9],
      [1.6, 1.1, 2.1],
      [13.8, 12.9, 14.7],
      [62.1, 60.6, 63.6],
      [172.0, 170.9, 173.1],
      [150.0, 149.1, 150.9],
      [4.7, 3.9, 5.5],
      [82.0, 81.0, 83.0],
      [90.6, 89.2, 92.0],
    ],
    '45-69': [
      [16.7, 15.5, 17.9],
      [130.8, 129.2, 132.4],
      [137.8, 136.5, 139.1],
      [1.2, 0.7, 1.7],
      [11.6, 10.6, 12.6],
      [56.5, 55.0, 58.0],
      [168.1, 166.7, 169.5],
      [148.3, 147.3, 149.3],
      [3.6, 2.6, 4.6],
      [80.8, 79.7, 81.9],
      [87.2, 86.0, 88.4],
    ],
  },
  male: {
    '2-8': [
      [28.3, 27.2, 29.4],
      [131.1, 129.4, 132.8],
      [147.8, 146.6, 149.0],
      [1.6, 0.9, 2.3],
      [22.8, 21.3, 24.3],
      [55.8, 54.4, 57.2],
      [177.8, 176.7, 178.9],
      [151.4, 150.8, 152.0],
      [2.2, 0.9, 3.5],
      [79.6, 78.8, 80.4],
      [86.4, 85.3, 87.5],
    ],
    '9-19': [
      [18.2, 16.6, 19.8],
      [135.2, 133.0, 137.4],
      [142.2, 140.4, 144.0],
      [1.8, 0.9, 2.7],
      [16.3, 14.9, 17.7],
      [52.8, 50.8, 54.8],
      [170.9, 169.1, 172.7],
      [148.3, 146.8, 149.8],
      [5.3, 3.6, 7.0],
      [79.8, 77.8, 81.8],
      [87.8, 85.7, 89.9],
    ],
    '20-44': [
      [17.4, 16.3, 18.5],
      [130.4, 129.0, 131.8],
      [137.7, 136.5, 138.9],
      [1.0, 0.6, 1.4],
      [12.7, 11.6, 13.8],
      [54.6, 53.2, 56.0],
      [168.8, 167.3, 170.3],
      [144.6, 143.6, 145.6],
      [0.8, 0.1, 1.5],
      [76.9, 75.6, 78.2],
      [85.0, 83.8, 86.2],
    ],
    '45-69': [
      [13.5, 12.5, 14.5],
      [127.2, 125.7, 128.7],
      [132.9, 131.6, 134.2],
      [0.5, 0.1, 0.9],
      [11.9, 10.9, 12.9],
      [49.4, 47.7, 51.1],
      [164.0, 162.3, 165.7],
      [143.5, 142.3, 144.7],
      [-0.7, -1.5, 0.1],
      [77.7, 76.5, 78.9],
      [82.4, 80.9, 83.9],
    ],
  },
};

/** Where this dataset lives in the repository, for the provenance of the rows read from it. */
export const CDC_FILE = 'packages/rigging/src/anatomy-data-cdc.ts';

/** The mean of one motion for a sex and age group, degrees. */
export function cdcMean(sex: 'female' | 'male', age: CDCAge, motion: CDCMotion): number {
  return CDC_RANGE_OF_MOTION[sex][age][CDC_MOTIONS.indexOf(motion)][0];
}
