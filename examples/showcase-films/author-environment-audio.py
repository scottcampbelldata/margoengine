"""Mix sound to the four environment films; third-party recordings are CC0."""

import argparse
import wave
from pathlib import Path
from runpy import run_path

import numpy as np

helpers = run_path(str(Path(__file__).with_name("author-showcase-12-15-audio.py")))
RATE, LENGTH = (helpers[name] for name in ("RATE", "LENGTH"))
recording, music, click, place = (helpers[name] for name in ("recording", "music", "click", "place"))


def layer(track, file, offset, at, end, gain, filters, fade=(.35, .7)):
    duration = end - at
    cue = recording(file, filters, start=offset, duration=duration)
    length = round(duration * RATE)
    if len(cue) < length:
        raise ValueError(f"{file.name} is too short for {at:.2f}–{end:.2f}s")
    seconds = np.arange(length) / RATE
    shape = np.minimum(1, seconds / fade[0]) * np.minimum(1, (duration - seconds) / fade[1])
    start = round(at * RATE)
    track[start:start + length] += cue[:length] * (gain * shape)[:, None]


def solar(track, rng, assets):
    layer(track, assets / "ridge-air.mp3", 7.0, 0, 90, .58,
          "highpass=f=132,lowpass=f=8000", fade=(.4, 3.3))
    # Solar rotation is compressed into the film. Bring the drive forward only in the close and locked tracker views.
    for begin, end, offset, level in [(6.8, 16.1, 5.0, .27), (20.0, 30.6, 20, .38), (31.1, 41.8, 43, .20)]:
        layer(track, assets / "chain-motor.mp3", offset, begin, end, level,
              "highpass=f=165,lowpass=f=2800", fade=(.68, 1.02))


def workshop(track, rng, assets):
    layer(track, assets / "workshop-day.mp3", 0, 0, 90, .82,
          "highpass=f=115,lowpass=f=6600", fade=(.37, 3.3))
    # Daylight and the open side of the workshop are visible at the two wider views.
    for offset, begin, end, gain in [(0.8, 5.7, 18.2, .19), (14.0, 63.6, 85.6, .22)]:
        layer(track, assets / "workshop-window.mp3", offset, begin, end, gain,
              "highpass=f=425,lowpass=f=5700", fade=(2.2, 3.5))


def chicago(track, rng, assets):
    layer(track, assets / "city-square.mp3", 1.15, 0, 32.3, .19,
          "highpass=f=220,lowpass=f=1800", fade=(.45, 3.6))
    layer(track, assets / "city-square.mp3", 34.0, 29.3, 69.2, .42,
          "highpass=f=125,lowpass=f=6600", fade=(3.5, 3.7))
    layer(track, assets / "city-square.mp3", 74.2, 65.7, 90, .24,
          "highpass=f=155,lowpass=f=4350", fade=(3.6, 4.8))
    music(track, assets / "make-funk.mp3", 12.0, .20, 90, .5, 4.0,
          [(.2, -8), (16, -8), (35, -13), (56, -12), (66, -10), (85, -6), (90, -9)])


def observatory(track, rng, assets):
    layer(track, assets / "observatory-night.mp3", 8.0, 0, 90, .44,
          "highpass=f=110,lowpass=f=5700", fade=(.25, 2.1))
    # Start and stop points come from the shutter, independent dome azimuth, and mount tracks.
    mechanisms = [
        (.20, 4.65, 0.3, .34, "clockwork-drive.mp3"),
        (5.30, 31.70, 5.4, .20, "clockwork-drive.mp3"),
        (9.20, 32.40, 23.0, .09, "chain-motor.mp3"),
        (35.15, 46.50, 34.8, .27, "clockwork-drive.mp3"),
    ]
    for begin, end, offset, gain, asset in mechanisms:
        layer(track, assets / asset, offset, begin, end, gain,
              "highpass=f=114,lowpass=f=3400", fade=(.27, .49))
    for event, pitch, level in [(.20, 352, .027), (32.4, 294, .039), (35.15, 430, .032), (46.50, 618, .063)]:
        place(track, click(rng, pitch, level), event, -.08)


if __name__ == "__main__":
    profiles = {
        "the-solar-field": solar, "the-scanned-workshop": workshop,
        "city-to-street": chicago, "the-observatory-dome": observatory,
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("film", choices=profiles)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    mix = np.zeros((LENGTH, 2), dtype=np.float32)
    profiles[args.film](mix, np.random.default_rng(8103), Path("test-results/showcase-12-15-inputs"))
    if not np.isfinite(mix).all() or np.max(np.abs(mix)) >= .98:
        raise ValueError("Environment mix exceeds its peak range")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as out:
        out.setparams((2, 2, RATE, LENGTH, "NONE", "not compressed"))
        out.writeframes((mix * 32767).astype("<i2").tobytes())
    print(args.film, "90 seconds stereo")
