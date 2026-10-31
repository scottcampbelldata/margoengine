// The Plaza square's layout and its protection rule, and nothing of terrain or the generator, so that a page asks the
// same isPlazaProtected as the shard without loading either. plaza.ts re-exports all of it and adds the generator.
// Pure functions: the generator threads stamp the cells, and the shard's edit rule (server/shard.mjs) asks which are
// protected.

/** What the sign says, word for word. */
export const PLAZA_SIGN = 'Margo Engine ❤️ made for Margie';
/** The sign's lines, top first; joined with spaces they are {@link PLAZA_SIGN}. */
export const PLAZA_SIGN_LINES: readonly string[] = ['Margo Engine', '❤️ made for', 'Margie'];
/** Radius of the stone disc in blocks, around the origin. */
export const PLAZA_RADIUS = 24;
/** Cells up to this far above the floor are protected over the whole disc. */
export const PLAZA_HEADROOM = 12;
/** Stone under the floor, in blocks, so the square never floats over a valley. */
export const PLAZA_FOUNDATION = 32;

const HEART = '❤';
/**
 * The sign's size: every glyph pixel is this many blocks wide and high. The one place to change it; the layout, the
 * wall and the protected area all follow.
 */
export const PLAZA_SIGN_SCALE = 1;
/** Rows a glyph may hang below the baseline (the tail of a g). */
export const PLAZA_GLYPH_DESCENT = 2;
/** Rows of a full glyph: 7 above the baseline's row and the descent below it. */
export const PLAZA_GLYPH_ROWS = 7 + PLAZA_GLYPH_DESCENT;
/**
 * The sign's 5-wide glyphs, top row first. Row 6 sits on the baseline; a glyph with more than 7 rows hangs below it,
 * and one with fewer is padded with empty rows. Tests read the sign back with them.
 */
export const PLAZA_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  d: ['00001', '00001', '01101', '10011', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01001', '01000', '11100', '01000', '01000', '01000'],
  // Bowl at the height of a, e and o, a stem down the right with two rows under the baseline, and the hook.
  g: ['00000', '00000', '01110', '10001', '10001', '10001', '01111', '00001', '01110'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10001', '10001'],
  n: ['00000', '00000', '10110', '11001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  [HEART]: ['01010', '11111', '11111', '11111', '01110', '00100', '00000'],
};

const S = PLAZA_SIGN_SCALE,
  // The characters of a line that take space: the emoji's variation selector does not.
  charsOf = (line: string): string[] => [...line].filter((c) => c !== '️'),
  WIDEST = Math.max(...PLAZA_SIGN_LINES.map((line) => charsOf(line).length));

/** A glyph's width plus a gap, in blocks. */
export const PLAZA_SIGN_STEP = 6 * S;
/** A line's height: the glyph, its descent and a gap, in blocks. */
export const PLAZA_SIGN_LINE = (PLAZA_GLYPH_ROWS + 1) * S;
/** The first letter row above the floor, with room for the descent of the last line. */
export const PLAZA_SIGN_BOTTOM = PLAZA_GLYPH_DESCENT * S + 1;
/** The block x of the left edge of a line of `count` characters (the text is centred on x = 0). */
export const plazaSignLeft = (count: number): number => -Math.floor((count * PLAZA_SIGN_STEP - S) / 2);
/** The height above the floor of the baseline row's bottom, for the line at `row` (0 is the top line). */
export const plazaSignBase = (row: number): number =>
  PLAZA_SIGN_BOTTOM + (PLAZA_SIGN_LINES.length - 1 - row) * PLAZA_SIGN_LINE;

/** The wall's z; the letters stand one block in front of it, on the side that faces the disc. */
export const PLAZA_WALL_Z = -PLAZA_RADIUS - 1;
/** Half the wall's width: its x runs from minus this to this. */
export const PLAZA_WALL_HALF = Math.ceil((WIDEST * PLAZA_SIGN_STEP - S) / 2) + 2;
/** The wall's top above the floor: one above the top row of letters. */
export const PLAZA_WALL_TOP = plazaSignBase(0) + 7 * S;

// The floor before the wall is level and clear over the convex hull of the disc and the wall's face, so that no hill
// stands between a letter and anyone on the disc. The rectangle over the wall's width, out to where the line from the
// wall's corner touches the disc, contains that hull.
const APRON_Z = (() => {
  const px = PLAZA_WALL_HALF,
    pz = PLAZA_WALL_Z + 1,
    distance = Math.hypot(px, pz);
  return Math.ceil(PLAZA_RADIUS * Math.sin(Math.atan2(pz, px) + Math.acos(PLAZA_RADIUS / distance)));
})();

// Sign cells by 'x,height above the floor'. Text reads left to right from the disc, looking towards -z: towards +x.
/** The sign's cells by 'x,height above the floor'. */
export const PLAZA_SIGN_CELLS = new Map<string, 'letter' | 'heart'>();
PLAZA_SIGN_LINES.forEach((line, row) => {
  const chars = charsOf(line),
    left = plazaSignLeft(chars.length),
    base = plazaSignBase(row);
  chars.forEach((char, i) => {
    if (char === ' ') return;
    const glyph = PLAZA_GLYPHS[char];
    for (let y = 0; y < glyph.length; y++)
      for (let x = 0; x < 5; x++)
        if (glyph[y][x] === '1')
          for (let dy = 0; dy < S; dy++)
            for (let dx = 0; dx < S; dx++)
              PLAZA_SIGN_CELLS.set(
                `${left + i * PLAZA_SIGN_STEP + x * S + dx},${base + (6 - y) * S + dy}`,
                char === HEART ? 'heart' : 'letter',
              );
  });
});

/** Whether column (x, z) is on the stone disc. */
export const onDisc = (x: number, z: number): boolean => x * x + z * z <= PLAZA_RADIUS * PLAZA_RADIUS;
/** Whether column (x, z) is on the level floor before the sign wall. */
export const onApron = (x: number, z: number): boolean =>
  Math.abs(x) <= PLAZA_WALL_HALF && z >= PLAZA_WALL_Z && z <= APRON_Z;

/**
 * Whether a player may not change cell (x, y, z) in a world whose floor is at `floor`: the disc from the foundation up
 * to {@link PLAZA_HEADROOM} above the floor; the wall, the space before it and the block behind it up past the wall's
 * top. Above that, and everywhere else, players may build.
 */
export function isPlazaProtected(x: number, y: number, z: number, floor: number): boolean {
  if (y < floor - PLAZA_FOUNDATION) return false;
  if (onApron(x, z) || (Math.abs(x) <= PLAZA_WALL_HALF && z === PLAZA_WALL_Z - 1))
    return y <= floor + PLAZA_WALL_TOP + 1;
  return onDisc(x, z) && y <= floor + PLAZA_HEADROOM;
}

/** Whether a player may spawn at column (x, z): off the disc, and clear of the wall and the floor before it. */
export function isPlazaSpawnClear(x: number, z: number): boolean {
  return !onDisc(x, z) && !(Math.abs(x) <= PLAZA_WALL_HALF + 2 && z >= PLAZA_WALL_Z - 3 && z <= APRON_Z + 2);
}
