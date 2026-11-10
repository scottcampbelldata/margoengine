"""Original analytic AV1 tool fixtures, encoded by opaque development executables.

Python generate-tools.py --ffmpeg /path/to/ffmpeg --output /own/temporary/folder
The super-resolution derivative additionally requires PyAV with SVT-AV1. Files
are test data only. No encoder implementation or executable ships in Margo.
"""
import argparse
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--ffmpeg", required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

def encode(name, width, height, pattern, params, usage="good", cpu="4", crf="24", fmt="yuv444p", extra=()):
    # Original analytic raster, dedicated to CC0-1.0. All three full-resolution
    # planes have the same byte pattern, making the bitstream independently reproducible.
    data = bytes((32, 96, 160, 224)[((x // 16) + (y // 16) * 2) % 4] if pattern == "palette"
                 else ((x % 64) * 17 + (y % 64) * 37 + (x % 64) * (y % 64) * 7) % 220 + 16
                 for _ in range(3) for y in range(height) for x in range(width))
    source = args.output / (name + ".yuv")
    source.write_bytes(data)
    subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
                    "-pixel_format", "yuv444p", "-video_size", f"{width}x{height}", "-i", str(source),
                    "-frames:v", "1", "-c:v", "libaom-av1", "-usage", usage, "-cpu-used", cpu,
                    "-still-picture", "1", "-crf", crf, "-pix_fmt", fmt, "-aom-params", params,
                    *extra, str(args.output / ("tools-" + name + ".avif"))], check=True, timeout=90)

encode("palette", 128, 128, "palette", "tune-content=screen:enable-palette=1:enable-intrabc=0:lossless=1")
for name, usage, cpu in [("copy-allintra", "allintra", "0"), ("copy-good", "good", "0"), ("copy-realtime", "realtime", "6")]:
    encode(name, 1024, 128, "copy", "tune-content=screen:enable-palette=0:enable-intrabc=1:lossless=1", usage, cpu, "0")
encode("copy-lossy", 1024, 128, "copy", "tune-content=screen:enable-palette=0:enable-intrabc=1", "allintra", "0")
encode("copy-420", 1024, 128, "copy", "tune-content=screen:enable-palette=0:enable-intrabc=1:lossless=1", "allintra", "0", "0", "yuv420p")
encode("grain", 128, 128, "copy", "film-grain-test=1")
encode("tiles", 256, 256, "copy", "enable-qm=1:qm-min=5:qm-max=5", extra=("-tiles", "2x2"))

import av
source = pathlib.Path(__file__).resolve().parent / "fixtures/fox.profile0.8bpc.yuv420.avif"
with av.open(str(source)) as container:
    frame = next(container.decode(video=0)).reformat(256, 256, format="yuv420p")
with av.open(str(args.output / "tools-superres.avif"), "w") as output:
    stream = output.add_stream("libsvtav1", rate=1)
    stream.width = stream.height = 256
    stream.pix_fmt = "yuv420p"
    stream.gop_size = 1
    stream.options = {"preset": "8", "crf": "24", "svtav1-params": "superres-mode=1:superres-denom=12:superres-kf-denom=12"}
    for packet in stream.encode(frame): output.mux(packet)
    for packet in stream.encode(): output.mux(packet)
# This last file derives from the credited fox image and retains CC-BY-SA-4.0.
