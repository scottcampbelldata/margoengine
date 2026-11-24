import type { OutlineCommand } from './outline.js';
import { BinaryReader, fontError } from './sfnt-reader.js';
import { FontItemStore } from './sfnt-variation.js';
// CFF and CFF2 outlines, clean room from Adobe Technical Notes #5176 (The Compact Font Format Specification) and
// #5177 (The Type 2 Charstring Format), and the OpenType specification's CFF2 chapter.

// Numerical character-set data from Adobe Technical Note #5176, Appendix C (GID order).
const cffExpert = [
  0,
  1,
  229,
  230,
  231,
  232,
  233,
  234,
  235,
  236,
  237,
  238,
  13,
  14,
  15,
  99,
  ...Array.from({ length: 10 }, (_, i) => 239 + i),
  27,
  28,
  ...Array.from({ length: 18 }, (_, i) => 249 + i),
  109,
  110,
  ...Array.from({ length: 52 }, (_, i) => 267 + i),
  158,
  155,
  163,
  ...Array.from({ length: 8 }, (_, i) => 319 + i),
  150,
  164,
  169,
  ...Array.from({ length: 52 }, (_, i) => 327 + i),
];
const cffExpertSubset = [
  0,
  1,
  231,
  232,
  235,
  236,
  237,
  238,
  13,
  14,
  15,
  99,
  ...Array.from({ length: 10 }, (_, i) => 239 + i),
  27,
  28,
  249,
  250,
  251,
  ...Array.from({ length: 14 }, (_, i) => 253 + i),
  109,
  110,
  267,
  268,
  269,
  270,
  272,
  300,
  301,
  302,
  305,
  314,
  315,
  158,
  155,
  163,
  ...Array.from({ length: 7 }, (_, i) => 320 + i),
  150,
  164,
  169,
  ...Array.from({ length: 20 }, (_, i) => 327 + i),
];
function standardSID(code: number): number {
  if (!Number.isInteger(code) || code < 0 || code > 255) fontError('a Type 2 composite character code is invalid');
  if (code >= 32 && code <= 126) return code - 31;
  const ranges = [
    [161, 175, 96],
    [177, 180, 111],
    [182, 189, 115],
    [191, 191, 123],
    [193, 200, 124],
    [202, 203, 132],
    [205, 208, 134],
    [225, 225, 138],
    [227, 227, 139],
    [232, 235, 140],
    [241, 241, 144],
    [245, 245, 145],
    [248, 251, 146],
  ];
  for (const [first, last, sid] of ranges) if (code >= first && code <= last) return sid + code - first;
  return 0;
}

type Dict = Map<number, number | number[]>;
interface FontDict {
  subrs: Uint8Array[];
  vsindex: number;
  matrix: number[];
}
type Six = [number, number, number, number, number, number];

const DEFAULT_MATRIX = [0.001, 0, 0, 0.001, 0, 0];
/** Bytes a charstring and its subroutines may execute before the glyph is refused. */
const EXECUTION_BUDGET = 100_000;

const validMatrix = (m: unknown): m is number[] =>
  Array.isArray(m) && m.length === 6 && m.every((v) => Number.isFinite(v));

/**
 * The CFF (`'CFF '`) or CFF2 outlines of one font. `commands(glyph)` runs the glyph's Type 2 charstring (blends at the
 * font's variation coordinates for CFF2) into move, line and cubic commands in font units: the FontMatrix (and a
 * CFF2 Font DICT's own matrix) times units per em.
 */
export class CFFOutlines {
  private readonly charStrings: Uint8Array[];
  private readonly globalSubrs: Uint8Array[];
  private localSubrs: Uint8Array[] = [];
  private charset: number[] = [];
  private matrix: number[] = DEFAULT_MATRIX;
  private store?: FontItemStore;
  private fontDicts: FontDict[] = [];
  private select: number[] = [];

  constructor(
    r: BinaryReader,
    private readonly cff2: boolean,
    private readonly glyphCount: number,
    private readonly unitsPerEm: number,
    private readonly coordinates: readonly number[],
  ) {
    const parsed = cff2 ? this.parseCFF2(r) : this.parseCFF(r);
    this.charStrings = parsed.charStrings;
    this.globalSubrs = parsed.globalSubrs;
  }

