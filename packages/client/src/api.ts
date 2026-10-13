import type { Action, PlayerView, RuleSet } from '@tongits/engine';

export const PROTOCOL_VERSION = 1;

export interface ServerInfo {
  app: string;
  name: string;
  version: string;
  protocol: number;
  signup: 'open' | 'invite' | 'closed';
  playersOnline: number;
  rooms: number;
  avatars: string[];
  defaultRules: RuleSet;
}

export interface Profile {
  userId: number;
  email: string;
  displayName: string;
  avatar: string;
  chips: number;
  gamesPlayed: number;
  wins: number;
  tongitsWins: number;
  timesBurned: number;
}

export interface SeatView {
  userId: number;
  displayName: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  /** Current chip balance. */
  chips: number;
  /** Chips won or lost so far in this match. */
  total: number;
  /** A computer player. */
  isBot: boolean;
}

export interface RoomView {
  code: string;
  hostId: number;
  mySeat: number;
  seats: (SeatView | null)[];
  spectators: number;
  rules: RuleSet;
  status: 'lobby' | 'playing' | 'roundOver' | 'finished';
  roundNo: number;
  game: PlayerView | null;
  turnDeadline: number | null;
  notice: string | null;
  isOpen: boolean;
}

export interface OpenTable {
  code: string;
  host: string;
  players: { displayName: string; avatar: string }[];
  seatsFree: number;
  status: RoomView['status'];
  rules: RuleSet;
}

export interface HistoryEntry {
  gameId: number;
  endedAt: string;
  endedBy: string;
  roomCode: string;
  roundNo: number;
  chipsDelta: number;
  won: boolean;
  players: { seat: number; displayName: string; points: number; burned: boolean; chipsDelta: number; winner: boolean }[];
}

export interface Preset {
  id: number;
  name: string;
  rules: RuleSet;
}

// ---------- Saved servers and logins (per device) ----------

const KEY_SERVERS = 'tongits.servers';
const KEY_CURRENT = 'tongits.currentServer';
const tokenKey = (url: string) => `tongits.token:${url}`;

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode); the app still works for this session */
  }
}

export interface SavedServer {
  url: string;
  name: string;
}

export const store = {
  servers: () => load<SavedServer[]>(KEY_SERVERS, []),
  rememberServer(s: SavedServer) {
    const list = store.servers().filter((x) => x.url !== s.url);
    save(KEY_SERVERS, [s, ...list].slice(0, 10));
  },
  forgetServer(url: string) {
    save(KEY_SERVERS, store.servers().filter((x) => x.url !== url));
    save(tokenKey(url), null);
  },
  current: () => load<string | null>(KEY_CURRENT, null),
  setCurrent: (url: string | null) => save(KEY_CURRENT, url),
  token: (url: string) => load<string | null>(tokenKey(url), null),
  setToken: (url: string, token: string | null) => save(tokenKey(url), token),
};

/** Accepts "tongits.example.com", "http://192.168.1.5:8080/" etc. and returns a clean origin URL. */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error('Enter a server address.');
  if (!/^https?:\/\//i.test(s)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s);
    s = `${local ? 'http' : 'https'}://${s}`;
  }
  const u = new URL(s);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------- HTTP ----------

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function http<T>(base: string, path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Could not reach ${base}. Check the address and your connection.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Server error (${res.status}).`);
  return data as T;
}

export async function fetchInfo(base: string): Promise<ServerInfo> {
  const info = await http<ServerInfo>(base, '/api/info');
  if (info.app !== 'tongits') throw new ApiError(0, 'That address is not a Tong-its server.');
  if (info.protocol !== PROTOCOL_VERSION) {
    throw new ApiError(0, `That server runs a different version (${info.version}) that this app cannot talk to.`);
  }
  return info;
}

// ---------- Live game connection ----------

export type ServerMessage =
  | { t: 'hello'; profile: Profile }
  | { t: 'room'; room: RoomView | null }
  | { t: 'tables'; tables: OpenTable[] }
  | { t: 'error'; message: string }
  | { t: 'authFailed' };

export type ClientMessage =
  | { t: 'create'; bots?: number }
  | { t: 'addBot'; seat?: number }
  | { t: 'removeBot'; seat: number }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'open'; open: boolean }
  | { t: 'rules'; rules: RuleSet }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'act'; action: Action }
  | { t: 'nextRound' }
  | { t: 'playAgain' };

/** A WebSocket that logs in with the session token and reconnects with backoff. */
export class GameSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private queue: ClientMessage[] = [];
  online = false;

  constructor(
    private base: string,
    private token: string,
    private onMessage: (m: ServerMessage) => void,
    private onStatus: (online: boolean) => void,
  ) {
    this.open();
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = this.base.replace(/^http/i, 'ws') + '/ws';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ t: 'auth', token: this.token, protocol: PROTOCOL_VERSION }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.t === 'hello') {
        this.online = true;
        this.onStatus(true);
        for (const q of this.queue.splice(0)) ws.send(JSON.stringify(q));
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      this.online = false;
      this.onStatus(false);
      if (this.closed) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.open(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.online && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  /** Reconnect right away (e.g. when the app returns to the foreground). */
  nudge(): void {
    if (!this.closed && this.ws?.readyState === WebSocket.CLOSED) {
      this.retry = 0;
      this.open();
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
