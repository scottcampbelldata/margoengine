// The angle a contact cluster takes and the cosine the kernel holds for it. Its own file because the files of a step may not name
// `Math` (tests/step-path.test.js): setting an option is not part of a step, but the kernel's file is.

/** The quarter turn: a clustering angle must be under it. */
export const QUARTER_TURN = Math.PI / 2;
/** The cosine of an angle in radians, as the kernel keeps it. */
export const cosineOf = (angle: number): number => Math.cos(angle);
/** The angle in radians whose cosine the kernel keeps. */
export const angleOf = (cosine: number): number => Math.acos(cosine);
