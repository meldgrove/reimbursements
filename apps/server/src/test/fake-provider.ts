import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject, createHmac } from "node:crypto";
import { providerFetch, resetDiscoveryCache } from "../auth/oidc";
import { config, resetConfigForTests } from "../config";
import { testApp } from "./helpers";

/**
 * A sign-in provider for tests (port of the fakes of tests/test_auth.py):
 * the discovery document, the signing keys, the token endpoint and the user
 * info, answered through `providerFetch.fetch`. The token endpoint checks
 * the code, the PKCE verifier, the client and the redirect URI, and answers
 * with an RS256 ID token for the nonce of the authorization request.
 */

export const ISSUER = "https://sso.example.invalid/realms/test";
export const CLIENT_ID = "reimbursements";
export const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
  userinfo_endpoint: `${ISSUER}/protocol/openid-connect/userinfo`,
  jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
  end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
};
export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

export type Claims = Record<string, unknown>;

/** The claims of the sign-ins in the tests: Ada, a template admin with a verified address. */
export function claims(extra: Claims = {}): Claims {
  return {
    sub: "subject-1",
    email: "ada@example.invalid",
    email_verified: true,
    given_name: "Ada",
    family_name: "Admin",
    groups: ["/reimbursements/admins"],
    ...extra,
  };
}

type Authorization = { codeChallenge: string; nonce: string; redirectUri: string; clientId: string };
type Answer = Response | Error | unknown;

const now = () => Math.floor(Date.now() / 1000);

