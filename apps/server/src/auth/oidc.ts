import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { domainToASCII, domainToUnicode } from "node:url";
import * as client from "openid-client";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Sign-in to the admin area with Keycloak or any OpenID Connect provider:
 * the authorization code flow with PKCE, a state and a nonce. With the
 * Django version's settings (KEYCLOAK_BASE_URL and KEYCLOAK_REALM), the
 * endpoints are the realm's, as that version derived them, without
 * discovery. With OIDC_ISSUER, they come from the provider's discovery
 * document, fetched on first use and cached for an hour, so the app starts
 * even while the provider is down. Explicit endpoints (OIDC_*_ENDPOINT) win
 * over both.
 *
 * The ID token gets every check of the Django version (portal/auth.py):
 * issuer, every audience the client, the authorized party, a subject and a
 * nonce, expiry without leeway and after the issue time, issue and
 * not-before times at most a minute ahead, and the signature.
 */

export class ProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

const DISCOVERY_CACHE_MS = 3600 * 1000;
/** Allowed difference between this server's clock and the provider's. */
export const CLOCK_SKEW_SECONDS = 60;
const TIMEOUT_SECONDS = 10;
const MAX_REDIRECT_LENGTH = 2048;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Tests only: replaces fetch for the provider's endpoints. */
export const providerFetch: { fetch: typeof fetch } = { fetch: (...args) => fetch(...args) };

/** Whether a value is an http(s) URL an endpoint may have: a valid host, no credentials, no fragment. */
export function isEndpointUrl(value: unknown, options: { redirect?: boolean } = {}): value is string {
  // Backslashes, fragments, whitespace and control characters (code points below 32, and 127).
  if (
    typeof value !== "string" ||
    /[\\#\s]/.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    return false;
  }
  // A lone surrogate cannot be sent; URL() would quietly replace it.
  if (!value.isWellFormed()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    return false;
  if (url.port === "0") return false;
  if (options.redirect && value.length > MAX_REDIRECT_LENGTH) return false;
  if (url.hostname.startsWith("[")) return true;
  // IDNA 2008, as the Django version checked: labels of letters, marks,
  // digits and hyphens, no symbols such as "☕" (URL() accepts them).
  const labels = domainToUnicode(url.hostname).split(".");
  if (!labels.every((label) => /^[\p{L}\p{M}\p{N}-]*$/u.test(label))) return false;
  const hostname = domainToASCII(url.hostname).replace(/\.$/, "");
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    hostname.split(".").every((label) => DNS_LABEL.test(label))
  );
}

type Endpoints = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
};

function overrides(): Partial<Endpoints> {
  const settings = config();
  return {
    authorization_endpoint: settings.OIDC_AUTHORIZATION_ENDPOINT,
    token_endpoint: settings.OIDC_TOKEN_ENDPOINT,
    userinfo_endpoint: settings.OIDC_USERINFO_ENDPOINT,
    jwks_uri: settings.OIDC_JWKS_ENDPOINT,
    end_session_endpoint: settings.OIDC_LOGOUT_ENDPOINT,
  };
}

function validateDiscovery(document: unknown, explicit: Partial<Endpoints>): Endpoints {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ProviderUnavailable("The discovery document must be a JSON object.");
  }
  const values = document as Record<string, unknown>;
  const issuer = values.issuer;
  if (typeof issuer !== "string" || issuer.replace(/\/+$/, "") !== config().oidcIssuer) {
    throw new ProviderUnavailable("The discovery document names a different issuer.");
  }
  const endpoints: Partial<Endpoints> = { issuer };
  const required: (keyof Endpoints)[] = ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"];
  // Signing keys are fetched only for public-key algorithms.
  if (!config().OIDC_SIGN_ALGO.startsWith("HS")) required.push("jwks_uri");
  for (const name of required) {
    const value = explicit[name] || values[name];
    if (!isEndpointUrl(value, { redirect: name === "authorization_endpoint" })) {
      throw new ProviderUnavailable(`The sign-in provider has no valid ${name}.`);
    }
    endpoints[name] = value;
  }
  const endSession = explicit.end_session_endpoint || values.end_session_endpoint;
  if (isEndpointUrl(endSession, { redirect: true })) endpoints.end_session_endpoint = endSession;
  return endpoints as Endpoints;
}

let cache: { key: string; endpoints: Endpoints; until: number } | null = null;

/** Tests only. */
export function resetDiscoveryCache() {
  cache = null;
  configurations.clear();
}

