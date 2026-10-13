import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_RULES, GameError, normalizeRules } from '@tongits/engine';
import { config, PROTOCOL_VERSION, SERVER_VERSION } from './config.js';
import { migrate, pool, waitForDb } from './db.js';
import {
  createSession,
  deleteSession,
  hashPassword,
  rateLimited,
  userForToken,
  validEmail,
  verifyPassword,
} from './auth.js';
import {
  AVATARS,
  cleanDisplayName,
  deletePreset,
  getHistory,
  getProfile,
  listPresets,
  savePreset,
  updateProfile,
} from './profiles.js';
import { Room, RoomManager } from './rooms.js';

// ---------- WebSocket clients ----------

interface Client {
  ws: WebSocket;
  userId: number | null;
}
const clients = new Set<Client>();

function connected(userId: number): boolean {
  for (const c of clients) if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) return true;
  return false;
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const rooms = new RoomManager(connected, (userId: number, room: Room | null) => {
  for (const c of clients) {
    if (c.userId !== userId) continue;
    send(c.ws, { t: 'room', room: room ? rooms.view(room, userId) : null });
  }
});

// ---------- HTTP helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function corsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

async function requireUser(req: http.IncomingMessage): Promise<number> {
  const userId = await userForToken(bearer(req));
  if (!userId) throw new HttpError(401, 'Please log in.');
  return userId;
}

function clientIp(req: http.IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
}

// ---------- API ----------

async function api(req: http.IncomingMessage, res: http.ServerResponse, route: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (route === '/api/info' && method === 'GET') {
    const online = new Set([...clients].map((c) => c.userId).filter((u) => u !== null)).size;
    return json(req, res, 200, {
      app: 'tongits',
      name: config.serverName,
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      signup: config.signupMode,
      playersOnline: online,
      rooms: rooms.rooms.size,
      avatars: AVATARS,
      defaultRules: DEFAULT_RULES,
    });
  }

  if (route === '/api/register' && method === 'POST') {
    if (rateLimited(`reg:${clientIp(req)}`, 10)) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (config.signupMode === 'closed') throw new HttpError(403, 'Sign-up is closed on this server.');
    const body = await readBody(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const displayName = cleanDisplayName(body.displayName);
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (!displayName) throw new HttpError(400, 'Display name must be 1 to 24 characters.');
    if (config.signupMode === 'invite' && (!config.inviteCode || body.inviteCode !== config.inviteCode)) {
      throw new HttpError(403, 'That invite code is not right. Ask the server host for it.');
    }
    const hash = await hashPassword(password);
    const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
    const client = await pool.connect();
    let userId: number;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
        [email, hash],
      );
      if (!rows[0]) throw new HttpError(409, 'An account with that email already exists.');
      userId = rows[0].id;
      await client.query('INSERT INTO profiles (user_id, display_name, avatar, chips) VALUES ($1, $2, $3, $4)', [
        userId,
        displayName,
        avatar,
        config.startingChips,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const token = await createSession(userId);
    return json(req, res, 201, { token, profile: await getProfile(userId) });
  }

  if (route === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (rateLimited(`login:${clientIp(req)}`, 30) || rateLimited(`login:${email}`, 10)) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    }
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    const ok = rows[0] && (await verifyPassword(String(body.password ?? ''), rows[0].password_hash));
    if (!ok) throw new HttpError(401, 'Email or password is wrong.');
    const token = await createSession(rows[0].id);
    return json(req, res, 200, { token, profile: await getProfile(rows[0].id) });
  }

  if (route === '/api/logout' && method === 'POST') {
    const token = bearer(req);
    if (token) await deleteSession(token);
    return json(req, res, 200, { ok: true });
  }

  if (route === '/api/me' && method === 'GET') {
    const userId = await requireUser(req);
    return json(req, res, 200, { profile: await getProfile(userId) });
  }

  if (route === '/api/me' && method === 'PUT') {
    const userId = await requireUser(req);
    const body = await readBody(req);
    const name = body.displayName === undefined ? undefined : cleanDisplayName(body.displayName);
    if (name === null) throw new HttpError(400, 'Display name must be 1 to 24 characters.');
    if (body.avatar !== undefined && !AVATARS.includes(body.avatar)) throw new HttpError(400, 'Unknown avatar.');
    await updateProfile(userId, name, body.avatar);
    return json(req, res, 200, { profile: await getProfile(userId) });
  }

  if (route === '/api/me/history' && method === 'GET') {
    const userId = await requireUser(req);
    return json(req, res, 200, { games: await getHistory(userId) });
  }

  if (route === '/api/me/presets' && method === 'GET') {
    const userId = await requireUser(req);
    return json(req, res, 200, { presets: await listPresets(userId) });
  }

  if (route === '/api/me/presets' && method === 'POST') {
    const userId = await requireUser(req);
    const body = await readBody(req);
    const name = String(body.name ?? '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Give the preset a name.');
    await savePreset(userId, name, normalizeRules(body.rules));
    return json(req, res, 200, { presets: await listPresets(userId) });
  }

  const del = /^\/api\/me\/presets\/(\d+)$/.exec(route);
  if (del && method === 'DELETE') {
    const userId = await requireUser(req);
    await deletePreset(userId, Number(del[1]));
    return json(req, res, 200, { presets: await listPresets(userId) });
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- Static client ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, route: string): void {
  const root = config.publicDir;
  let file = path.normalize(path.join(root, decodeURIComponent(route)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Client not built. Run npm run build.');
    return;
  }
  const ext = path.extname(file);
  const hashed = /\/assets\//.test(file);
  const noCache = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : noCache ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  if (route.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req)).end();
      return;
    }
    try {
      await api(req, res, route);
    } catch (err) {
      if (err instanceof HttpError) json(req, res, err.status, { error: err.message });
      else {
        console.error(err);
        json(req, res, 500, { error: 'Something went wrong on the server.' });
      }
    }
    return;
  }
  if (route === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }
  serveStatic(req, res, route);
});

