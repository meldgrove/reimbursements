/**
 * Django's validate_email (EmailValidator), which the Django version used
 * for every email field: the form's contact, a participant's email.
 * Unlike most checks it allows `localhost` and address literals.
 */

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

// Python's case-insensitive [A-Z] also takes the dotted İ and the dotless ı,
// which JavaScript's case folding leaves out: they are listed.
const EMAIL_USER =
  // eslint-disable-next-line no-control-regex -- Django's quoted local part allows control characters.
  /^(?:[-!#$%&'*+/=?^_`{}|~0-9A-Z\u0130\u0131]+(?:\.[-!#$%&'*+/=?^_`{}|~0-9A-Z\u0130\u0131]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f!#-[\]-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")$/iu;
const UNICODE_LETTERS = "\\u00a1-\\uffff";
const EMAIL_DOMAIN = new RegExp(
  `^[a-z${UNICODE_LETTERS}0-9](?:[a-z${UNICODE_LETTERS}0-9-]{0,61}[a-z${UNICODE_LETTERS}0-9])?` +
    `(?:\\.(?!-)[a-z${UNICODE_LETTERS}0-9-]{1,63}(?<!-))*` +
    `\\.(?!-)(?:[a-z${UNICODE_LETTERS}-]{2,63}|xn--[a-z0-9]{1,59})(?<!-)$`,
  "iu",
);
const EMAIL_LITERAL = /^\[([A-F0-9:.]+)\]$/i;

export function isEmail(value: string): boolean {
  // The maximum length of an email is 320 characters per RFC 3696 section 3.
  if (!value || !value.includes("@") || [...value].length > 320) return false;
  const at = value.lastIndexOf("@");
  const [user, domain] = [value.slice(0, at), value.slice(at + 1)];
  if (!EMAIL_USER.test(user)) return false;
  if (domain === "localhost" || EMAIL_DOMAIN.test(domain)) return true;
  const literal = EMAIL_LITERAL.exec(domain)?.[1];
  return literal !== undefined && (isIPv4(literal) || (literal.length <= 39 && isIPv6(literal)));
}
