"""Malware scanning of uploaded source files.

Two adapters sit behind `configured_scanner()`: ClamAV in deployments and a no-op
scanner for local development. A scanner outage never counts as a clean scan.
"""

import socket
import struct

from django.conf import settings


class ScanError(Exception):
    """`code` is participant-facing; `retryable` failures leave the upload pending."""

    def __init__(self, code, *, retryable=False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


class ClamAVScanner:
    def __init__(self, host, port):
        self.address = (host, port)

    def scan(self, path):
        try:
            with socket.create_connection(self.address, timeout=30) as connection:
                connection.sendall(b"zINSTREAM\0")
                with open(path, "rb") as source:
                    while chunk := source.read(64 * 1024):
                        connection.sendall(struct.pack("!I", len(chunk)) + chunk)
                connection.sendall(struct.pack("!I", 0))
                response = b""
                while b"\0" not in response and len(response) < 4096:
                    part = connection.recv(4096)
                    if not part:
                        break
                    response += part
        except OSError as exc:
            raise ScanError("scanner_unavailable", retryable=True) from exc
        if response.strip(b"\0\r\n") == b"stream: OK":
            return
        if b" FOUND" in response:
            raise ScanError("malware_detected")
        raise ScanError("scanner_unavailable", retryable=True)

    def ready(self):
        try:
            with socket.create_connection(self.address, timeout=2) as connection:
                connection.sendall(b"zPING\0")
                return connection.recv(32).strip(b"\0\r\n") == b"PONG"
        except OSError:
            return False


class DisabledScanner:
    """Local development only."""

    def scan(self, path):
        return

    def ready(self):
        return True


class MisconfiguredScanner:
    def scan(self, path):
        raise ScanError("scanner_configuration")

    def ready(self):
        return False


def configured_scanner():
    if settings.UPLOAD_SCANNER == "clamav":
        return ClamAVScanner(settings.CLAMAV_HOST, settings.CLAMAV_PORT)
    if settings.UPLOAD_SCANNER == "disabled" and settings.DEBUG:
        return DisabledScanner()
    return MisconfiguredScanner()


def scan_file(path):
    configured_scanner().scan(path)


def scanner_ready():
    return configured_scanner().ready()
