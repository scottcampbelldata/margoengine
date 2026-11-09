# GPU mutex target lookup

The batch 171 GPU gate failed before starting its browser with `EINVAL: invalid argument, readlink .../mutex`.
The scheduler inspected the reusable junction with `lstatSync`, then resolved it with `realpathSync`.
Another owner could retire/replace the name between these accesses, invalidating the second lookup.

Research compared Matt Bishop and Michael Dilger, *Checking for Race Conditions in File Accesses* (1996),
https://www.usenix.org/legacy/publications/compsystems/1996/spr_bishop.pdf (abstract and introduction),
with Maurice Herlihy and Jeannette Wing, *Linearizability: A Correctness Condition for Concurrent Objects*
(1990), https://www.cs.cmu.edu/~wing/publications/HerlihyWing90.pdf (abstract), and the Node.js contributors,
*File system* (2026), https://nodejs.org/api/fs.html#fsreadlinksyncpath-options, readlink semantics.
The Open Group, *readlink*, POSIX.1-2017,
https://pubs.opengroup.org/onlinepubs/9699919799/functions/readlink.html,
defines EINVAL for a name that is no longer a symbolic link. No foreign implementation was read.

The repair reads the published backing name once with `readlinkSync`, then works only with that unique
backing directory. A removed name (ENOENT) or legacy plain directory (EINVAL) has no reclaimable target.
Permission/I/O errors still surface. This is a failed observation of a changed name, not a retry or an
assumption that a live owner is dead. Existing PID/token validation and atomic metadata claims are retained.
`tests/gpu-lock-mutex.test.js` checks one lookup, absent/non-link names, relative targets and permission errors;
the owner suite checks live/dead ownership and contention. The regression fails on the prior implementation.
No GPU slot, wall-clock budget, queue policy or exclusive mode changes.

Run `node --test --test-timeout=120000 tests/gpu-lock-mutex.test.js tests/gpu-lock-owner.test.js`.
This is CPU-only correctness work. The repaired helper subsequently admitted the actual flow browser gate,
which passed its existing render, parity and device-replacement assertions on both backends.
