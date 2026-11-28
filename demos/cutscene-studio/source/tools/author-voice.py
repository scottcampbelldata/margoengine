"""Synthesize the two original keeper lines and save clean PCM and their exact subtitle boundaries."""
import json
from pathlib import Path
import sys

import numpy as np
import soundfile
from kokoro_onnx import Kokoro

assets,output=map(Path,sys.argv[1:])
model=Kokoro(str(assets/'kokoro-v1.0.int8.onnx'),str(assets/'voices-v1.0.bin'))
dialogue=("The fog is lifting.","Bring the light around.")
wave=[]
cues=[]
position=0
for line in dialogue:
    audio,rate=model.create(line,voice="am_michael",speed=.94,lang="en-us")
    active=np.flatnonzero(np.abs(audio)>.009)
    if not active.size:
        raise ValueError('The synthesized line is empty.')
    audio=audio[max(0,active[0]-int(.065*rate)):min(len(audio),active[-1]+int(.12*rate))]
    cues.append({"text":line,"start":position/rate,"end":(position+len(audio))/rate})
    position+=len(audio)+round(.21*rate)
    wave.extend((audio,np.zeros(round(.21*rate),dtype=np.float32)))
mixed=np.concatenate(wave)
peak=float(np.max(np.abs(mixed)))
soundfile.write(output,mixed*min(1.5,.82/peak),rate,subtype="PCM_16")
output.with_suffix(".json").write_text(json.dumps({"cues":cues,"duration":len(mixed)/rate},indent=2)+"\n")
