// The KCS container ship's 2.19 m model (scale 1 : 105) with its roll, for the four-degree-of-freedom MMG method (SEA-09).
// Particulars, hull derivatives with their heel terms, and the propeller and rudder interaction constants from Y. Fukui,
// H. Yokota, H. Yano, M. Kondo, T. Nakano and Y. Yoshimura, J. JASNAOE 24, 167-179, 2016 (Tables 1, 3 and 4, read), turned
// from their drift angle beta = atan(-v / u) to MMG's v' (v' = -beta in the odd powers), their captive tests' combined
// Y'_r - m'_x and X'_beta r - m'_y returned to MMG's Y'_r and X'_vr by the added masses. GM 0.60 m, k_xx 0.40 B and the
// rudder rate 2.32 deg/s full scale from the SIMMAN 2008 workshop's KCS conditions (simman2008.dk, read). The open-water
// curve is a least-squares quadratic through the SVA stock propeller VP1193 (P / D 1.0) table SIMMAN 2014 publishes (read).
// What no source read gives is filled and named: the added masses by Brix (surge) and Clarke (sway, yaw), as empiricalModel
// gives them; the propeller's position x'_P -0.48 and its wake's change with drift, KVLCC2's (Yasukawa and Yoshimura 2015);
// the rudder's lift slope by Fujii's formula for its aspect ratio 2.168.
import type { ManoeuvringModel } from './mmg.js';
import type { PropellerCurves } from './propeller.js';

/** SIMMAN 2014's SVA stock propeller VP1193 (P / D 1.0), K_T and K_Q fitted as quadratics in J over J 0 to 1. */
export const KCS_PROPELLER: PropellerCurves = Object.freeze({
  thrust: [0.50239, -0.33806, -0.13576] as const,
  torque: [0.072492, -0.039802, -0.021634] as const,
  pitch: 1,
});

/** KCS's added masses (Brix, Clarke): m'_x, m'_y, J'_z. */
const MX = 0.005353,
  MY = 0.1786,
  JZ = 0.010344,
  /** The model's draught and the full-scale GM and KM / d over the scale. */
  D = 0.1029,
  GM = 0.6 / (230 / 2.1905),
  KM = 1.3839 * D;

/**
 * KCS's 2.19 m model (Fukui et al. 2016), at GM 0.60 m full scale, with its heel: run it at Fn 0.26 (1.206 m/s) with a
 * rudder rate of 2.32 deg/s times sqrt(105); scale it with `scaleModel` for the 230 m ship.
 */
export const KCS_MODEL: ManoeuvringModel = Object.freeze({
  length: 2.1905,
  beam: 0.3067,
  draught: D,
  volume: 0.6505 * 2.1905 * 0.3067 * D,
  centre: -0.0148 * 2.1905,
  gyration: 0.25 * 2.1905,
  addedMass: [MX, MY, JZ] as const,
  resistance: 0.0183,
  surge: [-0.0603, 0.1218 - MY, -0.0162, -0.076] as const,
  sway: [-0.2162, 0.0245 + MX, -1.7028, -0.5658, -0.8564, -0.0105] as const,
  yaw: [-0.1172, -0.0443, -0.171, -0.5602, -0.02, -0.0369] as const,
  propeller: {
    diameter: 0.0756,
    curves: KCS_PROPELLER,
    position: -0.48,
    thrustDeduction: 0.178,
    wake: 0.353,
    wakeChange: [2.0, 1.6, 1.1] as const,
  },
  rudder: {
    area: (2.1905 * D) / 53.57,
    span: Math.sqrt((2.168 * 2.1905 * D) / 53.57),
    liftSlope: (6.13 * 2.168) / (2.168 + 2.25),
    resistanceDeduction: 0.441,
    forceIncrease: 0.232,
    forcePosition: -0.711,
    straightening: [0.412, 0.412] as const,
    lever: -0.774,
    wakeRatio: 0.9,
    kappa: 0.713,
  },
  heel: {
    metacentricHeight: GM,
    // Below the water plane: the draught less KG = KM - GM.
    gravityDepth: D - (KM - GM),
    straightening: -0.36,
    // Calibrated, as Fukui et al. print neither (docs/clean-room.md): the roll lever of the rudder's side force, 0.236 of
    // the draught below the water plane (its geometric centroid is 0.54), and the roll decay coefficient a = 1.0, fitted to
    // MARIN's final and largest roll in the 35 degree turn (5.09 and 16.98 degrees) and checked against KRISO's three model
    // scales, the port turn and the zigzags.
    rudderDepth: 0.236 * D,
    decay: 1.0,
    // c_x0 X'_0, X'_r phi, c_xbb X'_bb, c_xrr X'_rr.
    surge: [-0.12 * -0.0183, 0.0258, 2.31 * -0.0603, 3.5 * -0.0162] as const,
    // Y'_phi, c_yb Y'_v, c_yr (Y'_r - m'_x), Y'_bb phi, -Y'_br phi, Y'_rr phi.
    sway: [-0.0052, 0.05 * -0.2162, -1.2 * 0.0245, 0.3352, -0.3123, -0.0642] as const,
    yaw: [-0.0063, 0.21 * -0.1172, -0.32 * -0.0443, -0.2532, -0.1152, -0.012] as const,
    // K' about the water plane: K'_phi, -K'_b, K'_r, K'_bb phi, -K'_br phi, K'_rr phi, -K'_bbb, K'_bbr, -K'_brr, K'_rrr.
    roll: [-0.0299, 0.1367, 0.0085, 0.2819, -0.2997, -0.0487, 1.4352, 1.1636, 0.4233, 0.0363] as const,
  },
});
