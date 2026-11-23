import { describe, expect, it } from "vitest";
import { clientNetwork } from "./participants";

describe("clientNetwork", () => {
  // Port of test_client_network_trusts_only_configured_proxy_chain (tests/test_draft_limits.py).
  it.each([
    ["192.0.2.1", "198.51.100.1", [], "192.0.2.1/32"],
    ["10.0.0.2", "198.51.100.1", ["10.0.0.0/8"], "198.51.100.1/32"],
    ["10.0.0.2", "203.0.113.2, 198.51.100.1", ["10.0.0.0/8"], "198.51.100.1/32"],
    ["10.0.0.2", "198.51.100.1, 10.0.0.3", ["10.0.0.0/8"], "198.51.100.1/32"],
    ["10.0.0.2", "invalid", ["10.0.0.0/8"], "10.0.0.2/32"],
    ["2001:db8::1", "", [], "2001:db8::/48"],
    ["2001:db8::ffff", "", [], "2001:db8::/48"],
    // Another /64 of the same site shares its budget; another site does not.
    ["2001:db8:0:ff::1", "", [], "2001:db8::/48"],
    ["2001:db8:1::1", "", [], "2001:db8:1::/48"],
    ["::ffff:192.0.2.1", "", [], "192.0.2.1/32"],
    // Both spellings of an IPv4-mapped client count as the IPv4 address (review I12/F6).
    ["::ffff:c000:201", "", [], "192.0.2.1/32"],
    ["2001:db8::1", "::ffff:c000:201", ["2001:db8::/32"], "192.0.2.1/32"],
    // Proxies match within their address family, as Python's ipaddress does.
    ["::ffff:10.0.0.2", "198.51.100.1", ["::ffff:10.0.0.0/104"], "198.51.100.1/32"],
    ["::ffff:10.0.0.2", "198.51.100.1", ["::ffff:10.0.0.2/128"], "198.51.100.1/32"],
    ["::ffff:10.0.0.2", "198.51.100.1", ["10.0.0.0/8"], "10.0.0.2/32"],
    ["10.0.0.2", "198.51.100.1", ["::ffff:10.0.0.0/104"], "10.0.0.2/32"],
  ])("trusts only the configured proxy chain: %s %s", (peer, forwarded, proxies, expected) => {
    expect(clientNetwork(peer, forwarded, proxies)).toBe(expected);
  });

  it("has no network without a peer address", () => {
    expect(clientNetwork(undefined, undefined, [])).toBe("unknown");
    expect(clientNetwork("not an address", "", [])).toBe("unknown");
  });
});
