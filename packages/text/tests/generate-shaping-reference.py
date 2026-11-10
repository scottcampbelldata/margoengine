"""Freeze public HarfBuzz shaped glyph runs and FontTools drawn bounds, without reading library source."""
import hashlib
import json
from pathlib import Path
import runpy
import uharfbuzz as hb
from fontTools.ttLib import TTFont

Samples=runpy.run_path(str(Path(__file__).with_name('generate-variable-reference.py')))['Samples']
root=Path(__file__).resolve().parent/'fixtures'/'fonts'
result={'method':'HarfBuzz public hb_shape through uharfbuzz; FontTools public glyph drawing at 12 Bezier samples', 'cases':[]}
for name,text,axes in [('SourceSans3VF-Upright.otf','office AV',{'wght':650}),('Amiri-Regular.ttf','سلامّ',{})]:
    path=root/name
    data=path.read_bytes()
    face=hb.Face(data)
    font=hb.Font(face)
    font.scale=(face.upem,face.upem)
    font.set_variations(axes)
    buf=hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font,buf)
    tt=TTFont(path)
    glyphs=tt.getGlyphSet(location=axes)
    order=tt.getGlyphOrder()
    run=[]
    bounds=[]
    x=y=0
    for info,pos in zip(buf.glyph_infos,buf.glyph_positions):
        run.append({'glyphIndex':info.codepoint,'cluster':len(text[:info.cluster].encode('utf-16-le'))//2,
                    'xAdvance':pos.x_advance/face.upem,'yAdvance':pos.y_advance/face.upem,
                    'xOffset':pos.x_offset/face.upem,'yOffset':pos.y_offset/face.upem})
        pen=Samples(glyphs,face.upem)
        glyphs[order[info.codepoint]].draw(pen)
        if pen.points:
            b=pen.bounds()
            bounds.append([b[0]+(x+pos.x_offset)/face.upem,b[1]+(y+pos.y_offset)/face.upem,
                           b[2]+(x+pos.x_offset)/face.upem,b[3]+(y+pos.y_offset)/face.upem])
        x+=pos.x_advance
        y+=pos.y_advance
    result['cases'].append({'font':name,'sha256':hashlib.sha256(data).hexdigest(),'text':text,'variations':axes,
        'shapedRuns':[{'glyphs':run}], 'bounds':[min(b[0] for b in bounds),min(b[1] for b in bounds),max(b[2] for b in bounds),max(b[3] for b in bounds)]})
(root/'shaping-reference.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
