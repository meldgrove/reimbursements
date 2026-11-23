import { BlockList, isIP } from "node:net";
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
 *   without one. `create: true` starts a session first. A started session
 *   must persist even when later admission fails, so never ask for one
 *   inside a transaction that can roll back (it commits on its own).
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

function canonical(address: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const trimmed = address.trim();
  const version = isIP(trimmed);
  if (version === 4) return { address: trimmed, family: "ipv4" };
  if (version !== 6) return null;
  // IPv4-mapped IPv6 (::ffff:192.0.2.1) counts as the IPv4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped && isIP(mapped[1]!) === 4) return { address: mapped[1]!, family: "ipv4" };
  return { address: trimmed, family: "ipv6" };
}

function proxyList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split("/");
    const parsed = canonical(address ?? "");
    if (!parsed) continue;
    if (prefix === undefined) list.addAddress(parsed.address, parsed.family);
    else list.addSubnet(parsed.address, Number(prefix), parsed.family);
  }
  return list;
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
  let peer = canonical(remoteAddress ?? "");
  if (!peer) return "unknown";
  const proxies = proxyList(trustedProxies);
  const forwarded = forwardedFor ?? "";
  if (proxies.check(peer.address, peer.family) && forwarded.length <= 1024) {
    const chain = forwarded.split(",").map((value) => canonical(value));
    if (chain.every((hop) => hop !== null)) {
      for (const hop of [...chain].reverse()) {
        if (!proxies.check(peer.address, peer.family)) break;
        peer = hop;
      }
    }
  }
  if (peer.family === "ipv4") return `${peer.address}/32`;
  const groups = [...ipv6Groups(peer.address).slice(0, 3), 0, 0, 0, 0, 0];
  return `${compressIpv6(groups)}/48`;
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
    await saveParticipantData(session.token, session.data);
  }
}
