// The moon's named phases (`night.moonPhase`), apart from moonlight.ts so the night entry carries no colour maths.
/** A named phase for `night.moonPhase`; `half` and `quarter` are the first quarter. */
export type MoonPhaseName =
  | 'new'
  | 'waxingCrescent'
  | 'firstQuarter'
  | 'waxingGibbous'
  | 'full'
  | 'waningGibbous'
  | 'lastQuarter'
  | 'waningCrescent'
  | 'half'
  | 'quarter';
/** `night.moonPhase`: -1 (new) to 1 (full), clamped, or a {@link MoonPhaseName}. */
export type MoonPhase = number | MoonPhaseName;
const octant = Math.SQRT1_2;
/**
 * The named phases. `phase` is the cosine of the phase angle, so (phase + 1) / 2 of the disc is lit, as `night`'s
 * `moonPhase`; `waning` lights the other limb, the left one as seen from the northern hemisphere. The principal phases
 * fall at elongations of 0, 90, 180 and 270 degrees (J. Meeus, "Astronomical Algorithms", 2nd ed., Willmann-Bell 1998,
 * ch. 49): new -1, the quarters 0 (half lit), full 1. A crescent or gibbous moon is the octant between two of them and
 * takes its middle, a phase angle of 135 or 45 degrees: crescent cos 135 deg = -0.7071 (14.6% lit), gibbous 0.7071
 * (85.4% lit).
 */
export const MOON_PHASES: Readonly<Record<MoonPhaseName, { readonly phase: number; readonly waning: boolean }>> = {
  new: { phase: -1, waning: false },
  waxingCrescent: { phase: -octant, waning: false },
  firstQuarter: { phase: 0, waning: false },
  waxingGibbous: { phase: octant, waning: false },
  full: { phase: 1, waning: false },
  waningGibbous: { phase: octant, waning: true },
  lastQuarter: { phase: 0, waning: true },
  waningCrescent: { phase: -octant, waning: true },
  half: { phase: 0, waning: false },
  quarter: { phase: 0, waning: false },
};
const named = (phase: MoonPhase) => {
  const entry = typeof phase === 'string' && Object.hasOwn(MOON_PHASES, phase) ? MOON_PHASES[phase] : undefined;
  if (!entry && !(typeof phase === 'number' && Number.isFinite(Math.fround(phase))))
    throw new RangeError(
      `Invalid moon phase ${String(phase)}; give a number from -1 to 1 or one of ${Object.keys(MOON_PHASES).join(', ')}.`,
    );
  return entry;
};
/**
 * The numeric phase (-1 new to 1 full) of a {@link MoonPhase}: a name's from {@link MOON_PHASES}, a number clamped.
 * @throws RangeError for an unknown name or a non-finite number.
 * @example moonPhase('waxingGibbous'); // 0.7071
 */
export function moonPhase(phase: MoonPhase): number {
  return named(phase)?.phase ?? Math.max(-1, Math.min(1, phase as number));
}
/**
 * Whether a {@link MoonPhase} is waning (its lit limb on the left); numbers are waxing.
 * @throws RangeError for an unknown name or a non-finite number.
 */
export function moonWaning(phase: MoonPhase): boolean {
  return named(phase)?.waning ?? false;
}
