// Caption files: SubRip (.srt) and WebVTT (.vtt) readers and writers (GAP-FILM-SRT). Plain TypeScript with no DOM, so it
// runs in Node, a worker or a page.
//
// WebVTT follows W3C, "WebVTT: The Web Video Text Tracks Format", Candidate Recommendation, 4 April 2019
// (https://www.w3.org/TR/webvtt1/): the file signature and header (4.1), cue blocks with an optional identifier, a timing
// line and payload lines up to a blank line (4.1, 6.1 the parser), NOTE comment blocks (4.1), STYLE and REGION blocks
// before the first cue (4.1, 6.1), timestamps `[hours:]minutes:seconds.milliseconds` with at least two digits of
// hours, two of minutes and seconds and three of milliseconds (4.5 and 6.1 "collect a WebVTT timestamp"), cue
// settings after the end time (4.4), and cue text escapes `&amp;`, `&lt;`, `&gt;`, `&lrm;`, `&rlm;`, `&nbsp;` and
// character references (4.2.2, 6.4 the cue text parser).
//
// SubRip has no formal standard; this reads it as commonly documented (the SubRip program's output and the Library of
// Congress format description "SubRip Subtitle (SRT)", https://www.loc.gov/preservation/digital/formats/fdd/fdd000569.shtml):
// numbered blocks of a counter line, `hours:minutes:seconds,milliseconds --> ...` and text lines, separated by a blank
// line. A `.` before the milliseconds and trailing `X1:... Y2:...` position data, both seen in files in the wild, are read.
//
// Both readers report malformed blocks in `problems` instead of throwing, keep going, and handle a byte order mark and
// CRLF, CR or LF line ends. The writers throw on a cue they cannot write faithfully.

import { rangeError, typeError } from '../../shared/errors.js';

/** One caption cue. Times in seconds. */
export interface Cue {
  /** 1-based position of the cue in the file (or in the list written). */
  index: number;
  /** The cue's identifier: an SRT counter as written, a WebVTT cue identifier, or '' when the file gives none. */
  id: string;
  start: number;
  end: number;
  /**
   * The text lines, as written: WebVTT and many SRT files carry markup such as `<i>` and escapes such as `&amp;`;
   * {@link cueText} gives plain text.
   */
  lines: string[];
  /** WebVTT cue settings as written after the end time (`align:start line:0`), '' when none. SRT has none. */
  settings: string;
}

/** A block the reader skipped, with its 1-based line number in the file. */
export interface CaptionProblem {
  line: number;
  message: string;
}

/** What {@link parseSrt} and {@link parseVtt} return. */
export interface CaptionFile {
  cues: Cue[];
  problems: CaptionProblem[];
  /** WebVTT only: the text after `WEBVTT` on the signature line and the header lines under it, '' when none. */
  header: string;
  /** WebVTT only: each STYLE block's CSS, as written. */
  styles: string[];
  /** WebVTT only: each REGION block's settings lines, as written. */
  regions: string[];
}

/** A cue to write: `index`, `id` and `settings` are optional. */
export type CueInput = Pick<Cue, 'start' | 'end' | 'lines'> & Partial<Pick<Cue, 'id' | 'settings'>>;

/** Lines of `text` with their 1-based numbers, a leading byte order mark dropped and CRLF, CR and LF all line ends. */
function rows(text: string): string[] {
  if (typeof text !== 'string') throw typeError('Pass the caption file as a string', 'captions');
  return text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
}

/** Blocks of consecutive non-blank lines, each with the line number of its first line. */
function blocks(lines: string[], from: number): { at: number; lines: string[] }[] {
  const out: { at: number; lines: string[] }[] = [];
  let block: { at: number; lines: string[] } | undefined;
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() === '') block = undefined;
    else if (block) block.lines.push(lines[i]);
    else out.push((block = { at: i + 1, lines: [lines[i]] }));
  }
  return out;
}

const SRT_TIME = /^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})(?:\s.*)?$/;
const ms = (digits: string) => Number(digits.padEnd(3, '0')) / 1000;

