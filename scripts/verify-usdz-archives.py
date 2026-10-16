"""Independent stdlib check of the actual USDZ bytes produced by private A/B runs."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import zipfile
import zlib


def verify(path):
    data = Path(path).read_bytes()
    assert data[:4] == b"PK\x03\x04", "Missing ZIP local header"
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == ["scene.usda"], "Archive member changed"
        assert archive.testzip() is None, "Independent ZIP CRC verification failed"
        info = archive.getinfo("scene.usda")
        assert info.compress_type == zipfile.ZIP_STORED, "USDZ entry is compressed"
        content = archive.read(info)
        assert content.startswith(b"#usda 1.0\n"), "USD payload header changed"
        content.decode("utf-8")
        name_size, extra_size = struct.unpack_from("<HH", data, info.header_offset + 26)
        start = info.header_offset + 30 + name_size + extra_size
        assert start % 64 == 0, "USDZ entry is not 64-byte aligned"
        assert data[start:start + len(content)] == content, "Local payload differs"
        crc, compressed, uncompressed = struct.unpack_from("<III", data, info.header_offset + 14)
        assert crc == info.CRC == zlib.crc32(content), "Local/central/Python CRC differs"
        assert compressed == uncompressed == info.file_size == len(content), "ZIP lengths differ"
        return {"path": path, "archiveBytes": len(data), "contentBytes": len(content),
                "contentSHA256": hashlib.sha256(content).hexdigest(), "crc": crc, "alignedOffset": start}


if __name__ == "__main__":
    assert len(sys.argv) > 1, "Pass one or more actual USDZ archive paths"
    print(json.dumps([verify(path) for path in sys.argv[1:]]))
