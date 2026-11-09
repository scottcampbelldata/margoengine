"""Own independent outline oracle using Windows GDI, not the extrusion font decoder.

Regenerate on Windows: python packages/text/tests/generate-outline-reference.py
Public contract: Microsoft GetGlyphOutlineW, TTPOLYGONHEADER and TTPOLYCURVE docs.
Only fonts are loaded; no font-library or other engine source is used.
"""
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parent / 'fixtures' / 'fonts'
gdi = c.WinDLL('gdi32', use_last_error=True)
gdi.CreateCompatibleDC.argtypes = [w.HDC]
gdi.CreateCompatibleDC.restype = w.HDC
gdi.SelectObject.argtypes = [w.HDC, w.HGDIOBJ]
gdi.SelectObject.restype = w.HGDIOBJ
gdi.DeleteObject.argtypes = [w.HGDIOBJ]
gdi.DeleteDC.argtypes = [w.HDC]
gdi.AddFontResourceExW.argtypes = [w.LPCWSTR, w.DWORD, c.c_void_p]
gdi.RemoveFontResourceExW.argtypes = [w.LPCWSTR, w.DWORD, c.c_void_p]
gdi.CreateFontW.argtypes = [c.c_int] * 5 + [w.DWORD] * 8 + [w.LPCWSTR]
gdi.CreateFontW.restype = w.HFONT
gdi.GetGlyphIndicesW.argtypes = [w.HDC, w.LPCWSTR, c.c_int, c.POINTER(w.WORD), w.DWORD]
gdi.GetGlyphOutlineW.argtypes = [w.HDC, w.UINT, w.UINT, c.c_void_p, w.DWORD, c.c_void_p, c.c_void_p]
gdi.GetGlyphOutlineW.restype = w.DWORD
gdi.GetFontData.argtypes = [w.HDC, w.DWORD, w.DWORD, c.c_void_p, w.DWORD]
gdi.GetFontData.restype = w.DWORD

def point(data, offset):
    # FIXED is WORD fractional then SHORT signed integer, little endian.
    xf, xi, yf, yi = struct.unpack_from('<HhHh', data, offset)
    return [xi + xf / 65536, yi + yf / 65536]

result = {'method': 'GetGlyphOutlineW GGO_BEZIER|GGO_GLYPH_INDEX|GGO_UNHINTED at 1000 ppem; absolute cubic controls', 'fonts': {}}
for extension in ['ttf', 'otf']:
    path = ROOT / f'SourceSans3-Regular.{extension}'
    assert gdi.AddFontResourceExW(str(path), 0x10, None)
    dc = gdi.CreateCompatibleDC(None)
    font = gdi.CreateFontW(-1000, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, 'Source Sans 3')
    assert font
    old = gdi.SelectObject(dc, font)
    try:
        # Verify the selected face's head table, so a system font fallback cannot become our oracle.
        data = path.read_bytes()
        tables = {}
        for i in range(struct.unpack_from('>H', data, 4)[0]):
            tag, _, offset, length = struct.unpack_from('>4sIII', data, 12 + i * 16)
            tables[tag] = data[offset:offset + length]
        head = c.create_string_buffer(len(tables[b'head']))
        assert gdi.GetFontData(dc, int.from_bytes(b'head', 'little'), 0, head, len(head)) == len(head)
        assert head.raw == tables[b'head'], 'GDI selected a different font'
        glyphs = {}
        for char in 'ABOSge\u00e9\u00c5\u0398\u00f8':
            index = w.WORD()
            assert gdi.GetGlyphIndicesW(dc, char, 1, c.byref(index), 1) != 0xffffffff
            assert index.value != 0xffff
            metrics = c.create_string_buffer(20)
            matrix = c.create_string_buffer(struct.pack('<HhHhHhHh', 0, 1, 0, 0, 0, 0, 0, 1))
            flags = 3 | 0x80 | 0x100
            size = gdi.GetGlyphOutlineW(dc, index.value, flags, metrics, 0, None, matrix)
            assert size != 0xffffffff
            buffer = c.create_string_buffer(size)
            assert gdi.GetGlyphOutlineW(dc, index.value, flags, metrics, size, buffer, matrix) == size
            raw, offset, contours = buffer.raw, 0, []
            while offset < size:
                length, kind = struct.unpack_from('<II', raw, offset)
                assert kind == 24
                current = point(raw, offset + 8)
                segments, at, end = [], offset + 16, offset + length
                while at < end:
                    kind, count = struct.unpack_from('<HH', raw, at)
                    points = [point(raw, at + 4 + i * 8) for i in range(count)]
                    if kind == 1:
                        for p in points:
                            segments.append([current, p]); current = p
                    else:
                        assert kind == 3 and count % 3 == 0
                        for i in range(0, count, 3):
                            segments.append([current, *points[i:i + 3]]); current = points[i + 2]
                    at += 4 + count * 8
                contours.append(segments); offset = end
            glyphs[char] = {'index': index.value, 'contours': contours}
        result['fonts'][extension] = {'sha256': hashlib.sha256(data).hexdigest(), 'glyphs': glyphs}
    finally:
        gdi.SelectObject(dc, old); gdi.DeleteObject(font); gdi.DeleteDC(dc)
        assert gdi.RemoveFontResourceExW(str(path), 0x10, None)
(ROOT / 'outline-reference.json').write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
