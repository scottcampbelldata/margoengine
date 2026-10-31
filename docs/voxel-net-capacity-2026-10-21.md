# Voxel multiplayer capacity, measured (2026-10-21)

**Answer.** One `@margoengine/voxel-net` server process on this PC keeps its 20 ticks per second, with 95% of
ticks inside the 50 ms budget, for:

- **900 players spread over a map** (spawned across a disc of 1,024 blocks radius). 1,000 is over the budget.
- **350 players crowded in one spot** (within 64 blocks of spawn, so everyone sees everyone). 400 is over the
  budget.

Those numbers include `EntityCodec.prepare`, added to `@margoengine/voxel` during this work. With `EntityCodec` as it
was, the limits were 800 spread and 200 crowded. The server's main thread is the limit: at the breaking point the whole
server process used about one CPU core of this PC's 32 logical processors.

Everything below is measured unless it says *estimate*. Raw numbers: `packages/voxel-net/bench/results.json` (with
`EntityCodec.prepare`) and `packages/voxel-net/bench/results-entitycodec-before.json` (before). Design:
`packages/voxel-net/DESIGN.md`.

## How it was measured

- **PC**: AMD Ryzen 9 9950X (16 cores, 32 logical processors), 94 GB RAM, Windows 11, Node 26.12.
- **Server**: `VoxelServer` in its own process, 20 ticks per second, view 6 chunks across (a circle) and 3 up and
  down, simulation 3 chunks across and 2 up and down, players heard within 96 blocks, 8 generator threads, terrain
  `noiseTerrain` seed 1 with the sandbox's settings (no plants).
- **Bots**: `VoxelBot`, in processes of 50 bots each, joining at 25 per second. Each walks a random heading for 3 to
  8 s, jumps when blocked, swims up in water, and every 2 s breaks or places a block it looks at. Bots decode only
  the chunks within one chunk of themselves. One bot in eight decodes every player update; the others count those
  bytes. Crowd bots walk back towards spawn once they are 64 blocks out.
- **Each run**: all bots join, the run waits until every bot has received its whole view, then measures 30 s.
- **Budget**: a count is in budget when its 95th-percentile tick work is at most 50 ms and the server still runs
  19.5 or more ticks per second.

## Results with `EntityCodec.prepare`

"Tick ms" is the server main thread's work per tick. "Spawn" and "full view" are measured from connecting, while the
other bots are still joining. "Edit to others" runs from a bot sending an edit to another bot receiving it.

| Scenario | Players | Tick ms median / p95 / max | Ticks/s | Main thread busy | CPU cores | RSS MB | Out KiB/s per player / total | In KiB/s per player | Spawn ms median / p95 | Full view ms median / p95 | Edit to others ms median / p95 | In budget |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- |
| spread | 50 | 1.4 / 2.7 / 3.6 | 20 | 5% | 0.14 | 610 | 1.5 / 77 | 0.8 | 131 / 271 | 977 / 1250 | 32 / 63 | yes |
| spread | 100 | 3.0 / 4.3 / 6.7 | 20 | 9% | 0.22 | 528 | 1.6 / 164 | 0.8 | 113 / 220 | 806 / 1217 | 31 / 63 | yes |
| spread | 200 | 6.3 / 8.5 / 12.0 | 19.99 | 17% | 0.35 | 614 | 1.7 / 334 | 0.8 | 99 / 204 | 697 / 1255 | 33 / 64 | yes |
| spread | 400 | 13.7 / 17.2 / 22.4 | 19.99 | 35% | 0.57 | 620 | 1.8 / 700 | 0.8 | 103 / 169 | 662 / 1103 | 39 / 65 | yes |
| spread | 600 | 21.5 / 25.6 / 31.3 | 19.99 | 53% | 0.78 | 699 | 1.8 / 1106 | 0.8 | 113 / 173 | 661 / 980 | 53 / 75 | yes |
| spread | 800 | 30.9 / 36.5 / 43.3 | 19.99 | 73% | 1 | 779 | 1.9 / 1538 | 0.8 | 114 / 186 | 666 / 903 | 55 / 85 | yes |
| spread | 900 | 36.6 / 45.5 / 60.2 | 20 | 81% | 1.02 | 880 | 1.9 / 1669 | 0.8 | 119 / 224 | 666 / 869 | 64 / 117 | yes |
| spread | 1000 | 39.7 / 55.3 / 68.5 | 19.99 | 88% | 1.15 | 860 | 1.9 / 1864 | 0.8 | 123 / 250 | 671 / 871 | 77 / 135 | **no** |
| crowd | 50 | 2.2 / 3.1 / 4.3 | 20 | 6% | 0.11 | 272 | 6.5 / 326 | 0.8 | 97 / 182 | 652 / 932 | 31 / 63 | yes |
| crowd | 100 | 5.0 / 7.4 / 9.1 | 19.99 | 13% | 0.16 | 325 | 11.1 / 1113 | 0.8 | 110 / 207 | 647 / 805 | 46 / 64 | yes |
| crowd | 200 | 13.6 / 19.1 / 22.8 | 19.99 | 32% | 0.39 | 344 | 19.9 / 3989 | 0.8 | 143 / 255 | 650 / 704 | 39 / 67 | yes |
| crowd | 300 | 27.9 / 31.6 / 40.1 | 20 | 61% | 0.72 | 563 | 29.2 / 8761 | 0.8 | 175 / 322 | 651 / 714 | 55 / 79 | yes |
| crowd | 350 | 37.2 / 40.8 / 64.2 | 20 | 79% | 0.93 | 649 | 31.2 / 10904 | 0.8 | 161 / 327 | 656 / 702 | 61 / 105 | yes |
| crowd | 400 | 43.3 / 51.0 / 87.3 | 20 | 92% | 1.05 | 812 | 27.2 / 10881 | 0.8 | 186 / 1024 | 656 / 1028 | 72 / 136 | **no** |

