// GAP-FILM-SRT: SubRip and WebVTT readers and writers, so an app reads and writes caption files with the engine
// instead of its own parser. Cases follow the W3C WebVTT spec's examples and the SubRip layout as commonly written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cueText, parseSrt, parseVtt, toSrt, toVtt } from '../dist/captions.js';

test('parseSrt reads cues with CRLF, a byte order mark, multi-line text and a dot before the milliseconds', () => {
  const file =
    '\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there\r\n\r\n2\r\n00:00:03.250 --> 00:01:04,005 X1:10 X2:90 Y1:5 Y2:20\r\n<i>Two</i>\r\nlines\r\n';
  const { cues, problems } = parseSrt(file);
  assert.deepEqual(problems, []);
  assert.deepEqual(cues, [
    { index: 1, id: '1', start: 1, end: 2.5, lines: ['Hello there'], settings: '' },
    { index: 2, id: '2', start: 3.25, end: 64.005, lines: ['<i>Two</i>', 'lines'], settings: '' },
  ]);
  // Hours past 99 and a lone CR line end.
  assert.equal(parseSrt('7\r100:00:00,000 --> 100:00:01,000\rLate\r').cues[0].start, 360000);
});

test('parseSrt reports malformed blocks with their line and keeps going', () => {
  const { cues, problems } = parseSrt(
    '1\n00:00:01,000 -> 00:00:02,000\nbad arrow\n\n2\n00:00:05,000 --> 00:00:04,000\nbackwards\n\n3\n00:00:06,000 --> 00:00:07,000\nfine\n',
  );
  assert.deepEqual(
    cues.map((c) => c.id),
    ['2', '3'],
  );
  assert.equal(problems.length, 2);
  assert.equal(problems[0].line, 1);
  assert.match(problems[0].message, /not a SubRip cue/);
  assert.equal(problems[1].line, 5);
  assert.match(problems[1].message, /not after it starts/);
  assert.deepEqual(parseSrt(''), { cues: [], problems: [], header: '', styles: [], regions: [] });
});

test('parseVtt reads the header, ids, settings, NOTE, STYLE and REGION blocks and both timestamp forms', () => {
  const file = [
    'WEBVTT - Film captions',
    'Kind: captions',
    '',
    'REGION',
    'id:fred',
    'width:40%',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'NOTE This is a comment',
    'over two lines',
    '',
    'intro',
    '00:01.000 --> 00:04.000 align:start line:0',
    'Never drink liquid nitrogen.',
    '',
    '01:00:05.250 --> 01:00:06.000',
    '<v Roger Bingham>&amp; then',
    '',
  ].join('\r\n');
  const { cues, problems, header, styles, regions } = parseVtt(file);
  assert.deepEqual(problems, []);
  assert.equal(header, '- Film captions\nKind: captions');
  assert.deepEqual(styles, ['::cue { color: yellow }']);
  assert.deepEqual(regions, ['id:fred\nwidth:40%']);
  assert.deepEqual(cues, [
    {
      index: 1,
      id: 'intro',
      start: 1,
      end: 4,
      lines: ['Never drink liquid nitrogen.'],
      settings: 'align:start line:0',
    },
    { index: 2, id: '', start: 3605.25, end: 3606, lines: ['<v Roger Bingham>&amp; then'], settings: '' },
  ]);
});

test('parseVtt follows the spec on bad input: no signature, malformed timestamps, a cue line holding the arrow', () => {
  assert.equal(parseVtt('WEBVTTX\n\n00:01.000 --> 00:02.000\nx\n').cues.length, 0);
  assert.match(parseVtt('1\n00:00:01,000 --> 00:00:02,000\nsrt\n').problems[0].message, /first line must be WEBVTT/);
  // One-digit minutes, a comma and minutes past 59 are not WebVTT timestamps (W3C WebVTT 4.5).
  const { cues, problems } = parseVtt(
    'WEBVTT\n\n0:01.000 --> 0:02.000\na\n\n00:01,000 --> 00:02,000\nb\n\n00:61.000 --> 00:62.000\nc\n\n00:03.000 --> 00:04.000\nd\nstill d\n00:05.000 --> 00:06.000\ne\n',
  );
  assert.equal(problems.length, 4);
  assert.deepEqual(
    cues.map((c) => c.lines),
    [['d', 'still d']],
  );
  assert.match(problems[3].message, /holds "-->"/);
  // A STYLE block after a cue is ignored and reported.
  assert.match(
    parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nx\n\nSTYLE\n::cue {}\n').problems[0].message,
    /after the first cue/,
  );
});

