"""Edit each licensed score and location sound to its native showcase film."""

import argparse
import json
import subprocess
import wave
from pathlib import Path
from runpy import run_path

import numpy as np

audio = run_path(str(Path(__file__).with_name("author-technical-audio.py")))
LENGTH, RATE, TAU = (audio[name] for name in ("LENGTH", "RATE", "TAU"))
place, smooth_noise = (audio[name] for name in ("place", "smooth_noise"))


def recording(path, filters="anull", start=0, duration=None):
    args = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-ss", str(start), "-i", str(path)]
    if duration is not None:
        args += ["-t", str(duration)]
    raw = subprocess.run(
        [*args, "-af", filters, "-ar", str(RATE), "-ac", "2", "-f", "f32le", "-"],
        capture_output=True, check=True, timeout=30,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape((-1, 2))


def envelope(time, start, stop, fade):
    return np.clip((time - start) / fade, 0, 1) * np.clip((stop - time) / fade, 0, 1)


def music(track, path, offset, at, stop, fade_in, fade_out, levels):
    duration = stop - at
    excerpt = recording(path, "highpass=f=42", start=offset, duration=duration)
    count = round(duration * RATE)
    if len(excerpt) < count:
        raise ValueError(f"{path.name} does not cover its timeline cue")
    seconds = np.arange(count) / RATE
    level = np.interp(seconds + at, *np.array(levels).T)
    fade = np.minimum(1, seconds / fade_in) * np.minimum(1, (duration - seconds) / fade_out)
    gain = fade * 10 ** (level / 20)
    start = round(at * RATE)
    track[start:start + count] += excerpt[:count] * gain[:, None]


def click(rng, timbre, strength):
    time = np.arange(RATE // 4) / RATE
    tone = np.sin(TAU * timbre * time) + .29 * np.sin(TAU * timbre * 2.67 * time)
    attack = smooth_noise(rng, 8200, .25) * np.exp(-time * 97)
    return (tone * np.exp(-time * 32) * .57 + attack * .24) * strength * np.minimum(1, time * 1100)


def meteorite(track, rng, assets):
    time = np.arange(LENGTH) / RATE
    air = .004 * smooth_noise(rng, 310, 90) + .002 * smooth_noise(rng, 980, 90)
    place(track, air * (.75 + .17 * np.sin(time * .15)), 0, -.25)
    for cue, pitch in [(18.21, 344), (31.6, 608), (46.7, 480), (61.6, 532)]:
        place(track, click(rng, pitch, .065), cue, .13)
    # The cue moves through both CT thresholds and releases as the exhibit returns.
    music(track, assets / "interstellar-space.mp3", 8.8, 0, 90, .68, 5.2,
          [(0, -7), (15.7, -8.5), (18.2, -6), (31.6, -6.8), (46.7, -4.8),
           (61.6, -5.6), (76.5, -7.2), (84, -5.5), (90, -8)])


def clip_hoof_impacts(take):
    mono = take.mean(axis=1)
    hop = RATE // 100
    windows = mono[: len(mono) // hop * hop].reshape((-1, hop))
    rms = np.sqrt(np.mean(windows * windows, axis=1))
    rise = np.maximum(0, rms[3:] - .85 * rms[:-3])
    chosen = []
    for index in np.argsort(-rise):
        start = (index + 1) * hop
        if start < hop or start + int(.17 * RATE) > len(mono):
            continue
        if any(abs(start - other) < RATE * .23 for other in chosen):
            continue
        chosen.append(start)
        if len(chosen) == 38:
            break
    return [
        mono[start:start + int(.17 * RATE)] * np.exp(-np.arange(int(.17 * RATE)) / RATE * 17)
        for start in chosen
    ]


def ridge(track, rng, assets):
    time = np.arange(LENGTH) / RATE
    air = recording(assets / "ridge-breeze.mp3", "highpass=f=180,lowpass=f=6800", start=30, duration=90)
    if len(air) != LENGTH:
        raise ValueError("The ridge field recording must cover the film")
    perspective = np.interp(time, [0, 5, 17, 27, 48, 60, 74, 90], [.24, .20, .35, .31, .18, .34, .21, .29])
    track[:] += air * perspective[:, None]
    take = recording(assets / "hooves.mp3", "highpass=f=94,lowpass=f=4100")
    impacts = clip_hoof_impacts(take)
    schedule = json.loads((assets / "hoofbeats.json").read_text())
    for onset, hoof, speed in schedule:
        sample = impacts[rng.integers(len(impacts))]
        peak = max(.002, np.max(np.abs(sample)))
        distance = .30 if 16.4 < onset < 25.7 or 60 < onset < 72.1 else .87
        strength = distance * rng.uniform(.051, .088) * np.clip(speed / 1.5, .45, 1.45)
        tick = sample / peak * strength
        place(track, tick, onset, -.13 if hoof < 2 else .13)
    # A wind-and-hooves hook and a quiet pause divide two different phrases of the acoustic track.
    music(track, assets / "wandering.mp3", 14.0, 4.9, 24.3, 2.2, 3.6,
          [(4.9, -15), (10.8, -11), (16.4, -8), (21, -12)])
    music(track, assets / "wandering.mp3", 115.0, 39.8, 90, 2.4, 4.4,
          [(39.8, -14), (45.6, -11), (48.6, -15), (57, -14),
           (60, -9), (75, -10), (83, -8), (90, -12)])



def projectionist(track, rng, assets):
    time = np.arange(LENGTH) / RATE
    room = recording(assets.parent / "showcase-recordings" / "room.mp3",
                     "highpass=f=96,lowpass=f=5800", start=4, duration=90)
    track[:] += .19 * room[:LENGTH]
    for at in [17.7, 19.24, 20.78, 22.32, 23.86, 25.4, 26.94, 28.48, 30.02, 31.56, 33.1]:
        duration = rng.uniform(.19, .45)
        t = np.arange(int(duration * RATE)) / RATE
        hiss = smooth_noise(rng, rng.uniform(3500, 6100), duration)[:len(t)]
        place(track, .016 * hiss * np.sin(np.pi * t / duration)**1.85, at, .17)
    for at, hz, strength in [(41.08, 369, .07), (49.67, 580, .095), (54.31, 195, .032)]:
        place(track, click(rng, hz, strength), at, .19)
    from_booth = 1 - .88 * envelope(time, 65.5, 79.05, .47)
    for name, start, clip_at, duration, volume in [
        ("projector.mp3", 49.71, .0, 18.6, .89),
        ("projector-other.mp3", 79.20, .12, 9.72, .69),
    ]:
        machine = recording(assets / name, "highpass=f=112,lowpass=f=6200")
        a, b = round(clip_at * RATE), round((clip_at + duration) * RATE)
        machine = machine[a:b]
        start_frame = round(start * RATE)
        t = np.arange(len(machine)) / RATE
        gain = np.clip(t / .32, 0, 1) * np.clip((len(t) / RATE - t) / .96, 0, 1)
        if start < 65.5:
            gain *= from_booth[start_frame:start_frame + len(machine)]
        track[start_frame:start_frame + len(machine)] += machine * (gain * volume)[:, None]
    lobby = recording(assets / "lobby.mp3", "highpass=f=135,lowpass=f=3900")
    left = round(65.7 * RATE)
    length = min(len(lobby), round(13.2 * RATE))
    track[left:left + length] += .21 * lobby[:length] * envelope(
        np.arange(length) / RATE, 0, length / RATE, 2.2
    )[:, None]


def opening_night(track, rng, assets):
    time = np.arange(LENGTH) / RATE
    crowd = recording(assets / "crowd.mp3", "highpass=f=105,lowpass=f=4800")
    offset = round(9.0 * RATE)
    if len(crowd) < offset + LENGTH:
        raise ValueError("Opening Night needs the complete 107-second crowd recording.")
    presence = .24 + .12 * envelope(time, 11, 35, 9) - .15 * envelope(time, 33.8, 51.7, 2.0)
    presence += .23 * envelope(time, 53.1, 79.5, 6) - .17 * envelope(time, 78.7, 92, 3)
    track[:] += crowd[offset:offset + LENGTH] * presence[:, None]
    for start, end, density in [(0, 10, 2.6), (17.9, 33, 3.5), (51.6, 79.5, 3.85)]:
        onset = start + .12
        while onset < end:
            duration = .11
            t = np.arange(round(duration * RATE)) / RATE
            step = (
                .020 * np.sin(TAU * rng.uniform(100, 173) * t) * np.exp(-t * 64)
                + .031 * smooth_noise(rng, 3170, duration) * np.exp(-t * 82)
            )
            place(track, step * rng.uniform(.43, 1), onset, rng.uniform(-.75, .75))
            onset += rng.exponential(1.0 / density)
    # Keep the busy jazz farther back when the doors, nearby visitors and the foyer are the subject.
    music(track, assets / "sax-and-piano.mp3", 1.7, .12, 90, .46, 3.2,
          [(.12, -9), (6, -12), (12, -14), (17.9, -9.5), (33.8, -7.5),
           (51.7, -14), (64, -11), (75, -13), (82, -8.5), (90, -10)])



if __name__ == "__main__":
    mixes = {
        "inside-a-meteorite": meteorite,
        "horse-at-the-ridge": ridge,
        "the-projectionist": projectionist,
        "opening-night": opening_night,
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("film", choices=mixes)
    parser.add_argument("output", type=Path)
    parser.add_argument("--assets", type=Path, default=Path("test-results/showcase-12-15-inputs"))
    args = parser.parse_args()
    mix = np.zeros((LENGTH, 2), dtype=np.float32)
    mixes[args.film](mix, np.random.default_rng(29387), args.assets)
    mix[:RATE // 16] *= np.linspace(0, 1, RATE // 16)[:, None]
    mix[-RATE * 2:] *= np.linspace(1, 0, RATE * 2)[:, None]
    if np.max(np.abs(mix)) > .98:
        raise ValueError("Showcase mix clips.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), "wb") as stream:
        stream.setparams((2, 2, RATE, LENGTH, "NONE", "not compressed"))
        stream.writeframes((mix * 32767).astype("<i2").tobytes())
    print(f"{args.film}: 90 seconds of stereo audio")
