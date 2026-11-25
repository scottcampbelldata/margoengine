# Physics review of the demos and films

Every physical problem found in Margo's demo videos and documentary films, checked frame by frame, with the solver in
[physics-solvers.md](physics-solvers.md) that fixes it. A row stays here until its fix lands and the shot is re-rendered
and checked; then it reads FIXED with the commit. The engine-side defects behind these rows are in
[physics-audit.md](physics-audit.md) and [known-bugs.md](known-bugs.md).

Status: OPEN (not fixed), BUILDING (its solver is being built), FIXED (landed and checked on a re-render).

## Opening Night (opening-night)

A plaza crowd enters a concert hall through glass walls; three entrance groups converge inside.

| ID | Time | What is wrong (observed) | What real physics does | Solver | Status |
| --- | --- | --- | --- | --- | --- |
| OPENING-NIGHT-1 | 1:06-1:12 | A man in a white shirt walks against the inside of a glass wall panel for about 5 s; his walk cycle plays while he barely moves. | A walker sees the wall and steers along it or around it. | LIFE-05 (navmesh crowd: walls are not avoidance constraints) | BUILDING |
| OPENING-NIGHT-2 | 1:08-1:10 | A woman stays at almost the same spot while her body turns from facing the camera to facing away in under 2 s. | A walker who cannot reach a corner or a seat slows and stops; she never spins in place. | LIFE-05 (corner and arrival orbiting) | BUILDING |
| OPENING-NIGHT-3 | 1:06-1:12 | Where the three paths meet, 8 to 10 people stand with heads and torsos inside each other and stay there. | Bodies never overlap; a dense group packs shoulder to shoulder and shuffles to make room. | LIFE-05 (no separation between stopped agents) | BUILDING |

## Below the Blue Line (below-the-blue-line)

A coral reef: reef sharks, a ray, a dolphin, a humpback whale, angelfish and clownfish with a host anemone.

| ID | Time | What is wrong (observed) | What real physics does | Solver | Status |
| --- | --- | --- | --- | --- | --- |
| BLUE-LINE-1 | 0:15-0:19 | The anemone's tentacles are rigid for the whole shot, and the clownfish push in among them without any tentacle bending. | Tentacles sway in the surge and bend away from a fish that touches them. | BIO-01, SOFT-02 | OPEN |
| BLUE-LINE-2 | whole film | The water is still: no surge from the swell, no drifting particles, and corals and sea grass never move. | Swell drives a back-and-forth surge at depth that moves everything soft and carries particles. | SEA-02 (water velocity at depth), SEA-15 (drifting particles), BIO-01 | OPEN |
| BLUE-LINE-3 | 0:15-0:19, 0:26-0:30 | The clownfish swing their heading around while barely moving; an angelfish pitches and turns almost in place. | A fish turns along an arc whose radius scales with body length, and hovers by sculling its fins without spinning. | LIFE-03 | OPEN |
| BLUE-LINE-4 | 0:26-0:30 | "Angelfish weave" shows three single fish, not a school. | Reef fish travel in loose schools that keep spacing and turn together. | LIFE-04 | OPEN |
| BLUE-LINE-5 | whole film | Every animal moves along an authored path; forward speed has no link to the tail beat. | Speed follows from tail-beat frequency and amplitude against drag and added mass. | LIFE-03 | OPEN |
| BLUE-LINE-6 | 0:51-0:57 | The ray glides just above the sand and the sand never stirs; the bed never changes anywhere. | Fins near the bed lift a sand plume that drifts and settles; surge builds and moves ripples. | HYDRO-03, SEA-15 | OPEN |
