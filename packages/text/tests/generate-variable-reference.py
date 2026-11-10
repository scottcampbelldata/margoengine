"""Independent data oracle via FontTools public drawing API; never read its source.
Run with fonttools installed: python packages/text/tests/generate-variable-reference.py
"""
import hashlib
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

root = Path(__file__).resolve().parent/'fixtures'/'fonts'
result = {'method':'FontTools public TTFont.getGlyphSet(location), BasePen with 12 uniform samples per Bezier; unhinted em bounds', 'fonts':{}}
for extension in ['ttf','otf']:
    path = root / f'SourceSans3VF-Upright.{extension}'
    font = TTFont(path)
    upem = font['head'].unitsPerEm
    samples=[]
    for weight in [200,350,400,650,900]:
        glyphs=font.getGlyphSet(location={'wght':weight})
        for char in 'AVOéij':
            name=font.getBestCmap()[ord(char)]
            pen=Samples(glyphs,upem)
            glyphs[name].draw(pen)
            samples.append({'char':char,'weight':weight,'index':font.getGlyphID(name),'advance':glyphs[name].width/upem,'bounds':pen.bounds()})
    result['fonts'][extension]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'variationStoreOffset':font['CFF2'].cff.topDictIndex[0].rawDict.get('VarStore') if 'CFF2' in font else None,
        'axes':[{'tag':a.axisTag,'min':a.minValue,'default':a.defaultValue,'max':a.maxValue} for a in font['fvar'].axes], 'samples':samples}
(root/'variable-reference.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
