// A small IGES 5.3 fixed-format writer for the tests, from the specification's chapter 2: 80-column lines, a Start
// line, the Global section's 25 fields, two Directory Entry lines per entity (20 fields of 8 columns), Parameter Data
// in columns 1-64 with the entity's DE pointer in 66-72, and the Terminate line's counts.
//
// An entity is { type, params, form?, transform?, color?, status?, label? }. In params, { ref: i } is a pointer to
// entity i (0-based in the list), { h: 'text' } a Hollerith string, a number is written as it is, null is an empty field.
// `transform` is also an entity index.

const de = (i) => 2 * i + 1;
const pad = (s, n) => String(s).padStart(n, ' ');

function token(v) {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'object' && 'ref' in v) return { text: String(de(v.ref)) };
  if (typeof v === 'object' && 'h' in v) return { text: `${v.h.length}H${v.h}`, string: true };
  if (typeof v === 'object' && 'neg' in v) return { text: String(-de(v.neg)) };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`not finite: ${v}`);
    return { text: Number.isInteger(v) ? String(v) : String(v).replace('e', 'D') };
  }
  return { text: String(v) };
}

/** Lays delimited fields into lines of `width` columns; strings may cross lines, numbers never do. */
function pack(values, width, pd, rd) {
  const lines = [];
  let line = '';
  values.forEach((v, i) => {
    const t = token(v),
      text = t.text + (i === values.length - 1 ? rd : pd);
    if (line.length + text.length <= width) {
      line += text;
      return;
    }
    if (t.string && line.length + t.text.indexOf('H') + 2 <= width) {
      // The count and H stay on this line; the characters run on to the next.
      let rest = text;
      while (line.length + rest.length > width) {
        const take = width - line.length;
        line += rest.slice(0, take);
        lines.push(line);
        line = '';
        rest = rest.slice(take);
      }
      line += rest;
      return;
    }
    lines.push(line);
    line = text;
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  });
  if (line) lines.push(line);
  return lines;
}

/**
 * The text of an IGES file holding `entities`.
 * @param {object[]} entities
 * @param {{ units?: number, unitsName?: string, scale?: number, pd?: string, rd?: string, resolution?: number,
 *   maxCoordinate?: number, author?: string, start?: string[], defaults?: boolean }} [options] `defaults` leaves
 *   the delimiter fields empty (comma and semicolon by default).
 */
export function writeIGES(entities, options = {}) {
  const {
    units = 2,
    unitsName = units === 1 ? 'INCH' : units === 6 ? 'M' : 'MM',
    scale = 1,
    pd = ',',
    rd = ';',
    resolution = 1e-6,
    maxCoordinate = 100,
    author = 'Margo tests',
    start = ['Margo brep test file, written from the IGES 5.3 specification.'],
    defaults = false,
  } = options;
  const S = start.map((s) => s.padEnd(72, ' ').slice(0, 72));
  const global = [
    defaults ? null : { h: pd },
    defaults ? null : { h: rd },
    { h: 'MARGO-TEST' },
    { h: 'test.igs' },
    { h: 'Margo engine tests' },
    { h: '1.0' },
    32,
    38,
    6,
    308,
    15,
    { h: 'MARGO-TEST' },
    scale,
    units,
    { h: unitsName },
    1,
    0.01,
    { h: '20261024.120000' },
    resolution,
    maxCoordinate,
    { h: author },
    { h: 'Margo' },
    11,
    0,
    { h: '20261024.120000' },
  ];
  const G = pack(global, 72, pd, rd);
  const D = [],
    P = [];
  entities.forEach((e, i) => {
    const lines = pack([e.type, ...e.params], 64, pd, rd),
      first = P.length + 1;
    for (const l of lines) P.push(`${l.padEnd(64, ' ')} ${pad(de(i), 7)}`);
    const status = e.status ?? '00000000',
      transform = e.transform === undefined ? 0 : de(e.transform),
      color = e.color === undefined ? '' : typeof e.color === 'object' ? -de(e.color.ref) : e.color;
    D.push(
      [e.type, first, 0, 0, 0, 0, transform, 0].map((v) => pad(v, 8)).join('') + pad(status, 8),
      [e.type, 0, color, lines.length, e.form ?? 0, '', '', e.label ?? '', 0].map((v) => pad(v, 8)).join(''),
    );
  });
  const seq = (letter, rows) => rows.map((r, i) => `${r.padEnd(72, ' ').slice(0, 72)}${letter}${pad(i + 1, 7)}`);
  const T = `S${pad(S.length, 7)}G${pad(G.length, 7)}D${pad(D.length, 7)}P${pad(P.length, 7)}`;
  return [...seq('S', S), ...seq('G', G), ...seq('D', D), ...seq('P', P), ...seq('T', [T])].join('\n') + '\n';
}
