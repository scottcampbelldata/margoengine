"""Return small source albedo tiles for offline palette fitting."""
import base64
from io import BytesIO
import json
from pathlib import Path
import struct
import sys

from PIL import Image

raw=Path(sys.argv[1]).read_bytes()
size=struct.unpack_from("<I",raw,12)[0]
document=json.loads(raw[20:20+size])
binary=raw[28+size:]
images=[]
for image in document["images"]:
    view=document["bufferViews"][image["bufferView"]]
    at=view.get("byteOffset",0)
    source=Image.open(BytesIO(binary[at:at+view["byteLength"]])).convert("RGBA")
    source.thumbnail((128,128),Image.Resampling.LANCZOS)
    images.append([source.width,source.height,base64.b64encode(source.tobytes()).decode("ascii")])
print(json.dumps(images))
