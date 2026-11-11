"""Build the interface stylesheet with the pinned standalone Tailwind CLI (no Node).

    python scripts/tailwind.py build   # minified, as in the Docker image
    python scripts/tailwind.py watch   # rebuilds while you edit templates

The binary is downloaded once into var/tailwind/ and checked against its SHA-256.
"""

import hashlib
import os
import platform
import stat
import sys
import urllib.request
from pathlib import Path

VERSION = "v4.3.3"
CHECKSUMS = {
    "linux-x64": "dc61b3ac6b8c9ca874c0cc4c57b2409791a64c5540404ca5f5367360babc313a",
    "linux-arm64": "55fd0b241214eff3de1e8ee4f22796662f2d2e7a49bcfca7477cfd0bac398195",
    "macos-x64": "7922e0953f2110c05976e3bf58f14e643d90427575e766b7d433f5f80cbee7e1",
    "macos-arm64": "cdf646702987a743464dff4d9c60fd4480d1c1e73dd819a9a67f1078815dce9d",
}
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "portal/assets/ui.css"
OUTPUT = ROOT / "portal/static/portal/ui.css"


def target():
    system = {"Linux": "linux", "Darwin": "macos"}.get(platform.system())
    machine = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
        platform.machine().lower()
    )
    if not system or not machine:
        sys.exit(f"No pinned Tailwind binary for {platform.system()} {platform.machine()}.")
    return f"{system}-{machine}"


def binary():
    name = target()
    path = ROOT / "var/tailwind" / f"tailwindcss-{VERSION}-{name}"
    if path.exists():
        return path
    url = (
        "https://github.com/tailwindlabs/tailwindcss/releases/download/"
        f"{VERSION}/tailwindcss-{name}"
    )
    print(f"Downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as response:
        content = response.read()
    if hashlib.sha256(content).hexdigest() != CHECKSUMS[name]:
        sys.exit("The downloaded Tailwind binary does not match the pinned checksum.")
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".partial")
    partial.write_bytes(content)
    partial.chmod(partial.stat().st_mode | stat.S_IXUSR)
    partial.rename(path)
    return path


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    if mode not in {"build", "watch"}:
        sys.exit(__doc__)
    command = [str(binary()), "--input", str(SOURCE), "--output", str(OUTPUT)]
    command.append("--minify" if mode == "build" else "--watch")
    os.chdir(ROOT)
    os.execv(command[0], command)


if __name__ == "__main__":
    main()