/**
 * Reads a SubRip (.srt) file. Blocks that are not a counter, a timing line and text are listed in `problems` and
 * skipped; a block whose end is not after its start is kept and reported.
 *
 * @example
 * import {parseSrt} from 'margoengine/text/captions';
 * const {cues, problems} = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello there\n');
 * console.log(cues[0].start, cues[0].end, cues[0].lines, problems.length); // 1 2.5 ['Hello there'] 0
 */
export function parseSrt(text: string): CaptionFile {
  const cues: Cue[] = [],
    problems: CaptionProblem[] = [];
  for (const block of blocks(rows(text), 0)) {
    // The counter is optional in practice: some tools write the timing line first.
    const counter = /^\s*\d+\s*$/.test(block.lines[0]),
      timing = SRT_TIME.exec(block.lines[counter ? 1 : 0] ?? '');
    if (!timing) {
      problems.push({
        line: block.at,
        message: `not a SubRip cue: expected a counter and "00:00:01,000 --> 00:00:02,000", found ${JSON.stringify(block.lines[counter ? 1 : 0] ?? block.lines[0])}`,
      });
      continue;
    }
    const t = timing.slice(1).map(Number),
      start = t[0] * 3600 + t[1] * 60 + t[2] + ms(timing[4]),
      end = t[4] * 3600 + t[5] * 60 + t[6] + ms(timing[8]);
    if (t[1] > 59 || t[2] > 59 || t[5] > 59 || t[6] > 59)
      problems.push({ line: block.at, message: 'minutes and seconds above 59 in a SubRip timing line' });
    if (!(end > start))
      problems.push({ line: block.at, message: `cue ends at ${end} s, not after it starts at ${start} s` });
    cues.push({
      index: cues.length + 1,
      id: counter ? block.lines[0].trim() : '',
      start,
      end,
      lines: block.lines.slice(counter ? 2 : 1),
      settings: '',
    });
  }
  return { cues, problems, header: '', styles: [], regions: [] };
}

/** A WebVTT timestamp (4.5) at the start of `text`, with the rest; undefined when there is none. */
function vttTime(text: string): { seconds: number; rest: string } | undefined {
  const m = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/.exec(text);
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) return undefined;
  return {
    seconds: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
    rest: text.slice(m[0].length),
  };
}

/** A WebVTT timing line: start, end and settings; undefined when it is not one. */
function vttTiming(line: string): { start: number; end: number; settings: string } | undefined {
  const start = vttTime(line.replace(/^[ \t]+/, ''));
  if (!start) return undefined;
  const arrow = /^[ \t]+-->[ \t]+/.exec(start.rest);
  if (!arrow) return undefined;
  const end = vttTime(start.rest.slice(arrow[0].length));
  if (!end || (end.rest !== '' && !/^[ \t]/.test(end.rest))) return undefined;
  return { start: start.seconds, end: end.seconds, settings: end.rest.trim() };
}

/**
 * Reads a WebVTT (.vtt) file. A file without the `WEBVTT` signature gives no cues and one problem; NOTE blocks are
 * comments, STYLE and REGION blocks before the first cue are returned in `styles` and `regions`, and any other block
 * that is not a cue is listed in `problems`.
 *
 * @example
 * import {parseVtt} from 'margoengine/text/captions';
 * const {cues} = parseVtt('WEBVTT\n\nintro\n00:01.000 --> 00:02.500 align:start\nHello &amp; welcome\n');
 * console.log(cues[0].id, cues[0].start, cues[0].settings, cues[0].lines); // intro 1 'align:start' ['Hello &amp; welcome']
 */