  /** Font units of a font matrix: the matrix times units per em. */
  private scaled(m: readonly number[]): number[] {
    return m.map((v) => v * this.unitsPerEm);
  }

  private parseCFF2(r: BinaryReader) {
    if (r.u8() !== 2 || r.u8() !== 0) fontError('the CFF2 table version is not 2.0', 'unsupported');
    const header = r.u8(),
      topLength = r.u16();
    if (header < 5) fontError('the CFF2 header is shorter than 5 bytes');
    const top = this.parseDict(r.slice(header, topLength).bytes);
    r.seek(header + topLength);
    const globalSubrs = this.readIndex(r);
    const offset = (dict: Dict, op: number): number => {
      const v = dict.get(op);
      if (!Number.isInteger(v) || (v as number) < 0) fontError(`CFF2 offset operator ${op} is invalid`);
      return v as number;
    };
    if (top.get(24) !== undefined) {
      r.seek(offset(top, 24));
      const length = r.u16();
      this.store = new FontItemStore(r.slice(r.pos, length), this.coordinates);
    }
    r.seek(offset(top, 17));
    const charStrings = this.readIndex(r);
    if (charStrings.length !== this.glyphCount) fontError("the CFF2 CharStrings count differs from 'maxp'");
    const matrix = top.get(0x0c07) ?? DEFAULT_MATRIX;
    if (!validMatrix(matrix)) fontError('the CFF2 FontMatrix is invalid');
    r.seek(offset(top, 0x0c24));
    const dicts = this.readIndex(r);
    if (!dicts.length) fontError('the CFF2 Font DICT INDEX is empty');
    this.fontDicts = dicts.map((bytes) => {
      const dict = this.parseDict(bytes),
        priv = dict.get(18);
      let subrs: Uint8Array[] = [],
        vsindex = 0;
      if (priv !== undefined) {
        if (!Array.isArray(priv) || priv.length !== 2) fontError('a CFF2 Private DICT range is invalid');
        const [length, start] = priv,
          p = this.parseDict(r.slice(start, length).bytes);
        vsindex = Number(p.get(22) ?? 0);
        if (p.has(19)) {
          r.seek(start + offset(p, 19));
          subrs = this.readIndex(r);
        }
      }
      let combined = matrix;
      const local = dict.get(0x0c07);
      if (local !== undefined) {
        if (!validMatrix(local)) fontError('a CFF2 Font DICT matrix is invalid');
        const [a, b, c, d, x, y] = matrix,
          [e, f, g, h, u, v] = local;
        combined = [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * u + c * v + x, b * u + d * v + y];
      }
      return { subrs, vsindex, matrix: this.scaled(combined) };
    });
    this.select = new Array<number>(this.glyphCount).fill(0);
    if (top.has(0x0c25)) {
      r.seek(offset(top, 0x0c25));
      const format = r.u8();
      if (format === 0) for (let i = 0; i < this.glyphCount; i++) this.select[i] = r.u8();
      else if (format === 3 || format === 4) {
        const wide = format === 4,
          n = wide ? r.u32() : r.u16();
        const ranges = Array.from({ length: n }, () => ({ first: wide ? r.u32() : r.u16(), fd: wide ? r.u16() : r.u8() }));
        const sentinel = wide ? r.u32() : r.u16();
        if (!n || ranges[0].first !== 0 || sentinel !== this.glyphCount) fontError('the CFF2 FDSelect range is invalid');
        for (let i = 0; i < n; i++) {
          const end = i + 1 < n ? ranges[i + 1].first : sentinel;
          if (end <= ranges[i].first || end > this.glyphCount) fontError('the CFF2 FDSelect ranges are out of order');
          this.select.fill(ranges[i].fd, ranges[i].first, end);
        }
      } else fontError(`CFF2 FDSelect format ${format} is unknown`, 'unsupported');
    } else if (dicts.length !== 1) fontError('the CFF2 font has several Font DICTs and no FDSelect');
    if (this.select.some((i) => i >= dicts.length)) fontError('the CFF2 FDSelect refers to a missing Font DICT');
    return { charStrings, globalSubrs };
  }

