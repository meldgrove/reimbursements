import socket
import threading

import pytest

from portal.services.scanner import ClamAVScanner, ScanError, configured_scanner


class FakeClamAV:
    """Speaks the clamd zINSTREAM and zPING protocol with a scripted reply."""

    def __init__(self, reply):
        self.reply, self.received = reply, b""
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        connection, _ = self.server.accept()
        with connection:
            while not self.received.endswith(b"\0\0\0\0") and not self.received == b"zPING\0":
                part = connection.recv(65536)
                if not part:
                    return
                self.received += part
            connection.sendall(self.reply)

    def close(self):
        self.thread.join(timeout=5)
        self.server.close()


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "receipt.pdf"
    path.write_bytes(b"synthetic receipt")
    return path


def test_clean_stream_passes_and_sends_file_bytes(source):
    clamd = FakeClamAV(b"stream: OK\0")
    ClamAVScanner("127.0.0.1", clamd.port).scan(source)
    clamd.close()
    assert clamd.received.startswith(b"zINSTREAM\0")
    assert b"synthetic receipt" in clamd.received


def test_detection_is_a_terminal_failure(source):
    clamd = FakeClamAV(b"stream: Eicar-Test-Signature FOUND\0")
    with pytest.raises(ScanError) as failure:
        ClamAVScanner("127.0.0.1", clamd.port).scan(source)
    clamd.close()
    assert (failure.value.code, failure.value.retryable) == ("malware_detected", False)


@pytest.mark.parametrize("reply", [b"stream: ERROR\0", b""])
def test_unexpected_reply_is_never_a_clean_scan(source, reply):
    clamd = FakeClamAV(reply)
    with pytest.raises(ScanError) as failure:
        ClamAVScanner("127.0.0.1", clamd.port).scan(source)
    clamd.close()
    assert (failure.value.code, failure.value.retryable) == ("scanner_unavailable", True)


def test_ping_reports_readiness():
    clamd = FakeClamAV(b"PONG\0")
    assert ClamAVScanner("127.0.0.1", clamd.port).ready()
    clamd.close()
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
    assert not ClamAVScanner("127.0.0.1", port).ready()


def test_disabled_scanner_needs_development_mode(settings, source):
    settings.UPLOAD_SCANNER, settings.DEBUG = "disabled", False
    with pytest.raises(ScanError, match="scanner_configuration"):
        configured_scanner().scan(source)
    assert not configured_scanner().ready()