/** The provider's OpenID configuration, with explicit settings winning. */
export async function discovery(): Promise<Endpoints> {
  const settings = config();
  if (!settings.oidcIssuer)
    throw new ProviderUnavailable("Set KEYCLOAK_BASE_URL and KEYCLOAK_REALM, or OIDC_ISSUER.");
  const explicit = overrides();
  const key = createHash("sha256")
    .update(JSON.stringify([settings.oidcIssuer, settings.OIDC_SIGN_ALGO, explicit]))
    .digest("hex");
  if (cache && cache.key === key && cache.until > Date.now()) return cache.endpoints;
  if (settings.oidcLegacyKeycloak) {
    // config/settings.py of the Django version: the realm's endpoints.
    const base = `${settings.oidcIssuer}/protocol/openid-connect`;
    return validateDiscovery(
      {
        issuer: settings.oidcIssuer,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/certs`,
        end_session_endpoint: `${base}/logout`,
      },
      explicit,
    );
  }
  let document: unknown;
  try {
    const response = await providerFetch.fetch(`${settings.oidcIssuer}/.well-known/openid-configuration`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try {
      document = await response.json();
    } catch {
      throw new ProviderUnavailable("The discovery document is not valid JSON.");
    }
  } catch (error) {
    if (error instanceof ProviderUnavailable) throw error;
    if (
      explicit.authorization_endpoint &&
      explicit.token_endpoint &&
      explicit.userinfo_endpoint &&
      explicit.jwks_uri
    ) {
      // Sign-in can use explicit endpoints while discovery is unavailable; it
      // is tried again on the next request so provider logout can recover.
      // ID tokens must name the issuer as configured, with or without the
      // slash at the end some providers sign.
      return validateDiscovery({ issuer: settings.oidcIssuerConfigured }, explicit);
    }
    throw new ProviderUnavailable("Could not read the discovery document.");
  }
  const endpoints = validateDiscovery(document, explicit);
  cache = { key, endpoints, until: Date.now() + DISCOVERY_CACHE_MS };
  return endpoints;
}

const configurations = new Map<string, client.Configuration>();

/** The openid-client configuration for the current endpoints. */
async function clientConfiguration(): Promise<client.Configuration> {
  const settings = config();
  const endpoints = await discovery();
  const key = JSON.stringify(endpoints);
  const known = configurations.get(key);
  if (known) return known;
  const configuration = new client.Configuration(
    endpoints as client.ServerMetadata,
    settings.OIDC_CLIENT_ID,
    {
      client_secret: settings.OIDC_CLIENT_SECRET,
      id_token_signed_response_alg: settings.OIDC_SIGN_ALGO,
      [client.clockTolerance]: CLOCK_SKEW_SECONDS,
    },
    client.ClientSecretPost(settings.OIDC_CLIENT_SECRET),
  );
  configuration.timeout = TIMEOUT_SECONDS;
  // Security: verify the ID token's signature with the provider's keys, as
  // the Django version did; openid-client skips it by default for tokens
  // from the token endpoint. Symmetric algorithms (HS*) have no keys to fetch.
  if (!settings.OIDC_SIGN_ALGO.startsWith("HS")) client.enableNonRepudiationChecks(configuration);
  configuration[client.customFetch] = (url, options) =>
    providerFetch.fetch(url, { ...(options as RequestInit), redirect: "manual" });
  if (Object.values(endpoints).some((value) => typeof value === "string" && value.startsWith("http:"))) {
    client.allowInsecureRequests(configuration);
  }
  configurations.clear();
  configurations.set(key, configuration);
  return configuration;
}

export function callbackUrl(): string {
  return `${config().APP_URL}/oidc/callback/`;
}

export type SignInState = { state: string; nonce: string; verifier: string; next: string };

/** Where the browser goes to sign in, and the state the callback checks. */
export async function authorizationUrl(next: string): Promise<{ url: string; state: SignInState }> {
  const configuration = await clientConfiguration();
  const state: SignInState = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
    next,
  };
  const url = client.buildAuthorizationUrl(configuration, {
    redirect_uri: callbackUrl(),
    scope: config().OIDC_SCOPES,
    response_type: "code",
    state: state.state,
    nonce: state.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(state.verifier),
    code_challenge_method: "S256",
  });
  if (url.href.length > MAX_REDIRECT_LENGTH) throw new ProviderUnavailable("The sign-in URL is too long.");
  return { url: url.href, state };
}

/**
 * Exchanges the code of the provider's redirect for tokens, verifies the ID
 * token and reads the user info, which must be about the ID token's subject.
 * Returns the user info claims, with the groups of the verified ID token when
 * it has them (Keycloak may put them only there), and the ID token, the hint
 * of a later sign-out.
 */
export async function completeSignIn(
  currentUrl: URL,
  state: SignInState,
): Promise<{ claims: Record<string, unknown>; idToken: string }> {
  const configuration = await clientConfiguration();
  const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
    pkceCodeVerifier: state.verifier,
    expectedState: state.state,
    expectedNonce: state.nonce,
    idTokenExpected: true,
  });
  const idClaims = tokens.claims();
  if (!idClaims) throw new Error("No ID token");
  // openid-client verifies signatures only with the provider's public keys
  // (enableNonRepudiationChecks); a symmetric one is checked here with the
  // client secret.
  if (config().OIDC_SIGN_ALGO.startsWith("HS")) verifyHmac(tokens.id_token ?? "", config().OIDC_SIGN_ALGO);
  checkIdToken(idClaims as unknown as Record<string, unknown>);
  // Security: the user is chosen from these claims, so they must be about the
  // subject of the verified ID token (OpenID Connect Core 5.3.2).
  const userInfo = await client.fetchUserInfo(configuration, tokens.access_token, idClaims.sub);
  if (userInfo.sub !== idClaims.sub) throw new Error("User info for another subject than the ID token");
  const claims: Record<string, unknown> = { ...userInfo };
  const groupsClaim = config().OIDC_GROUPS_CLAIM;
  const idGroups = (idClaims as Record<string, unknown>)[groupsClaim];
  if (Array.isArray(idGroups)) claims[groupsClaim] = idGroups;
  return { claims, idToken: tokens.id_token ?? "" };
}

/**
 * The checks of the Django version that openid-client does not make, or
 * makes with more leeway: every audience is this client, an authorized
 * party when there is one or several audiences, a subject and a nonce,
 * numeric times, expiry in the future (no leeway) and after the issue time,
 * issue and not-before times at most a minute ahead.
 */
export function checkIdToken(payload: Record<string, unknown>, nowSeconds = Date.now() / 1000): void {
  const settings = config();
  // The Django version compared the realm URL exactly; with OIDC_ISSUER, a
  // slash at the end some providers sign does not count.
  const issuer = settings.oidcLegacyKeycloak ? payload.iss : String(payload.iss).replace(/\/+$/, "");
  if (issuer !== settings.oidcIssuer) throw new Error("ID token issuer did not match");
  for (const claim of ["sub", "nonce"]) {
    if (typeof payload[claim] !== "string" || !payload[claim])
      throw new Error(`ID token ${claim} is missing`);
  }
  const audience = payload.aud;
  const audiences = typeof audience === "string" ? [audience] : audience;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some((value) => value !== settings.OIDC_CLIENT_ID)
  ) {
    throw new Error("ID token audience did not match");
  }
  if (("azp" in payload || audiences.length > 1) && payload.azp !== settings.OIDC_CLIENT_ID) {
    throw new Error("ID token authorized party did not match");
  }
  const times: Record<string, number> = {};
  for (const claim of ["exp", "iat", "nbf"]) {
    if (claim === "nbf" && !(claim in payload)) continue;
    const value = payload[claim];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`ID token ${claim} is invalid`);
    times[claim] = value;
  }
  if (times.exp! <= nowSeconds || times.exp! <= times.iat!) throw new Error("ID token has expired");
  // One minute of provider clock skew for issue and not-before times.
  if (
    times.iat! > nowSeconds + CLOCK_SKEW_SECONDS ||
    (times.nbf ?? nowSeconds) > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new Error("ID token is not yet valid");
  }
}

/** Checks the HMAC signature of an ID token signed with the client secret (HS256, HS384, HS512). */
function verifyHmac(idToken: string, algorithm: string): void {
  const [header, payload, signature] = idToken.split(".");
  if (!header || !payload || signature === undefined) throw new Error("ID token is not a signed JWT");
  const { alg } = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown };
  if (alg !== algorithm) throw new Error("ID token signed with an unexpected algorithm");
  const expected = createHmac(`sha${algorithm.slice(2)}`, config().OIDC_CLIENT_SECRET)
    .update(`${header}.${payload}`)
    .digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new Error("ID token signature is invalid");
}

/** Where sign-out sends the browser: the provider's sign-out, or the start page (as in the Django version). */
export async function providerLogoutUrl(idToken: string): Promise<string> {
  const postLogout = `${config().APP_URL}/`;
  let endpoint: string | undefined;
  try {
    endpoint = (await discovery()).end_session_endpoint;
  } catch (error) {
    if (!(error instanceof ProviderUnavailable))
      logger.warn({ err: error }, "could not read the provider's sign-out");
  }
  if (!endpoint) return postLogout;
  const url = new URL(endpoint);
  url.searchParams.set("client_id", config().OIDC_CLIENT_ID);
  url.searchParams.set("post_logout_redirect_uri", postLogout);
  if (idToken) url.searchParams.set("id_token_hint", idToken);
  return url.href.length <= MAX_REDIRECT_LENGTH ? url.href : postLogout;
}

/** Where people manage their own sign-in (Keycloak's account console). */
export function accountUrl(): string {
  const settings = config();
  return settings.oidcProviderKind === "keycloak" && settings.oidcIssuer
    ? `${settings.oidcIssuer}/account/`
    : "";
}
