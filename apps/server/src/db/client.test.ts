import { describe, expect, it } from "vitest";
import pg from "pg";
import { withLibpqSslModes } from "./client";

const URL_BASE = "postgresql://iam:secret@db.example.invalid:5432/iam";

describe("withLibpqSslModes", () => {
  it("gives sslmode=require and prefer the meaning of PostgreSQL, as in the Django version", () => {
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=require`)).toBe(
      `${URL_BASE}?sslmode=require&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?connect_timeout=5&sslmode=prefer`)).toBe(
      `${URL_BASE}?connect_timeout=5&sslmode=prefer&uselibpqcompat=true`,
    );
    // The host in the query, which URL does not accept.
    expect(withLibpqSslModes("postgresql://iam:secret@/iam?host=db.example.invalid&sslmode=require")).toBe(
      "postgresql://iam:secret@/iam?host=db.example.invalid&sslmode=require&uselibpqcompat=true",
    );
    // A "?" in a value, and verify-ca with its CA.
    expect(withLibpqSslModes(`${URL_BASE}?application_name=iam?preview&sslmode=require`)).toBe(
      `${URL_BASE}?application_name=iam?preview&sslmode=require&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=verify-ca&sslrootcert=/run/ca.pem`)).toBe(
      `${URL_BASE}?sslmode=verify-ca&sslrootcert=/run/ca.pem&uselibpqcompat=true`,
    );
    expect(withLibpqSslModes(`${URL_BASE}?sslmode=verify-full&sslmode=require`)).toBe(
      `${URL_BASE}?sslmode=verify-full&sslmode=require&uselibpqcompat=true`,
    );
    // Encrypted, the certificate unchecked.
    const client = new pg.Client({ connectionString: withLibpqSslModes(`${URL_BASE}?sslmode=require`) });
    const { ssl } = (client as unknown as { connectionParameters: { ssl: { rejectUnauthorized?: boolean } } })
      .connectionParameters;
    expect(ssl.rejectUnauthorized).toBe(false);
  });

  it("leaves every other URL as it is", () => {
    for (const url of [
      URL_BASE,
      `${URL_BASE}?sslmode=verify-full`,
      `${URL_BASE}?sslmode=disable`,
      `${URL_BASE}?sslmode=no-verify`,
      `${URL_BASE}?sslmode=require&uselibpqcompat=false`,
      "not a url",
      "not a url?sslmode=verify-full",
      `${URL_BASE}?sslmode=verify-ca`,
      `${URL_BASE}?sslmode=require&sslmode=verify-full`,
    ]) {
      expect(withLibpqSslModes(url)).toBe(url);
    }
  });
});