The crowd 350 row comes from a separate run the same day, made to narrow the crowd limit.

## Before `EntityCodec.prepare`

| Scenario | Players | Tick ms median / p95 | Ticks/s | In budget |
| --- | ---: | --- | ---: | --- |
| spread | 800 | 33.2 / 40.8 | 19.99 | yes |
| spread | 900 | 39.3 / 50.3 | 19.99 | **no** |
| crowd | 200 | 26.1 / 30.1 | 19.99 | yes |
| crowd | 300 | 54.1 / 57.5 | 17.97 | **no** |
| crowd | 400 | 92.0 / 96.2 | 10.74 | **no**: joins took 18.6 s at p95 |

## What the numbers mean

- **Cost per player.** Spread, each player adds about 0.04 ms of tick work. In a crowd every player hears every other,
  so the cost grows with the square of the count: 100 to 200 players took tick work from 5.0 to 13.6 ms.
- **Bandwidth.** Spread players get about 1.9 KiB/s each, mostly new chunks as they walk. Crowded players get 29 to 31
  KiB/s each, mostly other players' movement. The server sends 13.7 Mbit/s for 900 spread players and 71.8 Mbit/s for
  300 crowded ones, so a real host's uplink matters as much as its CPU for crowds. Each player sends 0.8 KiB/s up
  (20 input messages a second).
- **Joining.** A player can move about 0.1 to 0.2 s after connecting (median). Its whole view arrives in 0.65 to 1.0 s
  (median; about 790 chunks, 0.3 MB) and within 1.3 s at p95, while 25 others join each second.
- **Edits.** Other players see an edit 31 to 77 ms after it is sent (median), 63 to 136 ms at p95. That includes
  waiting for the next tick (up to 50 ms).
- **Movement.** Client prediction and the server agree: at most 0.37 corrections per player per minute, and none in
  most spread runs.
- **Memory.** 270 to 880 MB for the whole server process. The 8 generator threads account for about 250 MB of
  it: a 10-bot trial measured 466 MB with 8 threads and 210 MB with 1.

## Heartbeat cost (added 2026-10-31, the tables above predate it)

Bytes per player per second at the default settings, frame headers included, next to the 1.9 KiB/s (spread) and 29 to
31 KiB/s (crowd) above. Measured on `VoxelServer` over loopback, except the pong, which is worked out from its frame.

| Player | Down | Up |
| --- | ---: | ---: |
| In traffic both ways (a crowd, or any walking player in view of another) | 0 | 0 |
| Lone and visible: sends its inputs, nothing arrives | 0.6 (a 3 byte heartbeat every 5 s) | 0 extra (its inputs count) |
| Lone and hidden: no inputs either | 1.0 (measured: 60 bytes in 60 s, heartbeats and 2 byte pings) | 1.2 (a 6 byte pong every 5 s) |

On the network each of those small sends is one packet every 5 s with its TCP and IP headers (about 40 bytes, *estimate*,
more with TLS): under 20 bytes per second for a hidden player. 1,000 quiet players cost about 20 KB/s (*estimate*). A
20 bot run (`bench/run.mjs`, 20 s window, not recorded in results.json) spent 0 bytes per second on heartbeats in the
crowd and 2 in total spread out; its tick work was 0.94 ms median and 1.46 ms p95 in the crowd, 19.99 to 20.04 ticks per
second, no bot closed. Per tick the server adds two integer comparisons per client, so the tables above still stand.

## Where the server's time goes

Main-thread profiles (`bench/run.mjs --profile`, read with `bench/profile.mjs`). They cover the join phase as well
as the measured window, so the shares are approximate.

| Run | Player updates (`EntityCodec.encode`) | The tick's own loop (neighbour search, message building) | Socket writes | Other |
| --- | ---: | ---: | ---: | --- |
| Crowd 250, before `prepare` | 62% | 13% | 11% | |
| Crowd 300, with `prepare` | 43% | 19% | 17% | |
| Spread 600, with `prepare` | 7% | 20% | 31% | chunk unpacking 5% |

## Caveats

- Server and bots ran on one PC over loopback: no network latency, loss or bandwidth limit, and the bots shared the
  CPU (bot processes stayed under 12% busy, so they were not the limit).
- Other sessions' work was running on this PC at the same time: about 300 Node processes, using about 10% of total
  CPU when sampled after the runs.
- Windows timers are coarse. Even with 50 players the 95th-percentile gap between tick starts was about 62 ms; the
  rate stayed at 20 per second because the loop catches up. This adds to edit latency, not to load.
- Bots are simpler than people. They do not render, so client frame rate is not measured here. Edits come every 2 s
  per bot.

## What would raise the limits (*estimates, not measured*)

- **Crowds**: send far players less often (for example 20 Hz within 32 blocks, 5 Hz beyond), and cap how many players
  one client hears about. Size `EntityCodec`'s output buffer once instead of growing it.
- **Both**: the per-client loop builds 49 string keys a tick to find nearby players; integer keys or a reused list
  would cut most of that. Socket writes were 31% of the spread profile: skip a player's message when nothing changed.
- **More cores**: one server process uses about one core. Several worlds (or regions of one world) in separate
  processes would use the rest of the machine.