export function parseVtt(text: string): CaptionFile {
  const lines = rows(text),
    file: CaptionFile = { cues: [], problems: [], header: '', styles: [], regions: [] };
  const signature = /^WEBVTT(?:[ \t](.*))?$/.exec(lines[0]);
  if (!signature) {
    file.problems.push({ line: 1, message: 'not a WebVTT file: the first line must be WEBVTT' });
    return file;
  }
  // The header runs from the signature to the first blank line (6.1).
  let i = 1;
  const header = signature[1] ? [signature[1]] : [];
  for (; i < lines.length && lines[i].trim() !== ''; i++) header.push(lines[i]);
  file.header = header.join('\n');
  for (const block of blocks(lines, i)) {
    const first = block.lines[0],
      cue = first.includes('-->') || !!block.lines[1]?.includes('-->');
    // The parser (6.1) reads a block with a timing line in its first two lines as a cue, whatever its id says.
    if (!cue && /^NOTE(?:[ \t]|$)/.test(first)) continue;
    if (!cue && /^(STYLE|REGION)[ \t]*$/.test(first)) {
      if (file.cues.length)
        file.problems.push({
          line: block.at,
          message: `${first.trim()} block after the first cue, ignored (WebVTT 4.1)`,
        });
      else (first.startsWith('STYLE') ? file.styles : file.regions).push(block.lines.slice(1).join('\n'));
      continue;
    }
    const hasId = !first.includes('-->'),
      timingLine = block.lines[hasId ? 1 : 0],
      timing = timingLine === undefined ? undefined : vttTiming(timingLine);
    if (!timing) {
      file.problems.push({
        line: block.at + (hasId ? 1 : 0),
        message: `not a WebVTT cue: expected "00:01.000 --> 00:02.000", found ${JSON.stringify(timingLine ?? first)}`,
      });
      continue;
    }
    if (!(timing.end > timing.start))
      file.problems.push({
        line: block.at,
        message: `cue ends at ${timing.end} s, not after it starts at ${timing.start} s`,
      });
    // A payload line holding "-->" ends the cue in the parser (6.1); what follows is not this cue's text.
    const payload = block.lines.slice(hasId ? 2 : 1),
      cut = payload.findIndex((line) => line.includes('-->'));
    if (cut >= 0)
      file.problems.push({
        line: block.at + (hasId ? 2 : 1) + cut,
        message: 'a cue line holds "-->"; a blank line must separate cues',
      });
    file.cues.push({
      index: file.cues.length + 1,
      id: hasId ? first : '',
      start: timing.start,
      end: timing.end,
      lines: cut >= 0 ? payload.slice(0, cut) : payload,
      settings: timing.settings,
    });
  }
  return file;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  lrm: '\u200E',
  rlm: '\u200F',
  nbsp: '\u00A0',
  quot: '"',
  apos: "'",
};

/**
 * A cue line as plain text: markup tags (`<i>`, `<c.loud>`, `<v Roger>`, `<00:01.500>`) removed and the WebVTT escapes
 * and character references decoded. Use it on lines from either reader.
 *
 * @example
 * import {cueText} from 'margoengine/text/captions';
 * console.log(cueText('<v Ann><i>Fish &amp; chips</i>')); // Fish & chips
 */
