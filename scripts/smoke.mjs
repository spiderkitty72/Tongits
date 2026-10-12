// End-to-end smoke test against a running server: three players sign up, open a room,
// set the rules, and play a full match by always drawing and discarding their highest card.
// Usage: node scripts/smoke.mjs http://localhost:8080 [inviteCode]
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:8080';
const invite = process.argv[3] ?? '';
const stamp = Date.now();

async function post(path, body, token) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

const points = (c) => Math.min(10, Number(c.slice(0, -1)));

function player(name) {
  return new Promise(async (resolve) => {
    const { token } = await post('/api/register', { email: `${name}-${stamp}@example.com`, password: 'password123', displayName: name, inviteCode: invite });
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    const p = { name, token, ws, room: null, waiters: [] };
    p.send = (m) => ws.send(JSON.stringify(m));
    p.until = (fn) => new Promise((r) => { if (p.room && fn(p.room)) r(p.room); else p.waiters.push({ fn, r }); });
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'hello') resolve(p);
      if (m.t === 'error') console.log(`  [${name}] server says: ${m.message}`);
      if (m.t === 'room') {
        p.room = m.room;
        p.waiters = p.waiters.filter((w) => (m.room && w.fn(m.room) ? (w.r(m.room), false) : true));
        autoplay(p);
      }
    });
    ws.on('open', () => p.send({ t: 'auth', token, protocol: 1 }));
  });
}

function autoplay(p) {
  const room = p.room;
  const g = room?.game;
  if (!g || room.status !== 'playing' || g.phase === 'ended') return;
  if (g.phase === 'drawCall' && g.drawCall.waitingOn.includes(g.seat)) return p.send({ t: 'act', action: { type: 'respondDraw', fight: true } });
  if (g.turn !== g.seat) return;
  if (g.phase === 'draw') {
    if (g.canCallDraw && g.myPoints < 10) return p.send({ t: 'act', action: { type: 'callDraw' } });
    return p.send({ t: 'act', action: { type: 'drawStock' } });
  }
  if (g.phase === 'play') {
    const worst = g.hand.reduce((a, b) => (points(b) > points(a) ? b : a));
    p.send({ t: 'act', action: { type: 'discard', card: worst } });
  }
}

const [a, b, c] = await Promise.all(['Ana', 'Ben', 'Cris'].map(player));
console.log('3 players signed up and connected');
a.send({ t: 'create' });
const lobby = await a.until((r) => r.status === 'lobby');
console.log('Room', lobby.code);
b.send({ t: 'join', code: lobby.code });
c.send({ t: 'join', code: lobby.code });
await a.until((r) => r.seats.every(Boolean));
a.send({ t: 'rules', rules: { ...lobby.rules, gameLength: 'rounds', rounds: 2, turnSeconds: 30 } });
await a.until((r) => r.rules.rounds === 2);
for (const p of [a, b, c]) p.send({ t: 'ready', ready: true });
await a.until((r) => r.seats.every((s) => s.ready));
a.send({ t: 'start' });
for (let round = 1; round <= 2; round++) {
  const done = await a.until((r) => r.roundNo === round && (r.status === 'roundOver' || r.status === 'finished'));
  const res = done.game.result;
  console.log(`Round ${round}: ended by ${res.endedBy}, winner seat ${res.winner}, payouts ${res.payouts.join(',')}`);
  if (done.status === 'roundOver') b.send({ t: 'nextRound' });
}
const fin = await a.until((r) => r.status === 'finished');
console.log('Match finished, totals', fin.seats.map((s) => `${s.displayName}:${s.total}`).join(' '));
await new Promise((r) => setTimeout(r, 500));
const hist = await (await fetch(base + '/api/me/history', { headers: { Authorization: `Bearer ${a.token}` } })).json();
console.log(`History for Ana: ${hist.games.length} rounds saved, players: ${hist.games[0].players.map((p) => p.displayName).join(', ')}`);
const me = await (await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${a.token}` } })).json();
console.log(`Ana profile: ${me.profile.gamesPlayed} rounds, ${me.profile.chips} chips`);
for (const p of [a, b, c]) p.ws.close();
process.exit(hist.games.length === 2 ? 0 : 1);
