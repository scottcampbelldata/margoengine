// Client identity and the report rule, against one person trying to be many.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addressKey, clientAddress, identityOfAddress, identityOfRequest, loadSalt } from '../server/identity.mjs';
import { ReportBook, REPORT_INTERVAL, REPORT_WINDOW, ROLLBACK_COOLDOWN } from '../server/reports.mjs';

const request = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('behind the proxy only its header counts, and only from this machine', () => {
  const proxied = { proxied: true };
  assert.equal(clientAddress(request('127.0.0.1', { 'x-real-ip': '198.51.100.7' }), proxied), '198.51.100.7');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', { 'x-real-ip': '198.51.100.7' }), proxied), '198.51.100.7');
  // Another machine that reached the port somehow cannot name anyone.
  assert.equal(clientAddress(request('203.0.113.9', { 'x-real-ip': '198.51.100.7' }), proxied), undefined);
  // Headers a client could add are never read.
  for (const name of ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'])
    assert.equal(clientAddress(request('127.0.0.1', { [name]: '198.51.100.7' }), proxied), undefined, name);
  // A repeated or padded header is not one address.
  for (const value of ['198.51.100.7, 198.51.100.8', 'somebody', '', ['198.51.100.7']])
    assert.equal(clientAddress(request('127.0.0.1', { 'x-real-ip': value }), proxied), undefined);
});

test('without the proxy every header is ignored', () => {
  assert.equal(
    clientAddress(request('203.0.113.9', { 'x-real-ip': '198.51.100.7' }), { proxied: false }),
    '203.0.113.9',
  );
});

test('one IPv6 line is one person, in any spelling; IPv4 is the same mapped or not', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), addressKey('2001:db8:1:2::1'));
  assert.equal(addressKey('2001:0DB8:0001:0002::1'), addressKey('2001:db8:1:2::1'));
  assert.notEqual(addressKey('2001:db8:1:3::1'), addressKey('2001:db8:1:2::1'));
  assert.equal(addressKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(addressKey('::ffff:c633:6407'), '198.51.100.7');
  for (const bad of ['', 'somebody', undefined, 'fe80::1%eth0']) assert.equal(addressKey(bad), undefined);
});

test('an identity is a salted hash: it does not show the address and differs per salt', () => {
  const a = identityOfAddress('198.51.100.7', 'salt-a');
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(a, identityOfAddress('::ffff:198.51.100.7', 'salt-a'));
  assert.notEqual(a, identityOfAddress('198.51.100.7', 'salt-b'));
  assert.notEqual(a, identityOfAddress('198.51.100.8', 'salt-a'));
  assert.equal(identityOfRequest(request('127.0.0.1'), { proxied: true, salt: 'salt-a' }), undefined);
});

test('the salt is made once and kept', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'plaza-salt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const salt = loadSalt(dir);
  assert.match(salt, /^[0-9a-f]{64}$/);
  assert.equal(loadSalt(dir), salt);
});

test('one identity sending reports for an hour never reaches the threshold', () => {
  const book = new ReportBook();
  for (let minute = 0; minute < 60; minute++) {
    const now = minute * REPORT_INTERVAL + 1;
    assert.ok(book.take('one', now));
    assert.equal(book.take('one', now + 1), false, 'the second in a minute is refused');
    assert.equal(book.add('w', 'one', 5, 5, now).status, 'counted');
  }
});

test('three identities within 10 minutes roll back, reaching back to the first report; a fourth waits', () => {
  const book = new ReportBook();
  assert.equal(book.add('w', 'a', 40, 40, 1000).status, 'counted');
  assert.equal(book.add('w', 'b', 41, 41, 2000).status, 'counted');
  assert.deepEqual(book.add('w', 'c', 63, 32, 3000), { status: 'rollback', cx: 1, cz: 1, first: 1000 });
  assert.equal(book.add('w', 'd', 40, 40, 4000).status, 'cooldown');
  // The neighbours were rolled back too, so they wait as well.
  assert.equal(book.add('w', 'd', 70, 40, 4000).status, 'cooldown');
  // Further out, and in another world, nothing is held.
  assert.equal(book.add('w', 'd', 40 + 64, 40, 4000).status, 'counted');
  assert.equal(book.add('other', 'd', 40, 40, 4000).status, 'counted');
});

test('reports older than 10 minutes do not count, and other areas do not add up', () => {
  const book = new ReportBook();
  assert.equal(book.add('w', 'a', 0, 0, 0).status, 'counted');
  assert.equal(book.add('w', 'b', 0, 0, REPORT_WINDOW - 1).status, 'counted');
  assert.equal(book.add('w', 'c', 0, 0, REPORT_WINDOW).status, 'counted', 'a is too old now');
  assert.equal(book.add('w', 'd', 32, 0, REPORT_WINDOW + 1).status, 'counted', 'the next area over');
});

test('reports cannot loop: after the cool down it takes three new reports', () => {
  const book = new ReportBook();
  for (const who of ['a', 'b']) book.add('w', who, 0, 0, 0);
  assert.equal(book.add('w', 'c', 0, 0, 0).status, 'rollback');
  const later = ROLLBACK_COOLDOWN;
  assert.equal(book.add('w', 'a', 0, 0, later - 1).status, 'cooldown');
  assert.equal(book.add('w', 'a', 0, 0, later).status, 'counted');
  assert.equal(book.add('w', 'b', 0, 0, later).status, 'counted');
  assert.equal(book.add('w', 'c', 0, 0, later).status, 'rollback');
});

test('the book forgets: entries do not grow without limit', () => {
  const book = new ReportBook();
  for (let i = 0; i < 1000; i++) {
    book.take(`who-${i}`, 1000);
    book.add('w', `who-${i}`, i * 64, 0, 1000);
  }
  assert.ok(book.size >= 1000);
  book.take('late', 1000 + REPORT_WINDOW + ROLLBACK_COOLDOWN);
  assert.equal(book.size, 1);
});
