import { writeSync } from "node:fs";

/**
 * Writes every byte of `data` to `fd`. writeSync may write fewer bytes than
 * asked (a full disk, a signal); a short write must not pass for the whole
 * file once it is renamed into place.
 */
export function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written <= 0) throw new Error("short write");
    offset += written;
  }
}
