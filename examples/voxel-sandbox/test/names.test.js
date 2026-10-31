import assert from 'node:assert/strict';
import test from 'node:test';
import { FIRST_WORDS, isPlazaName, randomName, SECOND_WORDS } from '../src/names.ts';

// Base64 so this test file does not print them; decoded only to scan the pairings.
const RUDE = Buffer.from(
  'YXJzZSxhbmFsLGFudXMsYml0Y2gsYmFzdGFyZCxib29iLGJ1dHQsY2hpbmssY2xpdCxjb2NrLGNvb24sY3JhcCxjdW0sY3VudCxkYW1uLGRhZ28sZGljayxkaWxkbyxkeWtlLGZhZyxmdWNrLGdvb2ssaG9tbyxqYXAsamV3LGtpa2Usa2lsbCxuYXppLG5lZ3JvLG5pZyxwYWtpLHBlbmlzLHBpc3MscG9vLHBvcm4scHJpY2sscHViZSxwdXNzeSxxdWVlcixyYXBlLHJldGFyZCxzZXgsc2hpdCxzbGFnLHNsdXQsc3BpYyx0aXQsdGFyZCx0d2F0LHdhbmssd2hvcmUsd29wLHRyYW5ueSxoYXRlLHR1cmQsbm9iLGtub2IsaHVtcCxidW0sZ2F5LGxlc2JvLHBlZG8sdmFnLHNwZXJtLHNlbWVuLGFzcyxob2U=',
  'base64',
)
  .toString()
  .split(',');

test('two lists of 64 distinct plain words', () => {
  for (const words of [FIRST_WORDS, SECOND_WORDS]) {
    assert.equal(words.length, 64);
    assert.equal(new Set(words).size, 64);
    for (const word of words) assert.match(word, /^[A-Z][a-z]+$/);
  }
  assert.equal(new Set([...FIRST_WORDS, ...SECOND_WORDS]).size, 128, 'no word on both lists');
});

test('no pairing holds a rude word, spaced or joined', () => {
  for (const first of FIRST_WORDS)
    for (const second of SECOND_WORDS) {
      const joined = (first + second).toLowerCase();
      for (const word of RUDE) assert.ok(!joined.includes(word), `${first} ${second}`);
    }
});

test('every pairing fits the 32 byte name limit on the wire', () => {
  const longest = (words) => Math.max(...words.map((word) => word.length));
  assert.ok(longest(FIRST_WORDS) + 1 + longest(SECOND_WORDS) <= 32);
});

test('randomName picks from the lists and uses the given random source', () => {
  assert.equal(
    randomName(() => 0),
    `${FIRST_WORDS[0]} ${SECOND_WORDS[0]}`,
  );
  assert.equal(
    randomName(() => 0.999999),
    `${FIRST_WORDS[63]} ${SECOND_WORDS[63]}`,
  );
  // A source that breaks its range still gives a listed name.
  assert.ok(isPlazaName(randomName(() => 1)));
  assert.ok(isPlazaName(randomName(() => -1)));
  for (let i = 0; i < 100; i++) assert.ok(isPlazaName(randomName()));
});

test('isPlazaName takes only an exact pairing', () => {
  assert.ok(isPlazaName(`${FIRST_WORDS[3]} ${SECOND_WORDS[5]}`));
  for (const name of [
    '',
    FIRST_WORDS[0],
    `${SECOND_WORDS[0]} ${FIRST_WORDS[0]}`,
    `${FIRST_WORDS[0]}  ${SECOND_WORDS[0]}`,
    ` ${FIRST_WORDS[0]} ${SECOND_WORDS[0]}`,
    `${FIRST_WORDS[0]} ${SECOND_WORDS[0]} ${SECOND_WORDS[1]}`,
    `${FIRST_WORDS[0].toLowerCase()} ${SECOND_WORDS[0]}`,
    'constructor toString',
    'sandbox',
  ])
    assert.equal(isPlazaName(name), false, name);
  assert.equal(isPlazaName(undefined), false);
});
