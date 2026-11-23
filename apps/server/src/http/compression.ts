import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/utils/compress";

/**
 * Compresses text responses (JSON, HTML) with gzip for clients that accept
 * it. Never the agents' routes (large binary bodies) or snapshot downloads
 * (archives stream as restic writes them). The web app's built assets have
 * compressed copies (static.ts).
 */
export function compression(): MiddlewareHandler {
  const gzip = compress({
    encoding: "gzip",
    contentTypeFilter: (type) =>
      !/^\s*text\/event-stream/i.test(type) && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type),
  });
  return (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/agent/") || path.endsWith("/download") || path.endsWith("/recovery-kit")) {
      return next();
    }
    return gzip(c, next);
  };
}
