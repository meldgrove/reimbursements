import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config";
import { participantSession, saltedHmac, saveParticipantData, startParticipantSession } from "./auth/session";
import type { SessionData } from "./db/schema";

/**
 * The participant behind a request: their session binding and client
 * network (portal/participants.py of the Django version).
 *
 * Drafts, uploads and submissions take a Participant rather than the
 * request, so their interface is domain values. `RequestParticipant` is the
 * adapter for a request; tests use their own. A Participant offers:
 *
 * - `network`: the client network that shares one admission budget
 *   (`clientNetwork`).
 * - `binding({ create })`: a keyed binding of the browser session, or null
 *   without one. `create: true` starts a session first, in the caller's
 *   transaction when there is one (its cookie follows the commit): ask for
 *   one only once admission has passed, as `openDraft` does.
 * - `remembered(formSlug)` / `remember(formSlug, draftId, token)`: the draft
 *   this browser works on for a form, or null.
 */
export interface Participant {
  readonly network: string;
  binding(options?: { create?: boolean }): Promise<string | null>;
  remembered(formSlug: string): Promise<{ id: string; token: string } | null>;
  remember(formSlug: string, draftId: string, token: string): Promise<void>;
}

/** The binding of a participant session token, as drafts store it (`session_hash`). */
export function sessionBinding(token: string): string {
  return saltedHmac("draft-session", token);
}

type Address = { family: 4 | 6; bytes: number[] };

/** An address as Python's ip_address reads it: IPv4, or IPv6 (mapped IPv4 stays IPv6). */
function parseAddress(text: string): Address | null {
  const trimmed = text.trim();
  const version = isIP(trimmed);
  if (version === 4) return { family: 4, bytes: trimmed.split(".").map(Number) };
  if (version !== 6) return null;
  return { family: 6, bytes: ipv6Groups(trimmed).flatMap((group) => [group >> 8, group & 0xff]) };
}

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d, either spelling) stands for. */
function ipv4Mapped(address: Address): Address | null {
  if (address.family !== 6) return null;
  const { bytes } = address;
  if (bytes.slice(0, 10).some((byte) => byte !== 0) || bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return { family: 4, bytes: bytes.slice(12) };
}

type Network = Address & { prefix: number };

/** A trusted proxy network (host bits are ignored); null for anything else. */
function parseNetwork(cidr: string): Network | null {
  const [text, prefixText] = cidr.split("/");
  const address = parseAddress(text ?? "");
  if (!address) return null;
  const max = address.family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { ...address, prefix };
}

/** Membership as Python's `address in network`: only within one address family. */
function contains(network: Network, address: Address): boolean {
  if (network.family !== address.family) return false;
  for (let bit = 0; bit < network.prefix; bit += 1) {
    const mask = 0x80 >> (bit % 8);
    if (((network.bytes[bit >> 3] ?? 0) & mask) !== ((address.bytes[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

/** Expands an IPv6 address into its eight 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split("%")[0]!;
  // A trailing IPv4 part becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? Array(8 - left.length - right.length).fill("0") : [];
  return [...left, ...fill, ...right].map((group) => parseInt(group || "0", 16));
}

/**
 * The client network of a request: its peer address, followed back through
 * X-Forwarded-For only while each hop is a trusted proxy (TRUSTED_PROXY_CIDRS).
 * An IPv6 site (/48) shares one budget: a single customer or tunnel gets
 * thousands of /64s, which would otherwise count as separate networks.
 */
export function clientNetwork(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxies: string[] = config().TRUSTED_PROXY_CIDRS,
): string {
  let peer = parseAddress(remoteAddress ?? "");
  if (!peer) return "unknown";
  const proxies = trustedProxies.map(parseNetwork).filter((network) => network !== null);
  const trusted = (address: Address) => proxies.some((network) => contains(network, address));
  const forwarded = forwardedFor ?? "";
  // Hops keep their address family while the chain is walked, as in the Django version.
  if (trusted(peer) && forwarded.length <= 1024) {
    const chain = forwarded.split(",").map((value) => parseAddress(value));
    if (chain.every((hop): hop is Address => hop !== null)) {
      for (const hop of [...chain].reverse()) {
        if (!trusted(peer)) break;
        peer = hop;
      }
    }
  }
  // An IPv4-mapped IPv6 client (::ffff:192.0.2.1 or ::ffff:c000:201) counts as its IPv4 address.
  const client = ipv4Mapped(peer) ?? peer;
  if (client.family === 4) return `${client.bytes.join(".")}/32`;
  const groups = [0, 2, 4].map((at) => (client.bytes[at]! << 8) | client.bytes[at + 1]!);
  return `${compressIpv6([...groups, 0, 0, 0, 0, 0])}/48`;
}

/** Eight groups in the shortest form (RFC 5952), as Python's ipaddress writes them. */
function compressIpv6(groups: number[]): string {
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8;) {
    if (groups[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - start > best.length && end - start > 1) best = { start, length: end - start };
    start = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (best.start < 0) return hex.join(":");
  const head = hex.slice(0, best.start).join(":");
  const tail = hex.slice(best.start + best.length).join(":");
  return `${head}::${tail}`;
}

/** The peer address of a request (undefined in tests that pass none). */
export function remoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** The participant of a request: its participant session and client network. */
export class RequestParticipant implements Participant {
  readonly network: string;
  private session: { token: string; data: SessionData } | null | undefined;

  constructor(private readonly c: Context) {
    this.network = clientNetwork(remoteAddress(c), c.req.header("x-forwarded-for"));
  }

  private async load() {
    if (this.session === undefined) this.session = await participantSession(this.c);
    return this.session;
  }

  async binding(options: { create?: boolean } = {}): Promise<string | null> {
    let session = await this.load();
    if (!session) {
      if (!options.create) return null;
      session = this.session = await startParticipantSession(this.c);
    }
    return sessionBinding(session.token);
  }

  async remembered(formSlug: string): Promise<{ id: string; token: string } | null> {
    const value = (await this.load())?.data.drafts?.[formSlug];
    return value?.id ? { id: value.id, token: value.token } : null;
  }

  async remember(formSlug: string, draftId: string, token: string): Promise<void> {
    const session = await this.load();
    if (!session) throw new Error("A participant session must exist before a draft is remembered");
    session.data = {
      ...session.data,
      drafts: { ...session.data.drafts, [formSlug]: { id: draftId, token } },
    };
    await saveParticipantData(session.token, session.data, this.c);
  }
}
