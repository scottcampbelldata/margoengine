#!/bin/bash
# Renders a USDZ with Apple's usdrecord through one fixed camera, for comparing two versions of a file frame by frame.
# Usage: usdrecord_frames.sh <file.usdz> <camera x, y, z> <frames> <out folder>, for example: file.usdz "0, 0.8, 4" 20 out
set -eo pipefail
file=$1; eye=$2; frames=$3; out=$4
mkdir -p "$out"
cat > "$out/cam.usda" <<USDA
#usda 1.0
def Camera "Cam" {
    float focalLength = 35
    float2 clippingRange = (0.01, 1000)
    double3 xformOp:translate = ($eye)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
USDA
timeout 100 usdrecord --sessionLayer "$out/cam.usda" --camera Cam -f "$frames" -w 480 "$file" "$out/$(basename "$file" .usdz)-###.png"
