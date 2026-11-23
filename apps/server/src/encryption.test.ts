// The encryption cases of tests/test_email_settings.py of the Django version, and the
// proof that sealed values open in both versions.
import { afterEach, describe, expect, it } from "vitest";
import { overrideConfigForTests } from "./config";
import { encrypt, keyForTests, seal, unseal } from "./encryption";

/** The secret the Django fixtures below were sealed with (`uv run python` in the Django version). */
const DJANGO_SECRET = "django-secret-for-interop-fixtures-0123456789abcdefghijklmnop";
/** encryption.seal("mlsn.synthetic-token") of the Django version. */
const DJANGO_TOKEN =
  "gAAAAABrBBeazEKztfYSwN00TSB9PkGlanP11XGbVwGHp0wK4qpBALkJnxMl1yFm3Yp8Pn2sUWRLkZaH-4zuizGdntS4BdZNUW8ZCu7jp2TwRBQ9TA-efy4=";
/** encryption.seal("pässword ✓ ") of the Django version. */
const DJANGO_NON_ASCII =
  "gAAAAABrBBea_lXghMZ5DoYzpeHnbPEAW_aYfufRkhGRbbPdpD0vu1tFlCeGRARVjV0LXL_Mev0OlTaHawX_jKJUVWVnh3F3Tw==";
/** Fernet._encrypt_from_parts("pässword ✓ ", 1795400000, bytes(range(16))) with the Django key. */
const DJANGO_FROM_PARTS =
  "gAAAAABrA6FAAAECAwQFBgcICQoLDA0OD7Jd2K0IkQqKrQhFQDitPkWQC5FWmT6JF0K11U2sWDmq4FApEqxh6iUZdY5Mk_diUA==";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function secrets(authSecret: string, djangoSecretKey?: string) {
  restore?.();
  restore = overrideConfigForTests({ AUTH_SECRET: authSecret, DJANGO_SECRET_KEY: djangoSecretKey });
}

describe("sealed secrets", () => {
  it("open only with the secret key or its fallback", () => {
    secrets("test-secret-test-secret-test-secret-test-secret-1234");
    const sealed = seal("mlsn.synthetic-token");
    expect(sealed).not.toContain("synthetic");
    expect(unseal(sealed)).toBe("mlsn.synthetic-token");
    expect(seal("")).toBe("");
    expect(unseal("")).toBe("");
    secrets("another-secret-key-".repeat(4));
    expect(unseal(sealed)).toBeNull();
    // DJANGO_SECRET_KEY beside a new AUTH_SECRET opens what the old secret sealed.
    secrets("another-secret-key-".repeat(4), "test-secret-test-secret-test-secret-test-secret-1234");
    expect(unseal(sealed)).toBe("mlsn.synthetic-token");
  });

  it("open what the Django version sealed with the same secret", () => {
    secrets(DJANGO_SECRET);
    expect(unseal(DJANGO_TOKEN)).toBe("mlsn.synthetic-token");
    expect(unseal(DJANGO_NON_ASCII)).toBe("pässword ✓ ");
    secrets("another-secret-key-".repeat(4));
    expect(unseal(DJANGO_TOKEN)).toBeNull();
  });

  it("are the tokens the Django version makes, so it opens them too", () => {
    const iv = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    expect(encrypt("pässword ✓ ", keyForTests(DJANGO_SECRET), 1_795_400_000, iv)).toBe(DJANGO_FROM_PARTS);
  });

  it("are unreadable, not an error, when damaged", () => {
    secrets(DJANGO_SECRET);
    expect(unseal(`${DJANGO_TOKEN.slice(0, -6)}AAAAA=`)).toBeNull();
    expect(unseal("not a token")).toBeNull();
    expect(unseal("gAAAAAä")).toBeNull();
  });
});
