// Plaza's anonymous two-word names. No free text is ever shown to other players: the page picks a name here, and the
// shard (server/shard.mjs) replaces anything that is not a pairing of these two lists. Plain data, no DOM.
//
// The lists avoid words with a second meaning on purpose (no animals used as insults, no body or food slang, no colours
// that could describe people), so that every one of the 4,096 pairings is harmless. test/names.test.js also scans each
// pairing, joined and spaced, against an encoded list of rude words.

/** First words: plain describing words. */
export const FIRST_WORDS: readonly string[] = [
  'Amber',
  'Autumn',
  'Bright',
  'Breezy',
  'Calm',
  'Cedar',
  'Cheerful',
  'Clever',
  'Cloudy',
  'Copper',
  'Coral',
  'Cozy',
  'Crisp',
  'Curious',
  'Dawn',
  'Eager',
  'Evening',
  'Fern',
  'Friendly',
  'Frosty',
  'Gentle',
  'Glowing',
  'Golden',
  'Hazel',
  'Helpful',
  'Hopeful',
  'Humble',
  'Icy',
  'Jolly',
  'Keen',
  'Kind',
  'Lively',
  'Lucky',
  'Maple',
  'Mellow',
  'Merry',
  'Misty',
  'Modest',
  'Morning',
  'Mossy',
  'Neat',
  'Oak',
  'Patient',
  'Peaceful',
  'Pine',
  'Playful',
  'Polite',
  'Quiet',
  'Rainy',
  'Ready',
  'Rocky',
  'Silver',
  'Sincere',
  'Sleepy',
  'Spring',
  'Steady',
  'Summer',
  'Sunny',
  'Tidy',
  'Velvet',
  'Warm',
  'Willow',
  'Windy',
  'Winter',
];

/** Second words: places, things and small birds. */
export const SECOND_WORDS: readonly string[] = [
  'Acorn',
  'Anchor',
  'Arbor',
  'Atlas',
  'Basket',
  'Beacon',
  'Bell',
  'Bridge',
  'Brook',
  'Builder',
  'Cairn',
  'Cabin',
  'Candle',
  'Canyon',
  'Castle',
  'Cloud',
  'Comet',
  'Harvest',
  'Cottage',
  'Creek',
  'Crystal',
  'Dune',
  'Falcon',
  'Finch',
  'Forest',
  'Gable',
  'Garden',
  'Glacier',
  'Harbor',
  'Heron',
  'Hill',
  'Island',
  'Trellis',
  'Kite',
  'Ladder',
  'Marsh',
  'Lantern',
  'Lark',
  'Library',
  'Lighthouse',
  'Mason',
  'Meadow',
  'Mill',
  'Mountain',
  'Orchard',
  'Pebble',
  'Pilot',
  'Pond',
  'Quilt',
  'Terrace',
  'Ribbon',
  'Ridge',
  'River',
  'Robin',
  'Sailor',
  'Signal',
  'Sparrow',
  'Trail',
  'Teapot',
  'Tower',
  'Valley',
  'Village',
  'Voyager',
  'Wren',
];

/**
 * A random two-word name such as `Amber Lantern`.
 * @param random Returns a number from 0 up to 1; defaults to `Math.random`.
 */
export function randomName(random: () => number = Math.random): string {
  const pick = (words: readonly string[]) =>
    words[Math.min(words.length - 1, Math.max(0, Math.floor(random() * words.length)))];
  return `${pick(FIRST_WORDS)} ${pick(SECOND_WORDS)}`;
}

const FIRST_SET = new Set(FIRST_WORDS),
  SECOND_SET = new Set(SECOND_WORDS);

/** Whether `name` is exactly one first word, one space and one second word, with the lists' capitals. */
export function isPlazaName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const parts = name.split(' ');
  return parts.length === 2 && FIRST_SET.has(parts[0]) && SECOND_SET.has(parts[1]);
}
