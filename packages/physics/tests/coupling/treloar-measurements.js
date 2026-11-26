// Treloar (1944), 8% sulfur rubber, reported nominal stresses (kgf/cm²) against nominal strain.
// Measurements transcribed from the publication's figures as reproduced in the documentation:
// https://docs.software.vt.edu/abaqusv2026/English/SIMACAEBMKRefMap/simabmk-c-rubberfit.htm
// Rows with zero-based even indices in uniaxial tension and all planar rows calibrate the law.
// The other uniaxial points and the entire independent equibiaxial loading were withheld.
export const calibration = {
  'uniaxial': [
    [0.1338, 1.5506],
    [0.3567, 3.1013],
    [0.8917, 5.3165],
    [1.4268, 6.8671],
    [2.586, 10.6329],
    [3.7898, 16.1709],
    [4.8153, 23.481],
    [5.4395, 31.0127],
    [5.9299, 38.3228],
    [6.1975, 45.6329],
    [6.465, 53.1646],
    [6.6433, 64.2405],
  ],
  'planar': [
    [0.069, 0.6],
    [0.1034, 1.6],
    [0.1724, 2.4],
    [0.2828, 3.36],
    [0.4276, 4.2],
    [0.8483, 6],
    [1.3862, 7.8],
    [2, 9.6],
    [2.4897, 11.12],
    [3.0345, 12.96],
    [3.4483, 14.88],
    [3.7793, 16.58],
    [4.0621, 18.2],
  ],
};
export const withheld = {
  'uniaxial': [
    [0.2675, 2.4367],
    [0.6242, 4.2089],
    [1.1592, 5.981],
    [2.051, 8.8608],
    [3.0318, 12.4051],
    [4.3694, 19.9367],
    [5.172, 27.4684],
    [5.707, 34.557],
    [6.0637, 42.0886],
    [6.3312, 49.3987],
    [6.5541, 56.9304],
  ],
  'biaxial': [
    [0.02, 0.9384],
    [0.06, 1.59],
    [0.11, 2.4087],
    [0.14, 2.622],
    [0.2, 3.324],
    [0.31, 4.4278],
    [0.42, 5.183],
    [0.68, 6.6024],
    [0.94, 7.7794],
    [1.49, 9.7857],
    [2.03, 12.6351],
    [2.43, 14.6804],
    [2.75, 17.4],
    [3.07, 20.1058],
    [3.26, 22.4502],
    [3.45, 24.653],
  ],
};
