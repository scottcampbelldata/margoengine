# Batch 170 cache work counts (2026-11-10)

`AssetCache` answers a hit from IndexedDB, then writes the file's last-used time back so eviction can pick the least
recently used file. The parent queued one read-write transaction per hit. Hits whose writes are queued back to back
now share one read-write transaction: inside it each file's record is read once and every hit for that file is applied
in hit order, so the stored records are the same as separate writes leave them. Any other write queued after the batch
(a store, a delete, a clear) closes it, and a batch that has started takes no more hits, so writes keep their order.

Counted in Node on an in-memory IndexedDB (`packages/cache/test/workcount.test.js`, fails on the parent):

| Work | Parent | After | Output |
| --- | --- | --- | --- |
| 300 hits on 3 stored files, issued together | 300 readonly + 300 readwrite transactions | 300 readonly + 1 readwrite | same bytes served; every record's `used` equals the hit time |

The readonly lookups are the reads that answer the hits and are unchanged.

## Workbox comparison

Workbox 7.4.1 `CacheFirst` with its `ExpirationPlugin` (the usual way to get an LRU budget with Workbox), run as a
black box outside this repository on the same in-memory IndexedDB: 300 hits cost 300 Cache Storage reads plus 300
IndexedDB read-write transactions, one per hit, to stamp the time. Margo now costs 300 reads plus 1 read-write
transaction for the same burst. Time per hit is timing pending the quiet rerun; no speed ratio is claimed.

## Failure counting

A batched write that fails (quota, a closed database) adds one to `stats.errors` for the batch, where the parent added
one per hit. The served responses are not affected either way: the stamp is written after the answer.

Reproduce: `npm test --workspace @margoengine/cache`.

Research: W3C *Indexed Database API 3.0* (Editor's Draft, accessed 2026-11-10), https://w3c.github.io/IndexedDB/ ,
transaction lifetime and scheduling (a transaction's requests run in order; read-write transactions on overlapping
scopes run in creation order). No other implementation was read or copied.