  private parseCFF(r: BinaryReader) {
    if (r.u8() !== 1) fontError('the CFF table version is not 1', 'unsupported');
    r.u8();
    const headerSize = r.u8(),
      offSize = r.u8();
    if (headerSize < 4 || offSize < 1 || offSize > 4) fontError('the CFF header is invalid');
    r.seek(headerSize);
    const names = this.readIndex(r),
      topItems = this.readIndex(r);
    if (names.length !== 1 || topItems.length !== 1) fontError('the CFF FontSet holds more or fewer than one font');
    const top = this.parseDict(topItems[0]);
    if (top.has(0x0c1e) || top.has(0x0c24) || top.has(0x0c25))
      fontError('the font has CID-keyed CFF outlines, which are not read', 'unsupported');
    if (top.has(0x0c14)) fontError('the font has synthetic CFF outlines, which are not read', 'unsupported');
    if (top.has(0x0c06) && top.get(0x0c06) !== 2) fontError('the CFF CharstringType is not 2', 'unsupported');
    const matrix = top.get(0x0c07) ?? DEFAULT_MATRIX;
    if (!validMatrix(matrix)) fontError('the CFF FontMatrix is invalid');
    this.matrix = this.scaled(matrix);
    this.readIndex(r);
    const globalSubrs = this.readIndex(r);
    const charOffset = top.get(17);
    if (typeof charOffset !== 'number') fontError('the CFF CharStrings offset is missing');
    r.seek(charOffset);
    const charStrings = this.readIndex(r);
    if (charStrings.length !== this.glyphCount) fontError("the CFF CharStrings count differs from 'maxp'");
    const charsetOffset = top.get(15) ?? 0;
    if (typeof charsetOffset !== 'number') fontError('the CFF charset offset is invalid');
    if (charsetOffset <= 2) {
      const preset =
        charsetOffset === 0
          ? Array.from({ length: 229 }, (_, i) => i)
          : charsetOffset === 1
            ? cffExpert
            : cffExpertSubset;
      if (!Number.isInteger(charsetOffset) || charsetOffset < 0 || charStrings.length > preset.length)
        fontError('the CFF predefined charset is invalid');
      this.charset = preset.slice(0, charStrings.length);
    } else {
      r.seek(charsetOffset);
      const format = r.u8();
      this.charset = [0];
      if (format > 2) fontError(`CFF charset format ${format} is unknown`);
      while (this.charset.length < charStrings.length) {
        const first = r.u16(),
          left = format === 0 ? 0 : format === 1 ? r.u8() : r.u16();
        if (this.charset.length + left + 1 > charStrings.length || first + left > 65535)
          fontError('a CFF charset range is invalid');
        for (let i = 0; i <= left; i++) this.charset.push(first + i);
      }
    }
    if (new Set(this.charset).size !== this.charset.length) fontError('the CFF charset repeats a SID');
    const priv = top.get(18);
    if (priv !== undefined) {
      if (!Array.isArray(priv) || priv.length !== 2) fontError('the CFF Private DICT range is invalid');
      const [length, offset] = priv;
      const dict = this.parseDict(r.slice(offset, length).bytes);
      if (dict.has(19)) {
        const rel = dict.get(19);
        if (typeof rel !== 'number') fontError('the CFF Subrs offset is invalid');
        r.seek(offset + rel);
        this.localSubrs = this.readIndex(r);
      }
    }
    return { charStrings, globalSubrs };
  }

  private readIndex(r: BinaryReader): Uint8Array[] {
    const count = this.cff2 ? r.u32() : r.u16();
    if (count > 65536) fontError('a CFF INDEX holds more than 65536 items');
    if (!count) return [];
    const size = r.u8();
    if (size < 1 || size > 4) fontError('a CFF INDEX offSize is outside 1 to 4');
    r.check(r.pos, (count + 1) * size);
    const offsets = Array.from({ length: count + 1 }, () => {
      let offset = 0;
      for (let j = 0; j < size; j++) offset = offset * 256 + r.u8();
      return offset;
    });
    if (offsets[0] !== 1) fontError("a CFF INDEX's first offset is not 1");
    const start = r.pos,
      items: Uint8Array[] = [];
    for (let i = 0; i < count; i++) items.push(r.slice(start + offsets[i] - 1, offsets[i + 1] - offsets[i]).bytes);
    r.seek(start + offsets[count] - 1);
    return items;
  }

