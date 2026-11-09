// OpenEXR standard test images only; provenance and licence: tests/fixtures/NOTICE.md and supply-chain.mjs.
import { fileURLToPath } from 'node:url';
import { fetchFixture } from '../../../scripts/support/fetch-fixture.mjs';
const base =
  'https://raw.githubusercontent.com/AcademySoftwareFoundation/openexr-images/e38ffb0790f62f05a6f083a6fa4cac150b3b7452/TestImages/';
for (const [name, hash] of [
  ['BrightRings.exr', '4bf318bfdd9a8371694f8009be5d9ff21d4af8b73f444e34a5a047b8253c83e2'],
  ['AllHalfValues.exr', 'eede573a0b59b79f21de15ee9d3b7649d58d8f2a8e7787ea34f192db3b3c84a4'],
])
  await fetchFixture(base + name, fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)), hash);
