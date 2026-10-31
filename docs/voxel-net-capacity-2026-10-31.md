# Voxel multiplayer capacity on a real network (2026-10-31)

**Answer.** One 4 core rented VPS (15 GiB) holds about 180 players per shard and 540 per box with the 20 Hz budget met.
Those are crowded players at view distance 8. At 200 per shard the budget is lost by a few milliseconds. Past about 210 on
one shard the tick rate starts to fall: 246 players ran at 14.9 ticks a second.

These figures are lower than the loopback figures in [voxel-net-capacity-2026-10-21.md](voxel-net-capacity-2026-10-21.md)
(350 crowded on a Ryzen 9 9950X core, view 6). The real numbers are the ones to plan with. Raw numbers:
`packages/voxel-net/bench/results-real-network-2026-10-31.json`.

## How it was measured

- **Path**: bots, the internet, a CDN proxy, nginx, the router's `/join`, shards. No loopback.
- **Server**: 4 cores, 15 GiB, Node 24, one generator thread per shard, the service's CPU quota of 360%.
- **Bots**: `VoxelBot`, `bench/run.mjs --url --metrics`. They ask `/join`, send the page's Origin, use view 8, walk and jump,
  and edit every 2 s. One in eight decodes player updates. They stay connected from step to step and do not render.
- **Bot machines**: an N100 mini PC and a Ryzen 9 9950X on one home line (measured 700 Mbit/s down, 260 up). Neither
  was the limit: the N100 peaked at 48% mean CPU, the 9950X at 26%, the line carried about 55 Mbit/s, and bots received 94 to 100%
  of what the server wrote.
- **Temporary test changes**: per-address connection and request limits raised, since all bots share one address.
- **Hold**: 5 minutes per step. The first 60 s of a hold are left out of the tick numbers.
- **Budget**: p95 tick work at most 50 ms and at least 19.5 ticks a second.

## Crowd, three shards through /join

Players arrive at 3 a second around the square and stay within 64 blocks of it. Tick figures are p50 / p95 of the fullest shard.

| Players | Shards | Tick ms | Ticks/s (lowest shard) | Round trip ms p50 / p95 | Edit to others ms p50 / p95 | Corrections per player per minute | Core use, 4 cores | Network out Mbit/s | In budget |
| ---: | --- | --- | ---: | --- | --- | ---: | --- | ---: | --- |
| 25 | 25 | 2.0 / 3.6 | 20.0 | 31 / 37 | 53 / 82 | 0.09 | 5% | 0.9 | yes |
| 49 | 49 | 4.6 / 6.9 | 20.0 | 31 / 34 | 69 / 83 | 0.21 | 8% | 2.3 | yes |
| 99 | 99 | 12.7 / 18.4 | 20.0 | 31 / 39 | 67 / 89 | 0.24 | 16% | 7.2 | yes |
| 199 | 192 + 7 | 36.6 / 48.5 | 19.9 | 48 / 71 | 77 / 118 | 0.42 | 36% | 22.8 | yes |
| 297 | 199 + 98 | 38.8 / 51.4 | 20.0 | 40 / 75 | 73 / 111 | 0.44 | 48% | 30.7 | no, by 1.4 ms |
| 397 | 200 + 193 + 4 | 40.7 / 56.2 | 19.9 | 53 / 83 | 80 / 126 | 0.41 | 65% | 48.7 | no |
| 497 | 200 + 200 + 97 | 44.2 / 63.2 | 19.5 | 54 / 97 | 83 / 143 | 0.96 | 75% | 54.7 | no |
| 579 | 192 + 195 + 198 | 41.6 / 65.5 | 19.7 | 57 / 97 | 86 / 144 | 0.41 | 75% | 54.8 | no |

No core ran out, and memory stayed under 2.5 GiB in use. Each shard's main thread is the limit, at about one core.

## Crowd, one shard pushed past 200

| Players | Tick ms p50 / p95 | Ticks/s | Round trip ms p50 / p95 | Edit to others ms p50 / p95 | Full view ms p50 | In budget |
| ---: | --- | ---: | --- | --- | ---: | --- |
| 172 | 30.5 / 41.6 | 20.0 | 34 / 68 | 72 / 110 | 1,294 | yes |
| 211 | 44.5 / 60.3 | 19.9 | 59 / 86 | 84 / 141 | 1,329 | no |
| 246 | 60.4 / 79.1 | 14.9 | 64 / 102 | 101 / 159 | 1,769 | no |
| 263 | 65.9 / 88.2 | 13.9 | 65 / 108 | 109 / 181 | 2,124 | no |
| 297 | 89.9 / 112 | 10.2 | 86 / 134 | 139 / 224 | 2,373 | no |
| 345 | 132 / 176 | 6.9 | 110 / 262 | 193 / 405 | 3,246 | no |

The failure is gradual: the world slows down for everyone, and nothing crashes.

## Spread, one shard

Bots walked outward from the ring towards random points on a disc of 1,024 blocks. Few reached their point in the 20 minutes,
so this is a crowd fanning out and not a fully spread map. A fully spread run was not completed: see the flying result below.

| Players | Tick ms p50 / p95 | Ticks/s | Full view ms p50 | Out Mbit/s | In budget |
| ---: | --- | ---: | ---: | ---: | --- |
| 101 | 11.5 / 16.1 | 20.0 | 1,298 | 7.5 | yes |
| 201 | 33.3 / 48.7 | 20.0 | 1,329 | 19.9 | yes |
| 300 | 71.5 / 93.4 | 12.9 | 1,789 | 30.4 | no |

