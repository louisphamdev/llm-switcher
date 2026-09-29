// Builds the interceptor's private CA and leaf in Node alone, the same certificates as
// make-certs.sh but with no bash and no openssl, so the gateway can build a missing set itself.
// Node reads X.509 but cannot write it, so the certificates are encoded here as DER.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CA_DAYS = 3650;
const LEAF_DAYS = 825;

// ---- DER
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octets = (buf) => tlv(0x04, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bits = (buf, unused = 0) => tlv(0x03, Buffer.from([unused]), buf);
const dnsName = (host) => tlv(0x82, Buffer.from(host, 'ascii'));   // GeneralName [2] IA5String
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const s = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  // UTCTime until 2049, GeneralizedTime after, as RFC 5280 requires.
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + s)) : tlv(0x18, Buffer.from(String(y) + s));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function keyId(publicKey) {
  // The key identifier is the SHA-1 of the subjectPublicKey bits (RFC 5280, method 1).
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

function certificate({ subject, issuer, publicKey, signingKey, days, extensions }) {
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);   // an hour back, for a skewed clock
  const notAfter = new Date(notBefore.getTime() + days * 86400000);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    tlv(0xa0, int([2])),                       // v3
    int(serial),
    ECDSA_SHA256,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions))
  );
  const sig = crypto.sign('sha256', tbs, signingKey);
  const der = seq(tbs, ECDSA_SHA256, bits(sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemKey = (k) => k.export({ type: 'sec1', format: 'pem' });

/** A leaf for `hosts`, signed by the CA in `dir`. Returns the PEM strings; writes nothing. */
export function signLeaf(dir, hosts) {
  const caKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'ca.key')));
  const caCert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca.pem')));
  const { publicKey, privateKey } = newKey();
  const cert = certificate({
    subject: 'llm-switcher',
    issuer: 'LLM Switcher Local CA',
    publicKey,
    signingKey: caKey,
    days: LEAF_DAYS,
    extensions: [
      ext('2.5.29.19', true, seq()),                                  // basicConstraints CA:FALSE
      ext('2.5.29.15', true, bits(Buffer.from([0xa0]), 5)),           // digitalSignature, keyEncipherment
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),         // extendedKeyUsage serverAuth
      ext('2.5.29.17', false, seq(...hosts.map(dnsName))),            // subjectAltName
      ext('2.5.29.14', false, octets(keyId(publicKey))),
      ext('2.5.29.35', false, seq(tlv(0x80, keyId(caCert.publicKey))))
    ]
  });
  return { cert, key: pemKey(privateKey) };
}

function writePrivate(dir, files) {
  // Write each file beside its target and rename it into place: a failed run keeps the last set,
  // and a rename replaces a planted symlink instead of writing through it.
  const staged = [];
  for (const [f, body] of Object.entries(files)) {
    const tmpFile = path.join(dir, `.${f}.${process.pid}.tmp`);
    fs.writeFileSync(tmpFile, body, { mode: 0o600, flag: 'wx' });
    staged.push([tmpFile, path.join(dir, f)]);
  }
  for (const [from, to] of staged) fs.renameSync(from, to);
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid()) {
      throw new Error(`${dir} is not a directory you own; the CA key cannot go there`);
    }
    fs.chmodSync(dir, 0o700);
  }
}

/** A new CA and leaf in `dir`, the set make-certs.sh builds. */
export function buildCerts(dir, hosts) {
  privateDir(dir);
  const { publicKey, privateKey } = newKey();
  const caPem = certificate({
    subject: 'LLM Switcher Local CA',
    issuer: 'LLM Switcher Local CA',
    publicKey,
    signingKey: privateKey,
    days: CA_DAYS,
    extensions: [
      ext('2.5.29.19', true, seq(bool(true), int([0]))),              // CA:TRUE, pathlen:0
      ext('2.5.29.15', true, bits(Buffer.from([0x06]), 1)),           // keyCertSign, cRLSign
      ext('2.5.29.14', false, octets(keyId(publicKey))),
      // A leaked ca.key can then sign only for the host table.
      ext('2.5.29.30', true, seq(tlv(0xa0, ...hosts.map(h => seq(dnsName(h))))))
    ]
  });
  writePrivate(dir, { 'ca.key': pemKey(privateKey), 'ca.pem': caPem });
  writeLeaf(dir, hosts);
}

/** A new leaf in `dir` on the CA already there. */
export function writeLeaf(dir, hosts) {
  privateDir(dir);
  const { cert, key } = signLeaf(dir, hosts);
  writePrivate(dir, { 'leaf.key': key, 'leaf.pem': cert });
}