export function cueText(line: string): string {
  if (typeof line !== 'string') throw typeError('Pass a cue line string', 'captions');
  return line.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Whole milliseconds of a cue time, checked. */
function millis(seconds: number, at: number, what: string): number {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw rangeError(`Invalid cue ${at} ${what}; pass a finite time in seconds of 0 or more`, 'captions');
  return Math.round(seconds * 1000);
}

/** `hh:mm:ss<sep>mmm`. */
function stamp(total: number, separator: string): string {
  const h = Math.floor(total / 3_600_000),
    m = Math.floor(total / 60_000) % 60,
    s = Math.floor(total / 1000) % 60,
    pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(total % 1000, 3)}`;
}

/** Checked cue fields shared by the writers. */
function checked(cue: CueInput, at: number): { start: number; end: number; lines: string[] } {
  if (!cue || !Array.isArray(cue.lines) || !cue.lines.every((l) => typeof l === 'string'))
    throw typeError(`Invalid cue ${at}; pass {start, end, lines: string[]}`, 'captions');
  const start = millis(cue.start, at, 'start'),
    end = millis(cue.end, at, 'end');
  if (!(end > start)) throw rangeError(`Invalid cue ${at}; end must be after start, to the millisecond`, 'captions');
  if (!cue.lines.length) throw rangeError(`Invalid cue ${at}; give it at least one line`, 'captions');
  const lines = cue.lines.flatMap((l) => l.split(/\r\n|\r|\n/));
  // A blank line ends a cue and "-->" starts a timing line: either would split the cue when read back.
  if (lines.some((l) => l.trim() === '' || l.includes('-->')))
    throw rangeError(`Invalid cue ${at}; a line is blank or holds "-->", which would end the cue`, 'captions');
  return { start, end, lines };
}

/**
 * Writes cues as a SubRip file: counters from 1, `00:00:01,000 --> 00:00:02,500`, the lines, a blank line, with LF line
 * ends. Times round to the millisecond.
 *
 * @example
 * import {toSrt} from 'margoengine/text/captions';
 * console.log(toSrt([{start: 1, end: 2.5, lines: ['Hello there']}])); // 1, 00:00:01,000 --> 00:00:02,500, Hello there
 * @throws RangeError for a negative or non-finite time, an end not after its start, no lines, or a blank or "-->" line.
 */
export function toSrt(cues: readonly CueInput[]): string {
  if (!Array.isArray(cues)) throw typeError('Pass an array of cues', 'captions');
  return cues
    .map((cue, i) => {
      const { start, end, lines } = checked(cue, i + 1);
      return `${i + 1}\n${stamp(start, ',')} --> ${stamp(end, ',')}\n${lines.join('\n')}\n`;
    })
    .join('\n');
}

/** Options of {@link toVtt}. */
export interface VttWriteOptions {
  /** Text after `WEBVTT` and header lines, as {@link parseVtt} returns it. Default ''. */
  header?: string;
  /** STYLE blocks' CSS. Default none. */
  styles?: readonly string[];
  /** REGION blocks' settings lines. Default none. */
  regions?: readonly string[];
}

/**
 * Writes cues as a WebVTT file: the signature, any header, STYLE and REGION blocks, then each cue with its `id` and
 * `settings` when set. Lines are written as given, so markup stays; escape a literal `&` or `<` as `&amp;` or `&lt;`.
 *
 * @example
 * import {parseSrt, toVtt} from 'margoengine/text/captions';
 * console.log(toVtt(parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello there\n').cues)); // WEBVTT, 1, 00:00:01.000 --> ...
 * @throws RangeError as {@link toSrt}, and for an id holding "-->" or a line break.
 */
export function toVtt(
  cues: readonly CueInput[],
  { header = '', styles = [], regions = [] }: VttWriteOptions = {},
): string {
  if (!Array.isArray(cues)) throw typeError('Pass an array of cues', 'captions');
  const head = header.split(/\r\n|\r|\n/);
  if (head.some((l, i) => (i > 0 && l.trim() === '') || l.includes('-->')))
    throw rangeError('Invalid WebVTT header; no blank lines or "-->" in it', 'captions');
  const out = [`WEBVTT${head[0] ? ' ' + head[0] : ''}${head.length > 1 ? '\n' + head.slice(1).join('\n') : ''}\n`];
  for (const [name, list] of [
    ['REGION', regions],
    ['STYLE', styles],
  ] as const)
    for (const body of list) {
      if (body.split(/\r\n|\r|\n/).some((l) => l.trim() === '' || l.includes('-->')))
        throw rangeError(`Invalid WebVTT ${name} block; no blank lines or "-->" in it`, 'captions');
      out.push(`${name}\n${body}\n`);
    }
  cues.forEach((cue, i) => {
    const { start, end, lines } = checked(cue, i + 1),
      id = cue.id ?? '',
      settings = cue.settings ?? '';
    if (/-->|[\r\n]/.test(id) || /-->|[\r\n]/.test(settings))
      throw rangeError(`Invalid cue ${i + 1}; its id and settings hold no "-->" or line break`, 'captions');
    out.push(
      `${id ? id + '\n' : ''}${stamp(start, '.')} --> ${stamp(end, '.')}${settings ? ' ' + settings : ''}\n${lines.join('\n')}\n`,
    );
  });
  return out.join('\n');
}