test('cueText strips markup and decodes the WebVTT escapes and character references', () => {
  assert.equal(
    cueText('<v Ann><i>Fish &amp; chips</i> &lt;3&gt; &#169;&#x263A;&nbsp;</v>'),
    'Fish & chips <3> ©☺\u00A0',
  );
  assert.equal(cueText('<00:00:01.500>timed <c.loud>word</c>'), 'timed word');
  assert.equal(cueText('&unknown; stays'), '&unknown; stays');
});

test('toSrt and toVtt write what the readers read back, to the millisecond', () => {
  const cues = [
    { start: 0, end: 1.2344, lines: ['First'] },
    { start: 61.5, end: 3725.0006, lines: ['Second', 'line'], id: 'two', settings: 'align:end' },
  ];
  const srt = toSrt(cues);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,234\nFirst\n\n2\n00:01:01,500 --> 01:02:05,001\nSecond\nline\n');
  assert.deepEqual(
    parseSrt(srt).cues.map((c) => [c.start, c.end, c.lines]),
    [
      [0, 1.234, ['First']],
      [61.5, 3725.001, ['Second', 'line']],
    ],
  );
  const vtt = toVtt(cues, { header: 'Captions', styles: ['::cue { color: white }'] });
  assert.equal(
    vtt,
    'WEBVTT Captions\n\nSTYLE\n::cue { color: white }\n\n00:00:00.000 --> 00:00:01.234\nFirst\n\ntwo\n00:01:01.500 --> 01:02:05.001 align:end\nSecond\nline\n',
  );
  const back = parseVtt(vtt);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.styles, ['::cue { color: white }']);
  assert.deepEqual(
    back.cues.map((c) => [c.id, c.start, c.end, c.settings, c.lines]),
    [
      ['', 0, 1.234, '', ['First']],
      ['two', 61.5, 3725.001, 'align:end', ['Second', 'line']],
    ],
  );
  // SubRip to WebVTT keeps every cue.
  assert.equal(parseVtt(toVtt(parseSrt(srt).cues)).cues.length, 2);
});

test('the writers refuse cues they cannot write faithfully, with a help link', () => {
  for (const cue of [
    { start: -1, end: 1, lines: ['a'] },
    { start: 1, end: 1, lines: ['a'] },
    { start: 1, end: 1.0004, lines: ['a'] },
    { start: 0, end: Number.NaN, lines: ['a'] },
    { start: 0, end: 1, lines: [] },
    { start: 0, end: 1, lines: ['a', ''] },
    { start: 0, end: 1, lines: ['a\n\nb'] },
    { start: 0, end: 1, lines: ['a --> b'] },
  ]) {
    assert.throws(() => toSrt([cue]), /Invalid cue 1.*errors#captions/);
    assert.throws(() => toVtt([cue]), /Invalid cue 1.*errors#captions/);
  }
  assert.throws(() => toVtt([{ start: 0, end: 1, lines: ['a'], id: 'x --> y' }]), RangeError);
  assert.throws(() => toVtt([], { header: 'a\n\nb' }), RangeError);
  assert.throws(() => toSrt('cues'), TypeError);
  assert.throws(() => parseSrt(42), TypeError);
});

test('parseVtt reads a block with a timing line as a cue even when its id starts with NOTE, as the spec parser does', () => {
  const { cues, problems } = parseVtt(
    'WEBVTT\n\nNOTE a comment\nover two lines\n\nNOTE 1\n00:01.000 --> 00:02.000\nSpoken\n',
  );
  assert.deepEqual(problems, []);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].id, 'NOTE 1');
  assert.deepEqual(parseVtt(toVtt(cues)).cues, cues, 'the writer and reader agree on such an id');
});