// ---------- WebSocket game channel ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  const client: Client = { ws, userId: null };
  clients.add(client);
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30000);

  ws.on('message', async (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(ws, { t: 'error', message: 'Bad message.' });
    }
    try {
      if (msg.t === 'auth') {
        const userId = await userForToken(msg.token);
        if (!userId) return send(ws, { t: 'authFailed' });
        const profile = await getProfile(userId);
        if (msg.protocol !== PROTOCOL_VERSION) {
          return send(ws, { t: 'error', message: 'This app version does not match the server. Reload the page.' });
        }
        client.userId = userId;
        send(ws, { t: 'hello', profile });
        rooms.refresh(userId);
        return;
      }
      const userId = client.userId;
      if (!userId) return send(ws, { t: 'authFailed' });
      const member = async () => {
        const p = (await getProfile(userId))!;
        return { userId, displayName: p.displayName, avatar: p.avatar, chips: p.chips };
      };
      switch (msg.t) {
        case 'create':
          rooms.create(await member());
          break;
        case 'join':
          rooms.join(await member(), msg.code);
          break;
        case 'leave':
          rooms.leave(userId);
          break;
        case 'rules':
          rooms.setRules(userId, msg.rules);
          break;
        case 'ready':
          rooms.setReady(userId, !!msg.ready);
          break;
        case 'start':
          rooms.start(userId);
          break;
        case 'act':
          rooms.act(userId, msg.action);
          break;
        case 'nextRound':
          rooms.nextRound(userId);
          break;
        case 'playAgain':
          rooms.playAgain(userId);
          break;
        default:
          send(ws, { t: 'error', message: 'Unknown message.' });
      }
    } catch (err) {
      if (err instanceof GameError) send(ws, { t: 'error', message: err.message });
      else {
        console.error(err);
        send(ws, { t: 'error', message: 'Something went wrong on the server.' });
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
    if (client.userId) {
      const room = rooms.roomOf(client.userId);
      if (room) rooms.refresh(client.userId);
    }
  });
});

async function main(): Promise<void> {
  await waitForDb();
  await migrate();
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  server.listen(config.port, () => {
    console.log(`${config.serverName} listening on :${config.port} (sign-up: ${config.signupMode})`);
    if (config.signupMode === 'invite' && !config.inviteCode) {
      console.warn('SIGNUP_MODE is invite but INVITE_CODE is empty, so nobody can sign up. Set INVITE_CODE.');
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
