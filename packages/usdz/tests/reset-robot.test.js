// The layout a robot export gives reset transform stacks, in a small stage of Margo's own: a Z-up stage whose robot
// comes in through a payload, links nested in one another that each reset and carry their world matrix, a shared shell
// referenced as an instance under every link, a collision mesh of the guide purpose, and a bare reset with no other op.
// The real files it stands beside (scripts/test-real-reset.mjs) are never in the repository. The expected places follow
// the rule that a reset leaves the parent transform out, and OpenUSD (usd-core 26.11, tests/oracle/real-reset-truth.py)
// gave the same for these four layers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUSDFiles } from '../dist/compose.js';
import { nodeAt, pose, shown, transform } from './pose.js';

const matrix = (x, y, z, turn = false) =>
    `matrix4d xformOp:transform = ( (${turn ? '0, 1, 0, 0), (-1, 0, 0, 0)' : '1, 0, 0, 0), (0, 1, 0, 0)'}, ` +
    `(0, 0, 1, 0), (${x}, ${y}, ${z}, 1) )`,
  shell = `def Xform "shell" (
    instanceable = true
    prepend references = @shell.usda@</Shell>
)
{
}`,
  layers = {
    'robot.usda': `#usda 1.0
(
    defaultPrim = "Robot"
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Robot" (
    prepend payload = @links.usda@</Links>
)
{
    double3 xformOp:translate = (5, 6, 7)
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
`,
    'links.usda': `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Links"
{
    def Xform "link1"
    {
        ${matrix(0, 0, 0.25, true)}
        uniform token[] xformOpOrder = ["!resetXformStack!", "xformOp:transform"]

        ${shell}

        def Xform "link2"
        {
            ${matrix(0.1, -0.2, 0.5)}
            uniform token[] xformOpOrder = ["!resetXformStack!", "xformOp:transform"]

            ${shell}

            def Xform "tool"
            {
                double3 xformOp:translate = (0, 0, 0.125)
                uniform token[] xformOpOrder = ["xformOp:translate"]
            }

            def Xform "home"
            {
                uniform token[] xformOpOrder = ["!resetXformStack!"]
            }

            def "collision" (
                prepend references = @shell.usda@</Shell>
            )
            {
                uniform token purpose = "guide"
            }
        }
    }
}
`,
    'shell.usda': `#usda 1.0
(
    metersPerUnit = 1
    upAxis = "Z"
)
def Xform "Shell"
{
    def Mesh "triangle"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (0.5, 0, 0), (0, 0.25, 0)]
        uniform token subdivisionScheme = "none"
    }
}
`,
  },
  open = () => parseUSDFiles('robot.usda', (id) => new TextEncoder().encode(layers[id.replace(/^(\.\/)+/, '')]));

// Z up to glTF's Y up: (x, y, z) goes to (x, z, -y).
const up = ([x, y, z]) => [x, z, -y];
const close = (a, b, what) =>
  assert.ok(
    a.every((x, i) => Math.abs(x - b[i]) < 1e-6),
    `${what}: ${a} against ${b}`,
  );

test('nested links that reset stand where their own matrices say, not under the links above', async () => {
  const asset = await open(),
    posed = pose(asset, 0),
    at = (path, point = [0, 0, 0]) => transform(posed.world[nodeAt(asset, path)], point);
  close(at('/Robot'), up([5, 6, 7]), 'the robot keeps its own translation');
  close(at('/Robot/link1'), up([0, 0, 0.25]), 'link1 leaves the robot out');
  close(at('/Robot/link1', [1, 0, 0]), up([0, 1, 0.25]), 'link1 keeps its quarter turn');
  close(at('/Robot/link1/link2'), up([0.1, -0.2, 0.5]), 'link2 leaves link1 out');
  close(at('/Robot/link1/link2/tool'), up([0.1, -0.2, 0.625]), 'a child that does not reset follows link2');
  close(at('/Robot/link1/link2/home'), [0, 0, 0], 'a bare reset puts the prim at the stage origin');
});

test('the shared shell draws under each link at that link, and the guide copy does not draw', async () => {
  const asset = await open(),
    posed = pose(asset, 0),
    corner = (path) => transform(posed.world[nodeAt(asset, path)], [0.5, 0, 0]);
  close(corner('/Robot/link1/shell/triangle'), up([0, 0.5, 0.25]), 'the turned link carries its shell');
  close(corner('/Robot/link1/link2/shell/triangle'), up([0.6, -0.2, 0.5]), 'the second link carries its shell');
  assert.deepEqual(
    asset.meshes.map((m) => m.path).sort(),
    ['/Robot/link1/link2/shell/triangle', '/Robot/link1/shell/triangle'],
    'two meshes draw: the guide copy is left out',
  );
  for (const mesh of asset.meshes) assert.ok(shown(asset, nodeAt(asset, mesh.path), posed), `${mesh.path} shows`);
});
