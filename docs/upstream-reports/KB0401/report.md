# WebKit: a MediaRecorder VP8 WebM plays back about 10 levels too bright

Draft for bugs.webkit.org, product WebKit, component Media (MediaRecorder / video playback). Not filed. Margo row: KB0401.

## Environment

- Playwright WebKit build 2370 (Version/27.2) on an Apple M6 (Margo's record, 2026-11-10). Chrome 157 on the same Mac is the control.

## Steps

1. Serve this folder over `http://localhost` and open `webm-colour.html` in WebKit (or
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB0401/webm-colour.html --browser=webkit`).
2. The page fills a 2D canvas with #336699 (51, 102, 153), records `captureStream(30)` for 1.5 s as `video/webm;codecs=vp8` (and `video/mp4`),
   plays each recording in a `<video>`, seeks to 0.5 s and reads the centre pixel through a canvas.

## Expected

(51, 102, 153) within a few levels, as MP4 gives.

## Actual (Margo's measurement)

WebM draws (61, 113, 164); MP4 draws (50, 101, 151). ffmpeg reads the same WebM as Y 95, Cb 159, Cr 100, the BT.601 limited-range code of #336699, and
draws (47, 103, 155). WebCodecs `VideoDecoder` in WebKit 27.2 gives NV12 Y 95, Cb 159, Cr 100 for the first key frame, labelled `bt709` limited; Chrome 156
gives I420 Y 97, Cb 156, Cr 104 (BT.709 limited) for the same recording and draws (51, 101, 153). So the encoded values are the BT.601 limited-range codes but the
frame is labelled BT.709 and the played colour is neither a BT.709 nor a full-range BT.601 reading (which would be about (56, 104, 150)); how WebKit arrives at
(61, 113, 164) is not known. The WebM carries no colour range or matrix.

## Result on this PC (2026-11-11)

Not run on WebKit: Playwright WebKit for Windows has no `MediaRecorder` (the page reports it and sets `reproduces: "not run"`). On Edge 157 the page
gives (51, 102, 153) for WebM and (51, 102, 152) for MP4, so the page is sound. The WebKit numbers are from Margo's record and need a Mac run to
re-confirm before filing. Margo does not work around it; `packages/video/test/record-check.mjs` accepts exactly this colour in WebKit and prints
`KNOWN BROWSER DEFECT webkit-vp8-webm-playback-colour`.

## Files

`webm-colour.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
