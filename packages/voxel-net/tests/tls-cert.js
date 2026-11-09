// A self-signed certificate made in the test, for TLS tests without a key file in the repository: an ECDSA P-256 key
// from node:crypto and an X.509 v3 certificate (RFC 5280) DER-encoded by hand, valid for a day either side of now,
// for DNS localhost and IP 127.0.0.1.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]),
  tlv = (tag, ...parts) => {
    const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
    return Buffer.concat([Buffer.from([tag, ...length(body.length)]), body]);
  },
  sequence = (...parts) => tlv(0x30, ...parts),
  oid = (dotted) => {
    const [a, b, ...rest] = dotted.split('.').map(Number),
      out = [40 * a + b];
    for (let v of rest) {
      const bytes = [v & 127];
      while ((v >>= 7)) bytes.unshift((v & 127) | 128);
      out.push(...bytes);
    }
    return tlv(0x06, out);
  },
  utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`)),
  pem = (der) =>
    `-----BEGIN CERTIFICATE-----\n${der
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n')}\n-----END CERTIFICATE-----\n`;

/** A fresh key and self-signed certificate: `{ key, cert }` in PEM, the certificate also its own CA. */
export function selfSigned(commonName = 'margo test') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    ecdsaSha256 = sequence(oid('1.2.840.10045.4.3.2')),
    name = sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName))))),
    now = Date.now(),
    altNames = sequence(
      oid('2.5.29.17'),
      tlv(0x04, sequence(tlv(0x82, Buffer.from('localhost')), tlv(0x87, [127, 0, 0, 1]))),
    ),
    tbs = sequence(
      tlv(0xa0, tlv(0x02, [2])), // v3
      tlv(0x02, [1, ...randomBytes(8)]), // a positive random serial
      ecdsaSha256,
      name,
      sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
      name,
      publicKey.export({ type: 'spki', format: 'der' }),
      tlv(0xa3, sequence(altNames)),
    ),
    signature = sign('sha256', tbs, privateKey);
  return {
    cert: pem(sequence(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])))),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
