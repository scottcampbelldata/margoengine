/** Runs `work(item)` for every item, `jobs` at a time, in order of start. */
export async function eachAtOnce(items, jobs, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
