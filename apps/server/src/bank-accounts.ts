/**
 * IBAN and BIC checks as python-stdnum makes them (the Django version used
 * stdnum.iban and stdnum.bic): the IBAN registry structure of each country
 * (iban-registry-v101, as stdnum 2.x ships it), the ISO 7064 mod 97-10
 * checksum, and the national checks stdnum adds for Belgium, Spain,
 * Montenegro and Norway (Belgium without stdnum's bank directory).
 */

/** The BBAN structure of each country: n digits, a letters, c letters or digits. */
const BBAN: Readonly<Record<string, string>> = {
  AD: "4!n4!n12!c",
  AE: "3!n16!n",
  AL: "8!n16!c",
  AT: "5!n11!n",
  AZ: "4!a20!c",
  BA: "3!n3!n8!n2!n",
  BE: "3!n7!n2!n",
  BG: "4!a4!n2!n8!c",
  BH: "4!a14!c",
  BI: "5!n5!n11!n2!n",
  BR: "8!n5!n10!n1!a1!c",
  BY: "4!c4!n16!c",
  CH: "5!n12!c",
  CR: "4!n14!n",
  CY: "3!n5!n16!c",
  CZ: "4!n16!n",
  DE: "8!n10!n",
  DJ: "5!n5!n11!n2!n",
  DK: "4!n9!n1!n",
  DO: "4!c20!n",
  EE: "2!n14!n",
  EG: "4!n4!n17!n",
  ES: "4!n4!n1!n1!n10!n",
  FI: "3!n11!n",
  FK: "2!a12!n",
  FO: "4!n9!n1!n",
  FR: "5!n5!n11!c2!n",
  GB: "4!a6!n8!n",
  GE: "2!a16!n",
  GI: "4!a15!c",
  GL: "4!n9!n1!n",
  GR: "3!n4!n16!c",
  GT: "4!c20!c",
  HN: "4!a20!n",
  HR: "7!n10!n",
  HU: "3!n4!n1!n15!n1!n",
  IE: "4!a6!n8!n",
  IL: "3!n3!n13!n",
  IQ: "4!a3!n12!n",
  IS: "4!n2!n6!n10!n",
  IT: "1!a5!n5!n12!c",
  JO: "4!a4!n18!c",
  KW: "4!a22!c",
  KZ: "3!n13!c",
  LB: "4!n20!c",
  LC: "4!a24!c",
  LI: "5!n12!c",
  LT: "5!n11!n",
  LU: "3!n13!c",
  LV: "4!a13!c",
  LY: "3!n3!n15!n",
  MC: "5!n5!n11!c2!n",
  MD: "2!c18!c",
  ME: "3!n13!n2!n",
  MK: "3!n10!c2!n",
  MN: "4!n12!n",
  MR: "5!n5!n11!n2!n",
  MT: "4!a5!n18!c",
  MU: "4!a2!n2!n12!n3!n3!a",
  NI: "4!a20!n",
  NL: "4!a10!n",
  NO: "4!n6!n1!n",
  OM: "3!n16!c",
  PK: "4!a16!c",
  PL: "8!n16!n",
  PS: "4!a21!c",
  PT: "4!n4!n11!n2!n",
  QA: "4!a21!c",
  RO: "4!a16!c",
  RS: "3!n13!n2!n",
  RU: "9!n5!n15!c",
  SA: "2!n18!c",
  SC: "4!a2!n2!n16!n3!a",
  SD: "2!n12!n",
  SE: "3!n16!n1!n",
  SI: "5!n8!n2!n",
  SK: "4!n6!n10!n",
  SM: "1!a5!n5!n12!c",
  SO: "4!n3!n12!n",
  ST: "4!n4!n11!n2!n",
  SV: "4!a20!n",
  TL: "3!n14!n2!n",
  TN: "2!n3!n13!n2!n",
  TR: "5!n1!n16!c",
  UA: "6!n19!c",
  VA: "3!n15!n",
  VG: "4!a16!n",
  XK: "4!n10!n2!n",
  YE: "4!a4!n18!c",
};

