// The text a PDF shows, for checks that read the site's PDFs (scripts/check-banned-terms.mjs). Covers what headless
// Chromium (Skia) writes for site/whitepaper/engine.pdf: Flate streams, fonts with a ToUnicode map, and the Tj, TJ, '
// and " operators with hex or literal strings. Not a general PDF reader.
import { constants, inflateSync } from 'node:zlib';

/**
 * The text of every page of a PDF, one line per text line, decoded through each font's ToUnicode map.
 * @param {Buffer} buffer the PDF file
 * @returns {string | null} the text, or null when the file shows no readable text (callers treat that as a failure)
 */
export function pdfText(buffer) {
  const s = buffer.toString('latin1');
  const objects = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\b([\s\S]*?)endobj/g)) {
    const body = m[2],
      at = body.search(/\bstream\r?\n/);
    if (at < 0) {
      objects.set(m[1], { dict: body });
      continue;
    }
    const dict = body.slice(0, at),
      start = at + body.slice(at).indexOf('\n') + 1;
    const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let raw = Buffer.from(body.slice(start, body.lastIndexOf('endstream')), 'latin1');
    raw = raw.subarray(0, length ? Number(length[1]) : trimmedLength(raw));
    if (/\/FlateDecode/.test(dict)) raw = inflateSync(raw, { finishFlush: constants.Z_SYNC_FLUSH });
    objects.set(m[1], { dict, data: raw.toString('latin1') });
  }
  const ref = (text, key) => new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(text)?.[1];
  const maps = new Map();
  const cmapOf = (fontNumber) => {
    if (!maps.has(fontNumber)) {
      const font = objects.get(fontNumber),
        to = font && ref(font.dict, 'ToUnicode'),
        data = to && objects.get(to)?.data;
      maps.set(fontNumber, data ? parseCMap(data) : null);
    }
    return maps.get(fontNumber);
  };
  const lines = [];
  for (const obj of objects.values()) {
    if (!/\/Type\s*\/Page\b/.test(obj.dict)) continue;
    const fonts = new Map();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict)?.[1] ?? '';
    for (const f of fontDict.matchAll(/\/([^\s/<>]+)\s+(\d+) 0 R/g)) fonts.set(f[1], f[2]);
    const list = /\/Contents\s*\[([^\]]*)\]/.exec(obj.dict)?.[1];
    const contents = list ? [...list.matchAll(/(\d+) 0 R/g)].map((c) => c[1]) : [ref(obj.dict, 'Contents')];
    for (const number of contents) {
      const data = number && objects.get(number)?.data;
      if (data) lines.push(...showText(data, (name) => cmapOf(fonts.get(name))));
    }
  }
  const text = lines.join('\n');
  return text.trim() ? text : null;
}

/** Length without the end-of-line bytes before `endstream`. */
function trimmedLength(raw) {
  let n = raw.length;
  while (n && (raw[n - 1] === 0x0a || raw[n - 1] === 0x0d)) n--;
  return n;
}

/** A ToUnicode CMap: code width in bytes and code to text. */
function parseCMap(text) {
  const map = new Map();
  const range = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  const width = range ? range[1].length / 2 : 2;
  const unicode = (hex) => Buffer.from(hex, 'hex').swap16().toString('utf16le');
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g))
      map.set(Number.parseInt(m[1], 16), unicode(m[2]));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const low = Number.parseInt(m[1], 16),
        high = Number.parseInt(m[2], 16);
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)];
        for (let c = low; c <= high; c++) if (items[c - low]) map.set(c, unicode(items[c - low][1]));
      } else {
        const base = unicode(m[3].slice(1, -1));
        for (let c = low; c <= high; c++)
          map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + c - low));
      }
    }
  return { map, width };
}

function decode(bytes, cmap) {
  if (!cmap) return bytes.toString('latin1');
  let out = '';
  for (let i = 0; i + cmap.width <= bytes.length; i += cmap.width)
    out += cmap.map.get(cmap.width === 2 ? bytes.readUInt16BE(i) : bytes[i]) ?? '';
  return out;
}

/** The bytes of a PDF literal string body (between the parentheses). */
function literal(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      bytes.push(text.charCodeAt(i) & 0xff);
      continue;
    }
    const next = text[++i];
    const escaped = { n: 10, r: 13, t: 9, b: 8, f: 12 }[next];
    if (escaped !== undefined) bytes.push(escaped);
    else if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(text.slice(i))[0];
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += octal.length - 1;
    } else if (next !== '\n' && next !== '\r' && next !== undefined) bytes.push(next.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * The text one content stream shows. Each text object (BT ... ET) gives two lines: its runs joined with spaces and
 * joined with nothing, because Chromium places letter-spaced text one glyph per run but starts a new run for each
 * wrapped line, so neither form alone keeps every word whole.
 */
function showText(data, fontMap) {
  const lines = [];
  const operands = [];
  let runs = [],
    line = '',
    cmap = null,
    array = null;
  const end = () => {
    if (line) runs.push(line);
    line = '';
  };
  const endObject = () => {
    end();
    if (runs.length) lines.push(runs.join(' '), runs.join(''));
    runs = [];
  };
  const tokens =
    /\/([^\s/<>[\]()]+)|<([0-9a-fA-F\s]*)>|(\((?:\\[\s\S]|[^\\)])*\))|(\[)|(\])|(-?\d*\.?\d+)|([A-Za-z'"*]+)/g;
  for (const [, name, hex, lit, open, close, number, op] of data.matchAll(tokens)) {
    const target = array ?? operands;
    if (open) array = [];
    else if (close) {
      operands.push(array);
      array = null;
    } else if (hex !== undefined) target.push({ bytes: Buffer.from(hex.replace(/\s/g, ''), 'hex') });
    else if (lit !== undefined) target.push({ bytes: literal(lit.slice(1, -1)) });
    else if (number !== undefined) target.push(Number(number));
    else if (name !== undefined) target.push(name);
    else if (op) {
      if (op === 'Tf') cmap = fontMap(operands.at(-2));
      else if (op === 'Tj' || op === "'" || op === '"') {
        if (op !== 'Tj') end();
        const shown = operands.at(-1);
        if (shown?.bytes) line += decode(shown.bytes, cmap);
      } else if (op === 'TJ') {
        for (const part of operands.at(-1) ?? [])
          if (part?.bytes) line += decode(part.bytes, cmap);
          else if (typeof part === 'number' && part < -200) line += ' ';
      } else if (op === 'ET') endObject();
      else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm') end();
      operands.length = 0;
    }
  }
  endObject();
  return lines;
}