  private parseDict(bytes: Uint8Array): Dict {
    const r = new BinaryReader(bytes),
      cff2 = this.cff2,
      dict: Dict = new Map(),
      stack: number[] = [];
    while (r.pos < r.length) {
      const b = r.u8();
      if (cff2 && b === 23) {
        const n = stack.pop()!;
        const weights = this.store?.weights(Number(dict.get(22) ?? 0)) ?? fontError('a CFF2 DICT blends with no variation store');
        const start = stack.length - n * (weights.length + 1);
        if (!Number.isInteger(n) || n < 1 || start < 0) fontError('a CFF2 DICT blend operand count is invalid');
        for (let i = 0; i < n; i++)
          for (let j = 0; j < weights.length; j++) stack[start + i] += weights[j] * stack[start + n + i * weights.length + j];
        stack.length = start + n;
      } else if (b <= (cff2 ? 25 : 21)) {
        const op = b === 12 ? 0x0c00 + r.u8() : b;
        dict.set(op, stack.length === 1 ? stack[0] : [...stack]);
        stack.length = 0;
      } else if (b === 28) stack.push(r.i16());
      else if (b === 29) stack.push(r.i32());
      else if (b >= 32 && b <= 246) stack.push(b - 139);
      else if (b >= 247 && b <= 250) stack.push((b - 247) * 256 + r.u8() + 108);
      else if (b >= 251 && b <= 254) stack.push(-(b - 251) * 256 - r.u8() - 108);
      else if (b === 30) {
        let value = '',
          done = false;
        while (!done) {
          const byte = r.u8();
          for (const n of [byte >> 4, byte & 15]) {
            if (n === 15) {
              done = true;
              break;
            }
            if (n === 13) fontError('a CFF DICT real number has a reserved nibble');
            value += n < 10 ? String(n) : n === 10 ? '.' : n === 11 ? 'E' : n === 12 ? 'E-' : '-';
          }
        }
        const v = Number(value);
        if (!Number.isFinite(v)) fontError('a CFF DICT real number is invalid');
        stack.push(v);
      } else fontError(`a CFF DICT holds the reserved byte ${b}`);
      if (stack.length > (cff2 ? 513 : 48)) fontError('a CFF DICT operand stack exceeds its format limit');
    }
    if (stack.length) fontError('a CFF DICT ends with operands and no operator');
    return dict;
  }

  /** The glyph's outline in font units: one `'M'` per contour, `'L'` and `'C'` segments, `'Z'` at each close. */
  commands(glyph: number): OutlineCommand[] {
    const [a, b, c, d, tx, ty] = this.cff2 ? this.fontDicts[this.select[glyph]].matrix : this.matrix;
    const at = (x: number, y: number): [number, number] => [a * x + c * y + tx, b * x + d * y + ty];
    return this.raw(glyph, false).map((cmd): OutlineCommand => {
      if (cmd[0] === 'M' || cmd[0] === 'L') return [cmd[0], ...at(cmd[1], cmd[2])];
      if (cmd[0] === 'C') return ['C', ...at(cmd[1], cmd[2]), ...at(cmd[3], cmd[4]), ...at(cmd[5], cmd[6])];
      return cmd;
    });
  }