/** A JWT signed with `key` (RS256, RS512). */
export function signJwt(payload: Claims, key: KeyObject, algorithm = "RS256", kid = "k1"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: algorithm, typ: "JWT", kid })}.${encode(payload)}`;
  if (algorithm.startsWith("HS")) {
    // Symmetric: `key` holds the client secret (createSecretKey).
    return `${input}.${createHmac(`sha${algorithm.slice(2)}`, key.export())
      .update(input)
      .digest("base64url")}`;
  }
  const digest = { RS256: "sha256", RS384: "sha384", RS512: "sha512" }[algorithm];
  if (!digest) throw new Error(`No signer for ${algorithm}`);
  return `${input}.${sign(digest, Buffer.from(input), key).toString("base64url")}`;
}

export function rsaKey(): KeyObject {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
}

export class FakeProvider {
  readonly key = rsaKey();
  /** Every URL the app fetched from the provider, in order. */
  readonly requests: string[] = [];
  /** The discovery answer: a document (served as JSON), a Response, or an Error to throw. */
  discovery: Answer | (() => Answer) = DISCOVERY;
  /** The claims of the user info endpoint. */
  userInfo: Claims = claims();
  /** Changes the ID token of the next token request: its claims, its algorithm and key, or the raw token. */
  idToken: { claims?: Claims; algorithm?: string; key?: KeyObject; raw?: string } = {};
  private readonly authorizations = new Map<string, Authorization>();
  private readonly accessTokens = new Set<string>();

  /** The ID token claims the token endpoint signs for an authorization. */
  idTokenClaims(nonce: string): Claims {
    const issuedAt = now();
    return { iss: ISSUER, aud: CLIENT_ID, sub: "subject-1", nonce, iat: issuedAt, exp: issuedAt + 300 };
  }

  /** Approves the authorization request the app redirected to; returns the code for the callback. */
  authorize(location: string): { code: string; state: string } {
    const url = new URL(location);
    const code = randomBytes(16).toString("hex");
    this.authorizations.set(code, {
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      nonce: url.searchParams.get("nonce") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      clientId: url.searchParams.get("client_id") ?? "",
    });
    return { code, state: url.searchParams.get("state") ?? "" };
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requests.push(url);
    if (url === DISCOVERY_URL)
      return this.answer(typeof this.discovery === "function" ? this.discovery() : this.discovery);
    if (url === DISCOVERY.jwks_uri) {
      // No "alg": it is optional in a JWKS.
      const jwk = this.key.export({ format: "jwk" });
      return Response.json({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "k1", use: "sig" }] });
    }
    if (url === DISCOVERY.token_endpoint) return this.token(init);
    if (url === DISCOVERY.userinfo_endpoint) {
      const authorization = new Headers(init.headers).get("authorization") ?? "";
      if (!this.accessTokens.has(authorization.replace(/^Bearer /, "")))
        return Response.json({}, { status: 401 });
      return Response.json(this.userInfo);
    }
    throw new TypeError("fetch failed", { cause: new Error(`No fake for ${url}`) });
  };

  private answer(value: Answer): Response {
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return Response.json(value);
  }

  /** The form of the last token request. */
  lastTokenRequest: URLSearchParams | undefined;

  private token(init: RequestInit): Response {
    const form = new URLSearchParams(init.body as URLSearchParams | string);
    this.lastTokenRequest = form;
    const authorization = this.authorizations.get(form.get("code") ?? "");
    this.authorizations.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      !authorization ||
      form.get("grant_type") !== "authorization_code" ||
      challenge !== authorization.codeChallenge ||
      form.get("redirect_uri") !== authorization.redirectUri ||
      form.get("client_id") !== CLIENT_ID ||
      form.get("client_secret") !== config().OIDC_CLIENT_SECRET ||
      authorization.clientId !== CLIENT_ID
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const accessToken = randomBytes(16).toString("hex");
    this.accessTokens.add(accessToken);
    const { claims: extra = {}, algorithm = "RS256", key = this.key, raw } = this.idToken;
    const payload = Object.fromEntries(
      Object.entries({ ...this.idTokenClaims(authorization.nonce), ...extra }).filter(
        ([, value]) => value !== undefined,
      ),
    );
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      id_token: raw ?? signJwt(payload, key, algorithm),
    });
  }
}

/**
 * Uses a new fake provider as the app's sign-in provider: the issuer of the
 * fake, a fresh discovery cache. Returns the provider and a function that
 * puts everything back.
 */
export function useFakeProvider(): { provider: FakeProvider; restore: () => void } {
  const provider = new FakeProvider();
  const originalFetch = providerFetch.fetch;
  const originalIssuer = process.env.OIDC_ISSUER;
  const originalClient = process.env.OIDC_CLIENT_ID;
  const originalKeycloak = process.env.KEYCLOAK_BASE_URL;
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  delete process.env.KEYCLOAK_BASE_URL;
  resetConfigForTests();
  resetDiscoveryCache();
  providerFetch.fetch = provider.fetch as typeof fetch;
  return {
    provider,
    restore: () => {
      providerFetch.fetch = originalFetch;
      setEnv("OIDC_ISSUER", originalIssuer);
      setEnv("OIDC_CLIENT_ID", originalClient);
      setEnv("KEYCLOAK_BASE_URL", originalKeycloak);
      resetConfigForTests();
      resetDiscoveryCache();
    },
  };
}

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** The value of a cookie a response sets (the last one, when it sets it more than once), or undefined. */
export function setCookie(response: Response, name: string): string | undefined {
  let value: string | undefined;
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair!.indexOf("=");
    if (pair!.slice(0, at) === name) value = pair!.slice(at + 1);
  }
  return value;
}

/**
 * Signs in through the app's routes: /oidc/authenticate/ (which sets the
 * state cookie), the provider's approval, then /oidc/callback/ with the
 * state cookie. Returns both responses and the session cookie, if one was set.
 */
export async function signIn(
  provider: FakeProvider,
  /** callbackOrigin: where the callback arrives, as a proxy forwards it (default: the test origin). */
  options: { cookie?: string; next?: string; callbackOrigin?: string } = {},
) {
  const query = options.next ? `?next=${encodeURIComponent(options.next)}` : "";
  const headers: Record<string, string> = options.cookie ? { cookie: options.cookie } : {};
  const start = await testApp().request(`/oidc/authenticate/${query}`, {
    headers: { accept: "text/html", ...headers },
  });
  const location = start.headers.get("location") ?? "";
  const stateCookie = setCookie(start, "reimbursements_oidc");
  if (start.status !== 302 || !location.startsWith(DISCOVERY.authorization_endpoint) || !stateCookie) {
    throw new Error(`The sign-in did not reach the provider: ${start.status} ${location}`);
  }
  const { code, state } = provider.authorize(location);
  const cookies = [`reimbursements_oidc=${stateCookie}`, ...(options.cookie ? [options.cookie] : [])].join(
    "; ",
  );
  const callback = await testApp().request(
    `${options.callbackOrigin ?? ""}/oidc/callback/?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: cookies } },
  );
  return {
    start,
    callback,
    location: callback.headers.get("location") ?? "",
    session: setCookie(callback, "reimbursements_session"),
  };
}
