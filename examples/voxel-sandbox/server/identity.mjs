// Who a request comes from, without trusting anything the client can write. Behind nginx (`proxied`) the only source is
// the one header nginx overwrites, and only on a connection from this machine; without a proxy it is the socket's
// address and every header is ignored. An identity is a salted hash, so addresses reach neither logs nor disk.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

/** Every Plaza listener binds here and nowhere else: nginx is the only way in from outside. */
export const HOST = '127.0.0.1';

/** The one header read behind the proxy; nginx must overwrite it (`proxy_set_header X-Real-IP $remote_addr`). */
export const CLIENT_IP_HEADER = 'x-real-ip';

// The eight groups of an IPv6 address as numbers, or undefined.
function ipv6Groups(address) {
  if (isIP(address) !== 6 || address.includes('%')) return undefined;
  let text = address;
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::'),
    left = head ? head.split(':') : [],
    right = tail ? tail.split(':') : [],
    gap = text.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array(gap).fill('0'), ...right].map((group) => Number.parseInt(group, 16));
}

/**
 * The key one person is counted under, or undefined for something that is not an address. An IPv4 address stands for
 * itself, in either spelling. An IPv6 address counts by its /64: one home or phone line gets a whole /64, so counting
 * single addresses would let one person be 2^64 people.
 */
export function addressKey(address) {
  if (typeof address !== 'string') return undefined;
  if (isIP(address) === 4) return address;
  const groups = ipv6Groups(address);
  if (!groups) return undefined;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff)
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':');
}

function isLoopback(address) {
  const key = addressKey(address);
  if (key === undefined) return false;
  if (key.includes('.')) return key.startsWith('127.');
  const groups = ipv6Groups(address);
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

/**
 * The client's address from an upgrade or HTTP request, or undefined when it cannot be known (behind the proxy: another
 * machine connected directly, or the header is missing, repeated or not one address).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ proxied: boolean }} options
 */
export function clientAddress(req, { proxied }) {
  const peer = req.socket.remoteAddress;
  if (!proxied) return peer;
  if (!isLoopback(peer)) return undefined;
  const value = req.headers[CLIENT_IP_HEADER];
  return typeof value === 'string' && isIP(value) ? value : undefined;
}

/** The salted hash of `address`, or undefined for something that is not an address. */
export function identityOfAddress(address, salt) {
  const key = addressKey(address);
  return key === undefined ? undefined : createHash('sha256').update(`${salt}\0${key}`).digest('hex').slice(0, 24);
}

/** The identity of a request; see {@link clientAddress}. */
export const identityOfRequest = (req, { proxied, salt }) => identityOfAddress(clientAddress(req, { proxied }), salt);

/** The installation's salt, from `dir/identity.salt`, made on first use; readable by the service's user only. */
export function loadSalt(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'identity.salt');
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(path, 'utf8');
}
