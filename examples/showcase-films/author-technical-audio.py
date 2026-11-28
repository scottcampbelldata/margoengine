"""Original stereo audio for the two technical films. Outputs 90 seconds at 48 kHz."""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 48000
LENGTH = 90 * RATE
TAU = 2 * np.pi


def smooth_noise(generator, rate, duration):
    count = int(rate * duration) + 2
    samples = np.arange(int(duration * RATE)) * rate / RATE
    return np.interp(samples, np.arange(count), generator.standard_normal(count))


def place(track, signal, time, pan=0):
    start = round(time * RATE)
    chunk = signal[:max(0, len(track) - start)]
    stop = start + len(chunk)
    track[start:stop, 0] += (0.5 * (1 - pan))**0.5 * chunk
    track[start:stop, 1] += (0.5 * (1 + pan))**0.5 * chunk


def hall(track, _generator):
    # A real piano performance, progressively heard at the stage, in the hall, then from the rear.
    path = Path("test-results/showcase-12-15-inputs/goldberg-aria.mp3")
    process = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ss", "4.4", "-t", "90",
         "-af", "highpass=f=52", "-ar", str(RATE), "-ac", "2", "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=25,
    )
    piano = np.frombuffer(process.stdout, dtype="<f4").reshape(-1, 2)
    if len(piano) != LENGTH:
        raise ValueError("Bach recording does not cover the hall timeline")
    t = np.arange(LENGTH) / RATE
    distance = np.interp(t, [0, 14, 27, 47, 65, 74, 90], [.49, .42, .27, .38, .16, .25, .41])
    track[:] = piano * distance[:, None]
    for delay, side, strength in [(.058,-.55,.13),(.102,.6,.12),(.177,-.33,.10),(.27,.41,.087),(.42,-.47,.063)]:
        start = round(delay * RATE)
        place(track, piano[:-start].mean(axis=1) * strength * (1.22 - distance[start:]), delay, side)


def bearing_envelope(t, start, end):
    return np.clip((t-start)/1.5,0,1) * np.clip((end-t)/1.8,0,1)


def turbofan(track, generator):
    t = np.arange(len(track)) / RATE
    low = smooth_noise(generator, 95, 90)
    mids = smooth_noise(generator, 425, 90)
    air = smooth_noise(generator, 2000, 90)
    bed = .0042 * low + .0045 * mids + .0031 * air
    motion = .15 * np.sin(TAU * .037 * t) + .10 * np.sin(TAU * .019 * t + 1.3)
    place(track, bed*(.79+motion),0)
    phase = TAU * (45 * t + 2.2 * np.sin(t * .52))
    air_paths = bearing_envelope(t, 15, 30) + .59 * bearing_envelope(t, 39, 54)
    near_motor = .007*np.sin(phase) + .009*np.sin(phase*2.014+ .38) + .0053*np.sin(phase*4.02)
    place(track, near_motor * (.1 + air_paths),0,.08)
    for start, end, center, pan in [(6.4,13.6,83,.14),(56.7,64.1,72,-.32),(76.9,83.2,89,.26)]:
        envelope=bearing_envelope(t,start,end)
        growl=.012*mids + .026*np.sin(TAU*center*t+.27*np.sin(t*29))
        place(track,growl * envelope,0,pan)
    for at, pan in [(6.4,-.24),(13.6,.18),(56.7,-.2),(64.1,.22),(76.9,.17),(83.2,-.2)]:
        impulse = np.arange(int(.58*RATE)) / RATE
        body = (.065*np.sin(TAU*183*impulse) + .039*np.sin(TAU*273*impulse))*np.exp(-impulse*23)
        tick = .05 * smooth_noise(generator, 18000, .58) * np.exp(-impulse*89)
        onset = np.clip(impulse*1200,0,1)
        place(track, (body+tick)*onset, at, pan)
        place(track, (body+tick)*onset*.14, at+.098, -pan)


def main():
    kind, path = sys.argv[1:]
    audio = np.zeros((LENGTH, 2), dtype=np.float64)
    {'inside-turbofan': turbofan, 'inside-concert-hall': hall}[kind](
        audio, np.random.default_rng(5113 if kind == 'inside-turbofan' else 8471),
    )
    audio[:RATE // 20] *= np.linspace(0, 1, RATE // 20)[:, None]
    audio[-RATE * 2:] *= np.linspace(1, 0, RATE * 2)[:, None]
    if np.max(np.abs(audio)) > 0.98:
        raise ValueError('The authored mix exceeds its peak budget.')
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), 'wb') as stream:
        stream.setparams((2, 2, RATE, LENGTH, 'NONE', 'not compressed'))
        stream.writeframes((audio * 32767).astype('<i2').tobytes())
    print(f'{kind} | {LENGTH} stereo samples | maximum {np.max(np.abs(audio)):.3f}')


if __name__ == '__main__':
    main()