/** ISO 3166-1 alpha-2 codes and XK (Kosovo): the countries a BIC may name. */
const BIC_COUNTRIES: ReadonlySet<string> = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(
    " ",
  ),
);

function structurePattern(structure: string): RegExp {
  const chars: Record<string, string> = { n: "[0-9]", a: "[A-Z]", c: "[A-Za-z0-9]" };
  const body = structure.replace(/([1-9][0-9]*)!([nac])/g, (_match, count: string, kind: string) => {
    return `${chars[kind]}{${count}}`;
  });
  return new RegExp(`^${body}$`);
}

/** The remainder of a long number (digits only) modulo `divisor`. */
function remainder(digits: string, divisor: number): number {
  let rest = 0;
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % divisor;
  return rest;
}

/** ISO 7064 mod 97-10 over letters as 10..35: valid when the remainder is 1. */
function mod97(value: string): number {
  const digits = [...value]
    .map((char) => (/[0-9]/.test(char) ? char : String(char.charCodeAt(0) - 55)))
    .join("");
  return remainder(digits, 97);
}

function belgium(iban: string): boolean {
  const body = iban.slice(4, -2);
  const check = remainder(body, 97);
  return iban.slice(-2) === String(check || 97).padStart(2, "0");
}

function spain(iban: string): boolean {
  const ccc = iban.slice(4);
  if (!/^[0-9]{20}$/.test(ccc)) return false;
  const digit = (part: string) => {
    let sum = 0;
    [...part].forEach((n, i) => (sum += Number(n) * 2 ** i));
    const check = sum % 11;
    return String(check < 2 ? check : 11 - check);
  };
  return ccc.slice(8, 10) === digit(`00${ccc.slice(0, 8)}`) + digit(ccc.slice(10));
}

function montenegro(iban: string): boolean {
  return remainder(iban.slice(4), 97) === 1;
}

function luhn(number: string): boolean {
  let sum = 0;
  [...number].reverse().forEach((n, i) => {
    let value = Number(n);
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
  });
  return sum % 10 === 0;
}

function norway(iban: string): boolean {
  const number = iban.slice(4);
  if (!/^[0-9]+$/.test(number)) return false;
  if (number.length === 7) return luhn(number);
  if (number.length !== 11) return false;
  const weights = [6, 7, 8, 9, 4, 5, 6, 7, 8, 9];
  const sum = weights.reduce((total, weight, i) => total + weight * Number(number[i]), 0);
  return String(sum % 11) === number.slice(-1);
}

const NATIONAL: Readonly<Record<string, (iban: string) => boolean>> = {
  BE: belgium,
  ES: spain,
  ME: montenegro,
  NO: norway,
};

/** Whether `value` is a valid IBAN (stdnum.iban.is_valid). Spaces, hyphens and dots are ignored. */
export function isValidIban(value: string): boolean {
  const iban = value
    .replace(/[ \-.]/g, "")
    .trim()
    .toUpperCase();
  if (iban.length < 5 || !/^[A-Z0-9]+$/.test(iban)) return false;
  if (mod97(iban.slice(4) + iban.slice(0, 4)) !== 1) return false;
  const structure = BBAN[iban.slice(0, 2)];
  if (!structure || !structurePattern(structure).test(iban.slice(4))) return false;
  const national = NATIONAL[iban.slice(0, 2)];
  return national ? national(iban) : true;
}

/** Whether `value` is a valid BIC (stdnum.bic.is_valid). Spaces and hyphens are ignored. */
export function isValidBic(value: string): boolean {
  const bic = value.replace(/[ -]/g, "").trim().toUpperCase();
  if (bic.length !== 8 && bic.length !== 11) return false;
  const match = /^[A-Z]{4}([A-Z]{2})[0-9A-Z]{2}([0-9A-Z]{3})?$/.exec(bic);
  return Boolean(match && BIC_COUNTRIES.has(match[1]!));
}
