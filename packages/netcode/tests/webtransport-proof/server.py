# A small HTTP/3 WebTransport echo server for proof.mjs, on aioquic (an outside tool, BSD-3-Clause, not shipped and not
# part of any package): it echoes stream bytes and datagrams, and on the datagram "bye" ends the session with a close
# capsule (draft-ietf-webtrans-http3, WT_CLOSE_SESSION 0x2843). Usage: python server.py <port> <folder for the key>
import asyncio
import base64
import datetime
import hashlib
import sys
from pathlib import Path

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, HeadersReceived, WebTransportStreamDataReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def certificate(folder: Path) -> tuple[Path, Path, str]:
    """A self-signed P-256 certificate of 10 days, as serverCertificateHashes requires, and its SHA-256."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(hours=1))
        .not_valid_after(now + datetime.timedelta(days=10))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem, private = folder / "proof.pem", folder / "proof.key"
    pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    der = cert.public_bytes(serialization.Encoding.DER)
    return pem, private, base64.b64encode(hashlib.sha256(der).digest()).decode()


class Http3(H3Connection):
    """Also announces the session settings of later drafts of WebTransport over HTTP/3, which Chromium asks for."""

    def _get_local_settings(self):
        settings = super()._get_local_settings()
        settings[0xC671706A] = 1  # SETTINGS_WEBTRANSPORT_MAX_SESSIONS, draft 07
        settings[0x14E9CD29] = 1  # SETTINGS_WT_MAX_SESSIONS, later drafts
        return settings


class Echo(QuicConnectionProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.h3 = None
        self.session = None

    def quic_event_received(self, event):
        if isinstance(event, ProtocolNegotiated):
            self.h3 = Http3(self._quic, enable_webtransport=True)
        if self.h3 is None:
            return
        for h3_event in self.h3.handle_event(event):
            self.h3_event(h3_event)
        self.transmit()

    def h3_event(self, event):
        if isinstance(event, HeadersReceived):
            self.session = event.stream_id
            self.h3.send_headers(event.stream_id, [(b":status", b"200"), (b"sec-webtransport-http3-draft", b"draft02")])
        elif isinstance(event, DatagramReceived):
            if event.data == b"bye":
                reason = b"proof done"
                body = (4007).to_bytes(4, "big") + reason
                capsule = b"\x68\x43" + bytes([len(body)]) + body
                self.h3.send_data(self.session, capsule, end_stream=True)
            else:
                self.h3.send_datagram(self.session, event.data)
        elif isinstance(event, WebTransportStreamDataReceived):
            if event.data:
                self._quic.send_stream_data(event.stream_id, event.data, end_stream=False)


async def main():
    port, folder = int(sys.argv[1]), Path(sys.argv[2])
    pem, key, digest = certificate(folder)
    configuration = QuicConfiguration(alpn_protocols=H3_ALPN, is_client=False, max_datagram_frame_size=65536)
    configuration.load_cert_chain(pem, key)
    await serve("127.0.0.1", port, configuration=configuration, create_protocol=Echo)
    print(f"ready {digest}", flush=True)
    await asyncio.Future()


asyncio.run(main())
