"""Independent data oracle via FontTools public drawing API; never read its source.
Run with fonttools installed: python packages/text/tests/generate-variable-reference.py
"""
import hashlib
import math
import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

class Samples(BasePen):
    def __init__(self, glyphs, upem):
        super().__init__(glyphs)
        self.upem = upem
        self.points = []
        self.current = (0, 0)
    def _moveTo(self, p):
        self.current = p
        self.points.append(p)
    def _lineTo(self, p):
        self.current = p
        self.points.append(p)
    def _curveToOne(self, a, b, c):
        p = self.current
        for i in range(1, 13):
            t = i / 12
            u = 1 - t
            self.points.append(tuple(u**3*p[k] + 3*u*u*t*a[k] + 3*u*t*t*b[k] + t**3*c[k] for k in range(2)))
        self.current = c
    def _qCurveToOne(self, a, b):
        p = self.current
        for i in range(1, 13):
            t = i / 12
            u = 1 - t
            self.points.append(tuple(u*u*p[k] + 2*u*t*a[k] + t*t*b[k] for k in range(2)))
        self.current = b
    def _closePath(self):
        pass
    def _endPath(self):
        pass
    def bounds(self):
        return [min(p[0] for p in self.points)/self.upem, min(p[1] for p in self.points)/self.upem,
                max(p[0] for p in self.points)/self.upem, max(p[1] for p in self.points)/self.upem]

def spec_normalized(font, tag, user):
    """OpenType "Coordinate scales and normalization", written here from the spec text: 16.16 default
    normalization, the avar segment map in 16.16, then the final F2Dot14 step (v + 2) >> 2."""
    axis = next(a for a in font['fvar'].axes if a.axisTag == tag)
    fixed = lambda x: int(round(x * 65536))
    def muldiv(a, b, c):
        q = a * b / c
        return int(math.copysign(math.floor(abs(q) + 0.5), q))
    lo, de, hi = fixed(axis.minValue), fixed(axis.defaultValue), fixed(axis.maxValue)
    v = max(lo, min(hi, fixed(user)))
    v = 0 if v == de else -muldiv(de - v, 65536, de - lo) if v < de else muldiv(v - de, 65536, hi - de)
    if 'avar' in font:
        pairs = sorted((int(round(a * 16384)) * 4, int(round(b * 16384)) * 4) for a, b in font['avar'].segments[tag].items())
        for (f0, t0), (f1, t1) in zip(pairs, pairs[1:]):
            if f0 <= v <= f1:
                v = t0 + muldiv(v - f0, t1 - t0, f1 - f0)
                break
    return ((v + 2) >> 2) / 16384

root = Path(__file__).resolve().parent/'fixtures'/'fonts'
result = {'method':'FontTools public TTFont.getGlyphSet(normalized location from spec_normalized, normalized=True), BasePen with 12 uniform samples per Bezier; unhinted em bounds', 'fonts':{}}
for extension in ['ttf','otf']:
    path = root / f'SourceSans3VF-Upright.{extension}'
    font = TTFont(path)
    upem = font['head'].unitsPerEm
    samples=[]
    for weight in [200,350,400,650,900]:
        normalized=spec_normalized(font,'wght',weight)
        glyphs=font.getGlyphSet(location={'wght':normalized},normalized=True)
        floating=font.getGlyphSet(location={'wght':weight})
        for char in 'AVOéij':
            name=font.getBestCmap()[ord(char)]
            pen=Samples(glyphs,upem)
            glyphs[name].draw(pen)
            samples.append({'char':char,'weight':weight,'normalized':normalized,'index':font.getGlyphID(name),'advance':glyphs[name].width/upem,
                'floatingAdvance':floating[name].width/upem,'bounds':pen.bounds()})
    result['fonts'][extension]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'variationStoreOffset':font['CFF2'].cff.topDictIndex[0].rawDict.get('VarStore') if 'CFF2' in font else None,
        'axes':[{'tag':a.axisTag,'min':a.minValue,'default':a.defaultValue,'max':a.maxValue} for a in font['fvar'].axes], 'samples':samples}
(root/'variable-reference.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
