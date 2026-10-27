// The arena in a browser: two clients (you and a bot) and, without ?server=, a server too, on a simulated network
// whose latency and loss the sliders set. Each view draws its own box predicted and the others interpolated.
import { GameClient, GameServer, LoopbackNetwork } from '@margoengine/netcode';
import { openWebSocket } from '@margoengine/netcode/websocket';
import { game, WALL } from './game.js';

const params = new URLSearchParams(location.search),
  latency = Number(params.get('latency') ?? 80),
  loss = Number(params.get('loss') ?? 5),
  remote = params.get('server');
for (const [id, value] of [
  ['latency', latency],
  ['loss', loss],
]) {
  const input = document.getElementById(id);
  input.value = String(value);
  document.getElementById(`${id}Text`).textContent = String(value);
  input.addEventListener('change', () => {
    params.set(id, input.value);
    location.search = params.toString();
  });
}

const keys = new Set();
addEventListener('keydown', (event) => keys.add(event.key.toLowerCase()));
addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
const axis = (minus, plus) => (plus.some((k) => keys.has(k)) ? 1 : 0) - (minus.some((k) => keys.has(k)) ? 1 : 0);
const human = () => ({
  x: axis(['arrowleft', 'a'], ['arrowright', 'd']),
  y: axis(['arrowdown', 's'], ['arrowup', 'w']),
  boost: keys.has('shift'),
});
const bot = (tick) => ({ x: Math.cos(tick / 20) > 0 ? 1 : -1, y: Math.sin(tick / 35) > 0 ? 1 : -1, boost: false });

let network, server;
const start = performance.now();
let now = () => performance.now() - start;
let connect;
if (remote) connect = () => openWebSocket(remote);
else {
  network = new LoopbackNetwork({ latency, jitter: latency / 4, loss: loss / 100, seed: 1 });
  now = () => network.time;
  server = new GameServer(game, { now });
  network.listen().onconnection = (connection) => server.accept(connection);
  connect = async () => network.connect();
}

// Drives the simulated network and server from real time (only when there is no remote server).
let nextTick = 0;
function pump() {
  if (!network) return;
  network.advance(Math.max(0, performance.now() - start - network.time));
  while (network.time >= nextTick) {
    server.step();
    nextTick += game.tickMs;
  }
}
const pumping = setInterval(pump, 4);

const status = document.getElementById('status');
let me, other;
try {
  [me, other] = await Promise.all([
    GameClient.join(game, await connect(), { now, input: human }),
    GameClient.join(game, await connect(), { now, input: bot }),
  ]);
} catch (error) {
  clearInterval(pumping);
  status.textContent = `Could not join ${remote ?? 'the in-page server'}: ${error.message}. Start the arena server with "node packages/netcode/examples/arena/server.mjs" and reload.`;
  throw error;
}
clearInterval(pumping);
status.textContent = '';
document.body.dataset.running = 'yes';

function draw(canvas, caption, client) {
  const g = canvas.getContext('2d'),
    size = canvas.width,
    scale = size / (2 * WALL + 2),
    style = getComputedStyle(document.body),
    ink = style.color;
  const at = (x, y) => [(x + WALL + 1) * scale, (WALL + 1 - y) * scale];
  g.clearRect(0, 0, size, size);
  g.strokeStyle = ink;
  g.globalAlpha = 0.3;
  g.strokeRect(scale, scale, 2 * WALL * scale, 2 * WALL * scale);
  g.globalAlpha = 1;
  const box = (b, filled, color) => {
    const [px, py] = at(b.x - 0.5, b.y + 0.5);
    g.fillStyle = g.strokeStyle = color;
    if (filled) g.fillRect(px, py, scale, scale);
    else g.strokeRect(px, py, scale, scale);
  };
  for (const [id, b] of client.interpolated().boxes)
    if (id !== client.player) box(b, false, b.owner ? '#e07a2f' : '#7a8a99');
  const mine = client.predicted.boxes.get(client.player);
  if (mine) box(mine, true, '#2f7de0');
  const s = client.stats;
  caption.textContent = `Player ${client.player}: round trip ${Math.round(s.rtt)} ms, predicted tick ${client.tick}, server tick ${client.serverTick}, ${s.mispredictions} corrections`;
}

function frame() {
  pump();
  me.update();
  other.update();
  draw(document.getElementById('a'), document.getElementById('aText'), me);
  draw(document.getElementById('b'), document.getElementById('bText'), other);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
