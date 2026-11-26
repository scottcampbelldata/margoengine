/** Layout-1 f64 data, in patch order. */
export const CRUSH_LAYOUT = 1;
/** Each row stores permanent stroke, work, peak stroke, peak force, impulse, elastic work, seal loss and count. */
export const CRUSH_WORDS = 8;
/** Position of the dimensionless seal loss within a damage record. */
export const CRUSH_SEAL_LOSS_WORD = 6;
/** Quantity used by the crush damage field. */
export const CRUSH_DAMAGE_QUANTITY = 'crushDamage';
