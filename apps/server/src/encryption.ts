/**
 * Secrets that admins enter, such as an email provider's API token, encrypted at rest
 * (portal/encryption.py of the Django version).
 *
 * Fernet tokens, with the key derived from the app's secret as Django derived it from
 * DJANGO_SECRET_KEY (HKDF-SHA256, no salt), so a database backup alone does not reveal
 * them and values sealed by 0.4.2 open here and the other way round. AUTH_SECRET seals;
 * DJANGO_SECRET_KEY, when it is set and differs, still opens what 0.4.2 sealed with it.
 * After the secret changes otherwise, saved values cannot be read and have to be entered
 * again.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config";

const PURPOSE = "reimbursements: secrets entered in the admin area";
const VERSION = 0x80;

type Key = { signing: Buffer; encryption: Buffer };

function keyOf(secret: string): Key {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), PURPOSE, 32));
  return { signing: key.subarray(0, 16), encryption: key.subarray(16) };
}

/** The keys that open sealed values, the sealing one first (Django's MultiFernet). */
function keys(): Key[] {
  const settings = config();
  const secrets = [settings.AUTH_SECRET];
  if (settings.DJANGO_SECRET_KEY && settings.DJANGO_SECRET_KEY !== settings.AUTH_SECRET) {
    secrets.push(settings.DJANGO_SECRET_KEY);
  }
  return secrets.map(keyOf);
}

function base64url(content: Buffer): string {
  return content.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

/** A Fernet token of `value` with `key`, at `now` (seconds); `iv` is random but for tests. */
export function encrypt(
  value: string,
  key: Key,
  now = Math.floor(Date.now() / 1000),
  iv: Buffer = randomBytes(16),
): string {
  const cipher = createCipheriv("aes-128-cbc", key.encryption, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(now));
  const signed = Buffer.concat([Buffer.from([VERSION]), timestamp, iv, ciphertext]);
  const hmac = createHmac("sha256", key.signing).update(signed).digest();
  return base64url(Buffer.concat([signed, hmac]));
}

/** The bytes of a token, or null when it is not urlsafe base64 (Python discards other characters too). */
function decodeToken(token: string): Buffer | null {
  // eslint-disable-next-line no-control-regex -- Python encodes the token as ASCII first.
  if (/[^\x00-\x7f]/.test(token)) return null;
  const clean = token.replace(/[^A-Za-z0-9_-]/g, "");
  if (clean.length % 4 === 1) return null;
  return Buffer.from(clean.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

/** What `token` holds with `key`, or null when the key does not open it. */
function decrypt(data: Buffer, key: Key): Buffer | null {
  if (data.length < 1 + 8 + 16 + 16 + 32 || data[0] !== VERSION || (data.length - 57) % 16 !== 0) return null;
  const signed = data.subarray(0, data.length - 32);
  const expected = createHmac("sha256", key.signing).update(signed).digest();
  if (!timingSafeEqual(expected, data.subarray(data.length - 32))) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key.encryption, data.subarray(9, 25));
    return Buffer.concat([decipher.update(data.subarray(25, data.length - 32)), decipher.final()]);
  } catch {
    return null;
  }
}

/** `value` encrypted with the current secret; empty stays empty. */
export function seal(value: string): string {
  return value ? encrypt(value, keys()[0]!) : "";
}

/** The value `seal` encrypted: "" for empty, null when no key opens it. */
export function unseal(sealed: string): string | null {
  if (!sealed) return "";
  const data = decodeToken(sealed);
  if (!data) return null;
  for (const key of keys()) {
    const opened = decrypt(data, key);
    if (opened === null) continue;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(opened);
    } catch {
      return null;
    }
  }
  return null;
}

/** Tests only: the key Django would derive from `secret`. */
export const keyForTests = keyOf;