  /** Charstring space commands of one glyph; `component` marks a `seac`-style endchar accent or base. */
  private raw(glyphIndex: number, component: boolean): OutlineCommand[] {
    const charString = this.charStrings[glyphIndex],
      out: OutlineCommand[] = [];
    if (!charString) return out;
    const cff2 = this.cff2,
      fontDict = cff2 ? this.fontDicts[this.select[glyphIndex]] : undefined,
      stack: number[] = [],
      transient = new Array<number>(32).fill(0);
    let x = 0,
      y = 0,
      open = false,
      widthSeen = cff2,
      stems = 0,
      ended = false,
      operations = 0,
      seed = 1,
      vsindex = fontDict ? fontDict.vsindex : 0;
    const close = () => {
      if (open) out.push(['Z']);
      open = false;
    };
    const pop = (): number => (stack.length ? stack.pop()! : fontError('a Type 2 charstring pops an empty stack'));
    const need = (n: number) => {
      if (stack.length !== n) fontError('a Type 2 operator has the wrong operand count');
    };
    const width = (n: number, hints = false) => {
      if (!widthSeen) {
        if (hints ? stack.length % 2 === 1 : stack.length === n + 1) stack.shift();
        widthSeen = true;
      }
    };
    const move = (dx: number, dy: number) => {
      close();
      x += dx;
      y += dy;
      out.push(['M', x, y]);
      open = true;
    };
    const line = (dx: number, dy: number) => {
      if (!dx && !dy) return;
      x += dx;
      y += dy;
      out.push(['L', x, y]);
    };
    const curve = (dx1: number, dy1: number, dx2: number, dy2: number, dx3: number, dy3: number) => {
      const x1 = x + dx1,
        y1 = y + dy1,
        x2 = x1 + dx2,
        y2 = y1 + dy2;
      x = x2 + dx3;
      y = y2 + dy3;
      out.push(['C', x1, y1, x2, y2, x, y]);
    };
    const execute = (bytes: Uint8Array, depth: number): void => {
      if (depth > 10) fontError('Type 2 subroutines nest deeper than 10', 'limit');
      const r = new BinaryReader(bytes);
      while (r.pos < r.length && !ended) {
        if (++operations > EXECUTION_BUDGET)
          fontError(`a Type 2 charstring runs more than ${EXECUTION_BUDGET} operations`, 'limit');
        const b = r.u8();
        if (b === 28) stack.push(r.i16());
        else if (b >= 32 && b <= 246) stack.push(b - 139);
        else if (b >= 247 && b <= 250) stack.push((b - 247) * 256 + r.u8() + 108);
        else if (b >= 251 && b <= 254) stack.push(-(b - 251) * 256 - r.u8() - 108);
        else if (b === 255) stack.push(r.i32() / 65536);
        else if (cff2 && b === 15) {
          need(1);
          vsindex = pop();
          this.store?.weights(vsindex);
        } else if (cff2 && b === 16) {
          const n = pop(),
            weights = this.store?.weights(vsindex) ?? fontError('a CFF2 charstring blends with no variation store');
          const start = stack.length - n * (weights.length + 1);
          if (!Number.isInteger(n) || n < 1 || start < 0) fontError('a CFF2 blend operand count is invalid');
          for (let i = 0; i < n; i++)
            for (let j = 0; j < weights.length; j++) stack[start + i] += weights[j] * stack[start + n + i * weights.length + j];
          stack.length = start + n;
        } else if (b === 10 || b === 29) {
          const subrs = (b === 10 ? (fontDict ? fontDict.subrs : this.localSubrs) : this.globalSubrs) ?? [];
          const index = pop() + (subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);
          if (!Number.isInteger(index) || !subrs[index]) fontError('a Type 2 subroutine index is invalid');
          execute(subrs[index], depth + 1);
        } else if (b === 11) {
          if (cff2) fontError('a CFF2 charstring uses the reserved return operator');
          if (!depth) fontError('a Type 2 charstring returns outside a subroutine');
          return;
        } else if (b === 1 || b === 3 || b === 18 || b === 23 || b === 19 || b === 20) {
          width(0, true);
          if (stack.length % 2) fontError('a Type 2 stem hint has an odd operand count');
          if (b !== 19 && b !== 20 && stack.length < 2) fontError('a Type 2 stem hint has no pair');
          stems += stack.length / 2;
          stack.length = 0;
          if (stems > 96) fontError('a Type 2 charstring declares more than 96 hints', 'limit');
          if (b === 19 || b === 20) {
            if (!stems) fontError('a Type 2 hint mask comes before any stem hint');
            r.skip(Math.ceil(stems / 8));
          }
        } else if (b === 4 || b === 21 || b === 22) {
          const count = b === 21 ? 2 : 1;
          width(count);
          need(count);
          move(b === 4 ? 0 : stack[0], b === 22 ? 0 : stack[count - 1]);
          stack.length = 0;
        } else if (b === 14) {
          if (cff2) fontError('a CFF2 charstring uses the reserved endchar operator');
          width(stack.length >= 4 ? 4 : 0);
          if (stack.length === 4) {
            // endchar with four operands: an accented character from two standard-encoding glyphs (TN #5177, Appendix C).
            if (component || out.length) fontError('a Type 2 endchar composite is nested or follows a path');
            const [dx, dy, base, accent] = stack;
            const resolve = (code: number) => {
              const sid = standardSID(code),
                index = this.charset.indexOf(sid);
              if (!sid || index < 0) fontError("a Type 2 endchar composite's component is missing from the charset");
              return this.raw(index, true);
            };
            const first = resolve(base),
              second = resolve(accent);
            out.push(...first);
            for (const cmd of second)
              out.push(
                cmd[0] === 'Z' ? cmd : (cmd.map((v, i) => (i === 0 ? v : (v as number) + (i % 2 ? dx : dy))) as OutlineCommand),
              );
          } else if (stack.length) fontError('a Type 2 endchar has the wrong operand count');
          close();
          ended = true;
        } else if (b === 12) {
          const op = r.u8();
          if (cff2 && op < 34) fontError('a CFF2 charstring uses a reserved arithmetic operator');
          if (op >= 34 && op <= 37 && !open) fontError('a Type 2 flex comes before any moveto');
          if (op === 34) {
            need(7);
            const [a, b, c, d, e, f, g] = stack;
            curve(a, 0, b, c, d, 0);
            curve(e, 0, f, -c, g, 0);
            stack.length = 0;
          } else if (op === 35) {
            need(13);
            curve(...(stack.slice(0, 6) as Six));
            curve(...(stack.slice(6, 12) as Six));
            stack.length = 0;
          } else if (op === 36) {
            need(9);
            const [a, b, c, d, e, f, g, h, i] = stack;
            curve(a, b, c, d, e, 0);
            curve(f, 0, g, h, i, -b - d - h);
            stack.length = 0;
          } else if (op === 37) {
            need(11);
            const v = [...stack],
              sx = v[0] + v[2] + v[4] + v[6] + v[8],
              sy = v[1] + v[3] + v[5] + v[7] + v[9];
            curve(...(v.slice(0, 6) as Six));
            curve(
              v[6],
              v[7],
              v[8],
              v[9],
              Math.abs(sx) > Math.abs(sy) ? v[10] : -sx,
              Math.abs(sx) > Math.abs(sy) ? -sy : v[10],
            );
            stack.length = 0;
          } else if (op === 0) {
            /* The deprecated dotsection does not change outlines. */
          } else if (op === 18) pop();
          else if (op === 27) {
            const a = pop();
            stack.push(a, a);
          } else if (op === 28) {
            const b = pop(),
              a = pop();
            stack.push(b, a);
          } else if (op === 29) {
            const i = Math.max(0, Math.trunc(pop()));
            if (!stack.length) fontError('a Type 2 index operator reads an empty stack');
            stack.push(stack[Math.max(0, stack.length - 1 - i)]);
          } else if (op === 30) {
            const j = pop(),
              n = pop();
            if (!Number.isInteger(n) || !Number.isInteger(j) || n < 0 || n > stack.length)
              fontError('a Type 2 roll range is invalid');
            if (n) {
              const a = stack.splice(stack.length - n),
                k = ((j % n) + n) % n;
              stack.push(...a.slice(n - k), ...a.slice(0, n - k));
            }
          } else if (op === 20 || op === 21) {
            const i = pop();
            if (!Number.isInteger(i) || i < 0 || i >= 32) fontError('a Type 2 transient array index is outside 0 to 31');
            if (op === 20) transient[i] = pop();
            else stack.push(transient[i]);
          } else if (op === 22) {
            const v2 = pop(),
              v1 = pop(),
              s2 = pop(),
              s1 = pop();
            stack.push(v1 <= v2 ? s1 : s2);
          } else if (op === 23) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            stack.push((seed + 1) / 4294967296);
          } else if (op === 5 || op === 9 || op === 14 || op === 26) {
            const a = pop();
            stack.push(op === 5 ? Number(!a) : op === 9 ? Math.abs(a) : op === 14 ? -a : Math.sqrt(a));
          } else if ([3, 4, 10, 11, 12, 15, 24].includes(op)) {
            const b = pop(),
              a = pop();
            stack.push(
              op === 3
                ? Number(!!a && !!b)
                : op === 4
                  ? Number(!!a || !!b)
                  : op === 10
                    ? a + b
                    : op === 11
                      ? a - b
                      : op === 12
                        ? a / b
                        : op === 15
                          ? Number(a === b)
                          : a * b,
            );
          } else fontError(`Type 2 escaped operator ${op} is unknown`, 'unsupported');
        } else {
          const v = [...stack],
            n = v.length;
          stack.length = 0;
          const valid = (ok: boolean) => {
            if (!ok) fontError(`Type 2 operator ${b} has the wrong operand count`);
          };
          if (!open) fontError('a Type 2 path does not begin with a moveto');
          if (b === 5) {
            valid(n >= 2 && n % 2 === 0);
            for (let i = 0; i < n; i += 2) line(v[i], v[i + 1]);
          } else if (b === 6 || b === 7) {
            valid(n >= 1);
            for (let i = 0; i < n; i++) line((i % 2 === 0) === (b === 6) ? v[i] : 0, (i % 2 === 0) === (b === 7) ? v[i] : 0);
          } else if (b === 8) {
            valid(n >= 6 && n % 6 === 0);
            for (let i = 0; i < n; i += 6) curve(...(v.slice(i, i + 6) as Six));
          } else if (b === 24) {
            valid(n >= 8 && (n - 2) % 6 === 0);
            for (let i = 0; i < n - 2; i += 6) curve(...(v.slice(i, i + 6) as Six));
            line(v[n - 2], v[n - 1]);
          } else if (b === 25) {
            valid(n >= 8 && (n - 6) % 2 === 0);
            for (let i = 0; i < n - 6; i += 2) line(v[i], v[i + 1]);
            curve(...(v.slice(n - 6) as Six));
          } else if (b === 26 || b === 27) {
            valid(n >= 4 && (n % 4 === 0 || n % 4 === 1));
            let i = n % 4,
              extra = i ? v[0] : 0;
            for (; i < n; i += 4) {
              if (b === 27) curve(v[i], extra, v[i + 1], v[i + 2], v[i + 3], 0);
              else curve(extra, v[i], v[i + 1], v[i + 2], 0, v[i + 3]);
              extra = 0;
            }
          } else if (b === 30 || b === 31) {
            valid(n >= 4 && (n % 4 === 0 || n % 4 === 1));
            let horizontal = b === 31,
              i = 0;
            while (i < n) {
              const last = n - i === 5,
                extra = last ? v[i + 4] : 0;
              if (horizontal) curve(v[i], 0, v[i + 1], v[i + 2], extra, v[i + 3]);
              else curve(0, v[i], v[i + 1], v[i + 2], v[i + 3], extra);
              i += last ? 5 : 4;
              horizontal = !horizontal;
            }
          } else fontError(`Type 2 operator ${b} is unknown`, 'unsupported');
        }
        if (stack.length > (cff2 ? 513 : 48) || stack.some((v) => !Number.isFinite(v)) || !Number.isFinite(x) || !Number.isFinite(y))
          fontError(`a Type 2 operand is not finite, or the stack exceeds ${cff2 ? 513 : 48}`);
      }
      if (cff2) {
        if (!depth) {
          if (stack.length) fontError('a CFF2 charstring ends with operands and no operator');
          close();
          ended = true;
        }
      } else if (!ended) fontError(depth ? 'a Type 2 subroutine has no return' : 'a Type 2 charstring has no endchar');
    };
    execute(charString, 0);
    return out;
  }
}