**Flying out.** When 150 bots flew outward at once, 38 were closed with 1008 `too many messages` within about 100 s. Each shard
has one generator thread, measured at 27 to 29 new chunks a second. A player's inputs wait until the chunks around it exist,
and 256 waiting messages closed the connection. Walking bots were never closed this way, at up to 300 players.

Fixed since, measured on a local shard with its generator slowed to the box's 28 chunks a second and the same 150 bots: 18 to 28
closes a run became 0, and a client flying among them went from up to 43 blocks snapped back, 6 times in 110 s, to none. The wait
is still there: that client stood still for 81 of 110 s, on the ground it had, and covered 2.6 blocks a second against 11 alone.
A second generator thread (`--workers=2`) cut the wait to 57 of 110 s and 5.0 blocks a second, for 68 to 97 MB more per shard.
What it costs the box's CPU is not measured.

## Surge and overflow

Everyone arrives at the square, through `/join`. In this run the third shard was refused by the router bug below, so 400 was the
ceiling.

| Arrivals | Rate | Spawn ms p50 / p95 | Full view ms p50 / p95 | Worst p95 tick ms in the join | Lowest ticks/s in the join | Disconnects |
| --- | --- | --- | --- | ---: | ---: | ---: |
| First 100 | 1.7 a second | 335 / 470 | 1,287 / 1,390 | 16 | 20.0 | 0 |
| Next 200 | 3.3 a second | 360 / 600 | 1,310 / 1,460 | 54 | 18.3 | 0 |
| Next 700 | 10 a second | 430 / 625 | 1,344 / 1,473 | 60 | 16.7 | 0 |

- The ticks dip while a shard fills and return to about 20 once it is full.
- `/join` answered 5,672 "full" replies with no error. The median was 38 to 40 ms and the p95 50 to 83 ms, at about 19 a second for
  4 minutes. Higher `/join` rates were not tested.
- The real page, opened while full, showed "Plaza is full, 400 people are in, building alone, retrying" and a Join button, and
  started its own world. It ran at about 1 frame a second in the pane it was opened in, so its frame rate says nothing.
- When 100 players left, 114 waiting bots got in within 45 s. Bots rejoin by themselves. The page asks the player to press Join.

## Bugs found by this run

- **Fixed**: the router read `availableParallelism`, which follows the service's CPU quota (360% reads as 3), so it refused a third
  shard above load 2. 1,000 arrivals got 400 places with cores idle. It now counts the machine's cores. The 600 player row above
  was measured with the fix.
- **Fixed in code, not measured**: a page playing alone asked `/join` every 30 s and each ask held a place for 5 s. It now uses
  `?peek=1`, which holds nothing.
- **Not a server bug**: the 1006 closes on old connections come from the CDN proxy ("Old connections" below). A page now
  resumes in place through them, protocol 4; the one `client-silent` close stays unexplained, and shows in `/metrics` as a
  park of its own kind.

## Old connections

A 45 minute hold, on one test shard with about 140 players at most, all at once from 12:10 UTC. Ends with no close frame:

| Path | Bots | Gone after 45 min |
| --- | ---: | ---: |
| N100, home line, CDN, nginx, shard | 40 | 26 |
| 9950X, home line, CDN, nginx, shard | 30 | 20 |
| The server itself, CDN, nginx, shard | 30 | 20 |
| The server itself, nginx on loopback, shard | 20 | 0 |
| The server itself, shard | 20 | 0 |

- **Who closed first:** the CDN. Packets on the server, for the 30 closes captured whole: the FIN comes in from a CDN address, nginx's
  FIN reaches the shard within 0.5 ms, and only then come the shard's and nginx's own. nginx sent first in none. The shard's writes were never behind (0 bytes buffered at every close).
- **What it depends on:** age, not load or traffic. The youngest of the 66 was 1,073 s, and the earlier load run's was 902 s. A plain
  echo server with no Margo code, run through the same proxy, lost its first connection at 949 s, with 12 of 40 gone within
  20 minutes: 5 of 20 sending 20 messages a second and 7 of 20 sending one every 20 s. Of 20 sockets in a real browser, one was
  cut at 925 s (code 1006, not clean) in the 19 minutes they were held.
- **What is not known:** why this waits for about 15 minutes. The CDN's documents say restarts end WebSockets and that clients must
  expect it, and give no age.
- **The bots' home line is not the cause:** bots on the server, reaching a different CDN location, were cut at the same rate.
- **A real player:** should expect the same, since nothing about these paths is specific to bots. The page shows "The connection
  dropped" and reloads, and the player comes back at another spawn point within seconds.

To repeat this, or to check a new host or proxy setting: `packages/voxel-net/bench/long-hold.mjs`.

## Transfer (worked out from the rows above)

The box sent about 0.1 Mbit/s per crowded player at 500 to 600 players. A month of 16 TB is 49 Mbit/s on average, about 490 crowded
players around the clock. Three days at 540 players use about 1.8 TB.

## Caveats

- All load bots came from one home line and one address, so all used one proxy location. Real players use many. The old
  connections hold above also used a second location.
- Bots do not render, so client frame rates are not here. They edit every 2 s.
- Tick figures read a rolling 60 s window from `/metrics`, so p95 is the median of that window across the hold.
- Each step ran on the same world, with more edits as it went. Memory grew with them.
