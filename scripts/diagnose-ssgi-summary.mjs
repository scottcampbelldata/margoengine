// Summarize the raw dumps made by diagnose-ssgi-{angle,stream}.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const read = (name) => JSON.parse(readFileSync(`test-results/${name}.json`, 'utf8'));
const normalize = (record) =>
  JSON.stringify(record.calls.filter((call) => call[0] !== 'clientWaitSync')).replaceAll(
    /WebGLSync#\d+/g,
    'WebGLSync#sync',
  );
const channels = (a, b) => {
  let changed = 0,
    max = 0;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      changed++;
      max = Math.max(max, Math.abs(a[i] - b[i]));
    }
  return { changed, max };
};
const result = {};
for (const backend of ['d3d11', 'vulkan']) {
  const streams = read(`review5-ssgi-streams-${backend}`),
    targets = read(`review5-targets-${backend}`);
  const first = normalize(streams[6]),
    next = normalize(streams[7]);
  const repeat = [];
  const a = targets.records.filter((r) => r.frame === 2),
    b = targets.records.filter((r) => r.frame === 47);
  for (let j = 0; j < Math.min(a.length, b.length); j++) {
    if (a[j].raw === b[j].raw) continue;
    const raw1 = Buffer.from(a[j].raw, 'base64'),
      raw2 = Buffer.from(b[j].raw, 'base64');
    if (a[j].type !== 5126) throw Error('first target difference is not a float attachment');
    const values1 = Array.from({ length: raw1.length / 4 }, (_, i) => raw1.readFloatLE(i * 4)),
      values2 = Array.from({ length: raw2.length / 4 }, (_, i) => raw2.readFloatLE(i * 4));
    const i = values1.findIndex((v, i) => v !== values2[i]);
    repeat.push({
      draw: a[j].draw,
      attachment: a[j].att,
      level: a[j].level,
      format: a[j].format,
      x: Math.floor(i / 4) % a[j].width,
      y: Math.floor(i / 4 / a[j].width),
      channel: i % 4,
      values: [values1[i], values2[i]],
      ...channels(values1, values2),
    });
    break;
  }
  let nonfinite = 0;
  for (const r of targets.records)
    if (r.type === 5126) {
      const raw = Buffer.from(r.raw, 'base64');
      for (let i = 0; i < raw.length; i += 4) if (!Number.isFinite(raw.readFloatLE(i))) nonfinite++;
    }
  result[backend] = {
    rawCalls: streams[6].calls.length,
    normalizedCalls: JSON.parse(first).length,
    sameCommands: first === next,
    sha256: createHash('sha256').update(first).digest('hex'),
    screenshot: channels(Buffer.from(streams[6].pixels, 'base64'), Buffer.from(streams[7].pixels, 'base64')),
    firstRepeatTarget: repeat,
    nonfinite,
    glErrors: targets.errors,
    debugErrors: targets.debug.filter((r) => r.error),
  };
}
console.log(JSON.stringify(result, null, 2));
