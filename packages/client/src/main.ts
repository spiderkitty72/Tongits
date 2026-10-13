import './style.css';
import { Action, CardId, DEFAULT_RULES, RuleSet } from '@tongits/engine';
import {
  AdminUser,
  ApiError,
  LeaderRow,
  ServerStats,
  GameSocket,
  HistoryEntry,
  OpenTable,
  Preset,
  Profile,
  RoomView,
  ServerInfo,
  ServerMessage,
  fetchInfo,
  http,
  normalizeServerUrl,
  store,
} from './api';
import { readRulesForm, rulesForm, rulesSummary } from './rulesForm';
import { TableUi, moves, renderTable } from './table';
import { adminHtml, adminUserHtml, contactHtml, leaderboardHtml } from './screens';
import { esc, timeAgo, toast } from './util';

type Screen = 'server' | 'auth' | 'home' | 'room' | 'profile' | 'leaderboard' | 'admin' | 'admin-user' | 'reset';

const state = {
  screen: 'server' as Screen,
  serverUrl: null as string | null,
  info: null as ServerInfo | null,
  token: null as string | null,
  profile: null as Profile | null,
  room: null as RoomView | null,
  tables: [] as OpenTable[],
  online: false,
  authMode: 'login' as 'login' | 'register' | 'forgot',
  /** The app was loaded from a Tong-its server, so it stays on that server. */
  hosted: false,
  forgotSent: false,
  /** Token from a password reset link. */
  resetToken: null as string | null,
  leaders: null as LeaderRow[] | null,
  leadersBy: 'chips' as 'chips' | 'wins',
  admin: {
    stats: null as ServerStats | null,
    users: null as AdminUser[] | null,
    query: '',
    user: null as { user: AdminUser; games: HistoryEntry[] } | null,
    reset: null as { link: string; expiresAt: string } | null,
  },
  history: null as HistoryEntry[] | null,
  presets: [] as Preset[],
  busy: false,
  menuOpen: false,
  ui: { selected: new Set<CardId>(), sort: 'rank', showLog: false } as TableUi,
  /** Room code from a share link, joined after login. */
  pendingRoom: null as string | null,
};

let socket: GameSocket | null = null;
let installPrompt: any = null;
const app = document.getElementById('app')!;

// ---------- Navigation ----------

function go(screen: Screen): void {
  state.screen = screen;
  state.menuOpen = false;
  render();
  window.scrollTo(0, 0);
}

function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return http<T>(state.serverUrl!, path, { method, body, token: state.token });
}

async function busy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    if (err instanceof ApiError && err.status === 401 && state.token) logout(false);
  } finally {
    state.busy = false;
    render();
  }
}

// ---------- Server choice ----------

async function chooseServer(raw: string): Promise<void> {
  await busy(async () => {
    const url = normalizeServerUrl(raw);
    const info = await fetchInfo(url);
    socket?.close();
    socket = null;
    state.serverUrl = url;
    state.info = info;
    state.room = null;
    store.rememberServer({ url, name: info.name });
    store.setCurrent(url);
    state.token = store.token(url);
    if (state.token) {
      try {
        const { profile } = await api<{ profile: Profile }>('/api/me');
        state.profile = profile;
        connect();
        go('home');
        return;
      } catch {
        store.setToken(url, null);
        state.token = null;
      }
    }
    state.authMode = info.signup === 'closed' ? 'login' : state.authMode;
    go('auth');
  });
}

function connect(): void {
  socket?.close();
  socket = new GameSocket(state.serverUrl!, state.token!, onMessage, (online) => {
    state.online = online;
    render();
  });
}

function onMessage(msg: ServerMessage): void {
  if (msg.t === 'hello') {
    state.profile = msg.profile;
    if (state.pendingRoom) {
      socket!.send({ t: 'join', code: state.pendingRoom });
      state.pendingRoom = null;
    }
  } else if (msg.t === 'room') {
    const before = state.room;
    state.room = msg.room;
    if (msg.room) {
      // Drop selections of cards that left the hand.
      const hand = new Set(msg.room.game?.hand ?? []);
      for (const c of [...state.ui.selected]) if (!hand.has(c)) state.ui.selected.delete(c);
      if (state.screen !== 'room' && (!before || before.code !== msg.room.code)) state.screen = 'room';
      if (msg.room.status === 'lobby' && msg.room.hostId === state.profile?.userId && state.presets.length === 0) loadPresets();
      if (before?.game?.turn !== msg.room.game?.turn && msg.room.game?.turn === msg.room.mySeat && msg.room.game?.phase === 'draw') {
        navigator.vibrate?.(60);
      }
    } else if (state.screen === 'room') {
      state.screen = 'home';
      refreshProfile();
    }
  } else if (msg.t === 'tables') {
    state.tables = msg.tables;
    // Only the home screen shows the list; skip re-rendering a game in progress.
    if (state.screen !== 'home') return;
  } else if (msg.t === 'error') {
    toast(msg.message, 'error');
  } else if (msg.t === 'authFailed') {
    logout(false);
    toast('Your login expired. Please log in again.', 'error');
    return;
  }
  render();
}

async function refreshProfile(): Promise<void> {
  try {
    state.profile = (await api<{ profile: Profile }>('/api/me')).profile;
    render();
  } catch {
    /* ignore; the next action will surface errors */
  }
}

async function loadLeaders(): Promise<void> {
  state.leaders = null;
  render();
  try {
    state.leaders = (await api<{ players: LeaderRow[] }>(`/api/leaderboard?by=${state.leadersBy}`)).players;
  } catch (err) {
    state.leaders = [];
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
  render();
}

async function loadAdmin(): Promise<void> {
  try {
    const [stats, users] = await Promise.all([
      api<ServerStats>('/api/admin/stats'),
      api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(state.admin.query)}`),
    ]);
    state.admin.stats = stats;
    state.admin.users = users.users;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
  render();
}

async function openAdminUser(id: number): Promise<void> {
  state.admin.user = null;
  state.admin.reset = null;
  go('admin-user');
  try {
    state.admin.user = await api<{ user: AdminUser; games: HistoryEntry[] }>(`/api/admin/users/${id}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
  render();
}

async function loadPresets(): Promise<void> {
  try {
    state.presets = (await api<{ presets: Preset[] }>('/api/me/presets')).presets;
    render();
  } catch {
    /* presets are optional */
  }
}

function logout(callServer = true): void {
  if (callServer && state.token) api('/api/logout', 'POST').catch(() => {});
  if (state.serverUrl) store.setToken(state.serverUrl, null);
  socket?.close();
  socket = null;
  state.token = null;
  state.profile = null;
  state.room = null;
  go('auth');
}

// ---------- Screens ----------

function header(title: string, back?: string): string {
  const backBtn = back ? `<button class="icon" data-action="${back}" aria-label="Back">←</button>` : '<span></span>';
  return `<header class="bar">${backBtn}<h1>${esc(title)}</h1><span class="conn ${state.online || !state.token ? 'ok' : 'off'}" title="${state.online ? 'Connected' : 'Reconnecting'}"></span></header>`;
}

/** The Tong-its wordmark: a small fan of cards and the name. */
const LOGO = `<span class="logo" role="img" aria-label="Tong-its"><svg class="logo-fan" viewBox="0 0 44 36" aria-hidden="true">
  <g transform="rotate(-18 22 34)"><rect x="12" y="4" width="18" height="26" rx="3" fill="#fffdf7" stroke="#0a3a24"/><text x="21" y="22" text-anchor="middle" font-size="13" fill="#1b1b1b">♠</text></g>
  <g><rect x="13" y="2" width="18" height="26" rx="3" fill="#fffdf7" stroke="#0a3a24"/><text x="22" y="20" text-anchor="middle" font-size="13" fill="#c62828">♥</text></g>
  <g transform="rotate(18 22 34)"><rect x="14" y="4" width="18" height="26" rx="3" fill="#fffdf7" stroke="#0a3a24"/><text x="23" y="22" text-anchor="middle" font-size="13" fill="#c62828">♦</text></g>
</svg><span class="logo-text">Tong-its</span></span>`;

/** The page bar with the logo in place of a title. */
function logoHeader(back?: string): string {
  const backBtn = back ? `<button class="icon" data-action="${back}" aria-label="Back">←</button>` : '<span></span>';
  return `<header class="bar logo-bar">${backBtn}<h1>${LOGO}</h1><span class="conn ${state.online || !state.token ? 'ok' : 'off'}" title="${state.online ? 'Connected' : 'Reconnecting'}"></span></header>`;
}

/** The server's name, shown small at the foot of the page. */
function serverFooter(): string {
  return state.info ? `<p class="server-name">${esc(state.info.name)}</p>` : '';
}

function serverScreen(): string {
  const saved = store.servers();
  const here = location.protocol.startsWith('http') ? location.origin + location.pathname.replace(/\/[^/]*$/, '') : '';
  const list = saved.length
    ? `<h3>Saved servers</h3><ul class="servers">${saved
        .map(
          (s) => `<li><button class="server-pick" data-action="pick-server" data-url="${esc(s.url)}"><strong>${esc(s.name)}</strong><small>${esc(s.url)}</small></button>
          <button class="icon" data-action="forget-server" data-url="${esc(s.url)}" aria-label="Forget ${esc(s.name)}">✕</button></li>`,
        )
        .join('')}</ul>`
    : '';
  return `<main class="page narrow">
    <div class="brand"><h1>${LOGO}</h1><p>Play with friends on any server.</p></div>
    <form id="server-form" class="card-box">
      <label>Server address<input name="url" type="text" inputmode="url" autocapitalize="off" spellcheck="false" autocomplete="url" placeholder="https://tongits.example.com" value="${esc(state.serverUrl ?? here)}" required></label>
      <button class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Connecting…' : 'Connect'}</button>
      <p class="muted small">Anyone can host a server. Ask the host for its address.</p>
    </form>
    ${list}
    ${installHint()}
  </main>`;
}

function authScreen(): string {
  const info = state.info!;
  const reg = state.authMode === 'register';
  const canRegister = info.signup !== 'closed';
  if (state.authMode === 'forgot') return forgotScreen(info);
  return `<main class="page narrow">
    ${logoHeader(state.hosted ? undefined : 'change-server')}
    ${canRegister ? `<div class="tabs"><button class="${reg ? '' : 'active'}" data-action="auth-mode" data-mode="login">Log in</button><button class="${reg ? 'active' : ''}" data-action="auth-mode" data-mode="register">Sign up</button></div>` : ''}
    <form id="auth-form" class="card-box">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}" required></label>
      ${reg ? `<label>Display name<input name="displayName" maxlength="24" autocomplete="nickname" required></label>` : ''}
      ${reg && info.signup === 'invite' ? `<label>Invite code<input name="inviteCode" autocomplete="off" required><small>This server is invite-only. Ask the host for the code.</small></label>` : ''}
      <button class="primary" ${state.busy ? 'disabled' : ''}>${reg ? 'Create account' : 'Log in'}</button>
      ${reg ? '' : '<button type="button" class="link-btn" data-action="auth-mode" data-mode="forgot">Forgot password?</button>'}
    </form>
    ${!canRegister ? '<p class="muted center">Sign-up is closed on this server.</p>' : ''}
    ${serverFooter()}
    <p class="muted center small">${esc(state.serverUrl!)} · ${info.playersOnline} online</p>
  </main>`;
}

function forgotScreen(info: ServerInfo): string {
  const body = state.forgotSent
    ? `<p>Thanks. The admin can see your request and will send you a link to choose a new password.</p>
       <p class="muted small">${contactHtml(info.adminContact)}</p>`
    : `<form id="forgot-form">
        <p class="muted small">Enter your account email. The admin will send you a link to choose a new password.</p>
        <label>Email<input name="email" type="email" autocomplete="email" required></label>
        <button class="primary" ${state.busy ? 'disabled' : ''}>Ask for a reset</button>
      </form>
      <p class="muted small">${contactHtml(info.adminContact)}</p>`;
  return `<main class="page narrow">
    ${logoHeader('back-to-login')}
    <section class="card-box"><h3>Forgot your password?</h3>${body}</section>
    ${serverFooter()}
  </main>`;
}

function resetScreen(): string {
  return `<main class="page narrow">
    ${logoHeader()}
    <form id="reset-form" class="card-box">
      <h3>Choose a new password</h3>
      <label>New password<input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
      <label>Type it again<input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="primary" ${state.busy ? 'disabled' : ''}>Save and log in</button>
    </form>
    ${serverFooter()}
  </main>`;
}

function homeScreen(): string {
  const p = state.profile!;
  return `<main class="page narrow">
    ${logoHeader()}
    <button class="profile-chip" data-action="open-profile"><span class="avatar big">${esc(p.avatar)}</span>
      <span><strong>${esc(p.displayName)}</strong><small>${p.chips} chips · ${p.wins} wins of ${p.gamesPlayed}</small></span><span>›</span></button>
    <div class="card-box">
      <button class="primary big" data-action="create-room" ${state.online ? '' : 'disabled'}>Create a room</button>
      <button class="big" data-action="play-bots" ${state.online ? '' : 'disabled'}>Play against computers</button>
      <form id="join-form" class="join">
        <input name="code" placeholder="Room code" maxlength="6" autocapitalize="characters" autocomplete="off" required aria-label="Room code">
        <button ${state.online ? '' : 'disabled'}>Join</button>
      </form>
      ${state.online ? '' : '<p class="muted small">Connecting to the server…</p>'}
    </div>
    ${openTablesHtml()}
    <div class="links">
      <button data-action="open-leaders">🏆 Leaderboard</button>
      <button data-action="open-profile">Profile and history</button>
      ${p.isAdmin ? '<button data-action="open-admin">Admin</button>' : ''}
      ${state.hosted ? '' : '<button data-action="change-server">Change server</button>'}
      <button data-action="logout">Log out</button>
    </div>
    ${installHint()}
    ${serverFooter()}
  </main>`;
}

/** The level last picked for a computer player, reused for new ones. */
function lastBotLevel(): string {
  try { return localStorage.getItem('tongits.botLevel') ?? 'normal'; } catch { return 'normal'; }
}

function openTablesHtml(): string {
  if (!state.online) return '';
  const rows = state.tables.map((t) => {
    const seated = t.status === 'lobby' && t.seatsFree > 0;
    const where = t.status === 'lobby' ? `${3 - t.seatsFree} of 3 seated` : 'Playing now';
    return `<li><span class="avatars">${t.players.map((p) => esc(p.avatar)).join('')}</span>
      <span class="who"><strong>${esc(t.host)}'s table</strong><small>${where} · ${esc(rulesSummary(t.rules))}</small></span>
      <button class="${seated ? 'primary' : ''}" data-action="join-table" data-code="${esc(t.code)}">${seated ? 'Join' : 'Watch'}</button></li>`;
  }).join('');
  return `<section class="card-box open-tables"><h3>Open tables</h3>
    ${rows ? `<ul class="tables">${rows}</ul>` : '<p class="muted small">No open tables right now. Create a room and tick “Open table” so anyone here can join.</p>'}
  </section>`;
}

const LEVEL_LABEL: Record<string, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

function lobbyScreen(room: RoomView): string {
  const meId = state.profile?.userId;
  const isHost = room.hostId === meId;
  const mySeat = room.mySeat;
  const seats = room.seats
    .map((s, i) =>
      s
        ? `<li class="${s.ready ? 'ready' : ''}"><span class="avatar">${esc(s.avatar)}</span><span class="who"><strong>${esc(s.displayName)}${s.userId === meId ? ' (you)' : ''}</strong>
            <small>${s.isBot ? (isHost ? 'Computer' : `Computer · ${LEVEL_LABEL[s.botLevel ?? 'normal']}`) : `${s.userId === room.hostId ? 'Host · ' : ''}${s.connected ? '' : 'Offline · '}${s.ready ? 'Ready' : 'Not ready'}`}</small></span>
            ${s.isBot && isHost ? `<select class="bot-level" data-seat="${i}" aria-label="Computer level">${Object.entries(LEVEL_LABEL).map(([v, l]) => `<option value="${v}" ${v === s.botLevel ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <button class="small-btn" data-action="remove-bot" data-seat="${i}" aria-label="Remove computer">✕</button>` : ''}</li>`
        : `<li class="empty"><span class="avatar">·</span><span class="who"><strong>Seat ${i + 1} open</strong><small>Share the code to invite</small></span>
            ${isHost ? `<button class="small-btn" data-action="add-bot" data-seat="${i}">Add computer</button>` : ''}</li>`,
    )
    .join('');
  const allIn = room.seats.every((s) => s && s.ready);
  const presetOpts = [`<option value="standard">Standard</option>`, ...state.presets.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)].join('');
  return `<main class="page">
    ${header('Lobby', 'leave')}
    <div class="lobby">
      <section class="card-box">
        <p class="muted">Room code</p>
        <div class="code-row"><span class="code">${esc(room.code)}</span><button data-action="share">Share invite</button></div>
        ${room.notice ? `<p class="notice">${esc(room.notice)}</p>` : ''}
        ${isHost
          ? `<label class="open-toggle"><input type="checkbox" id="open-table" ${room.isOpen ? 'checked' : ''}> Open table <small class="muted">Anyone on this server can see and join it</small></label>`
          : room.isOpen ? '<p class="muted small">This is an open table: anyone on the server can join.</p>' : ''}
        <ul class="seats">${seats}</ul>
        ${room.spectators ? `<p class="muted small">${room.spectators} watching</p>` : ''}
        <div class="lobby-actions">
          ${mySeat >= 0 ? `<button class="${room.seats[mySeat]?.ready ? '' : 'primary'}" data-action="ready">${room.seats[mySeat]?.ready ? 'Not ready' : "I'm ready"}</button>` : '<p class="muted">The room is full; you are watching.</p>'}
          ${isHost ? `<button class="primary" data-action="start" ${allIn ? '' : 'disabled'}>Start game</button>` : ''}
        </div>
        ${isHost && !allIn ? '<p class="muted small">Start unlocks when three players are ready. Fill an empty seat with Add computer to play with fewer people.</p>' : ''}
      </section>
      <section class="card-box">
        <div class="rules-head"><h3>House rules</h3>
          ${isHost ? `<span class="preset"><select id="preset-select" aria-label="Rule preset">${presetOpts}</select><button data-action="save-preset">Save as…</button></span>` : `<small class="muted">Set by the host</small>`}</div>
        <p class="muted small">${esc(rulesSummary(room.rules))}</p>
        ${rulesForm(room.rules, isHost)}
      </section>
    </div>
  </main>`;
}

function profileScreen(): string {
  const p = state.profile!;
  const avatars = (state.info?.avatars ?? []).map((a) => `<button class="avatar-pick ${a === p.avatar ? 'active' : ''}" data-action="avatar" data-avatar="${a}">${a}</button>`).join('');
  const games = state.history;
  const rows = games === null
    ? '<p class="muted">Loading…</p>'
    : games.length === 0
      ? '<p class="muted">No games yet.</p>'
      : `<ul class="history">${games
          .map(
            (g) => `<li class="${g.won ? 'won' : ''}"><div class="h-top"><strong>${g.won ? 'Won' : 'Lost'}</strong>
              <span class="${g.chipsDelta >= 0 ? 'plus' : 'minus'}">${g.chipsDelta > 0 ? '+' : ''}${g.chipsDelta}</span>
              <small>${timeAgo(g.endedAt)} · ${({ tongits: 'Tong-its', draw: 'Draw', stockOut: 'Stock out' } as Record<string, string>)[g.endedBy] ?? esc(g.endedBy)} · Room ${esc(g.roomCode)} round ${g.roundNo}</small></div>
              <div class="h-players">${g.players.map((x) => `<span class="${x.winner ? 'win' : ''}">${esc(x.displayName)} ${x.points}pts${x.burned ? ' 🔥' : ''}</span>`).join('')}</div></li>`,
          )
          .join('')}</ul>`;
  return `<main class="page narrow">
    ${header('Profile', 'home')}
    <section class="card-box profile">
      <div class="profile-top"><span class="avatar huge">${esc(p.avatar)}</span>
        <form id="name-form" class="join"><input name="displayName" value="${esc(p.displayName)}" maxlength="24" aria-label="Display name"><button>Save</button></form></div>
      <div class="avatars">${avatars}</div>
      <div class="stats">
        <div><strong>${p.chips}</strong><small>Chips</small></div>
        <div><strong>${p.gamesPlayed}</strong><small>Rounds</small></div>
        <div><strong>${p.wins}</strong><small>Wins</small></div>
        <div><strong>${p.tongitsWins}</strong><small>Tong-its</small></div>
        <div><strong>${p.timesBurned}</strong><small>Burned</small></div>
      </div>
      <p class="muted small">${esc(p.email)}</p>
    </section>
    <h3>Game history</h3>
    ${rows}
  </main>`;
}

function installHint(): string {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;
  if (standalone) return '';
  if (installPrompt) return '<div class="install"><button data-action="install">Install the app</button></div>';
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
    return '<p class="install muted small">To install on iPhone or iPad: tap Share, then “Add to Home Screen”.</p>';
  }
  return '';
}

function menu(): string {
  if (!state.menuOpen) return '';
  const room = state.room;
  const inMatch = room && room.mySeat >= 0 && (room.status === 'playing' || room.status === 'roundOver');
  return `<div class="overlay" data-action="close-menu"><div class="sheet menu" data-stop>
    <h3>Rules for this game</h3><p class="muted small">${room ? esc(rulesSummary(room.rules)) : ''}</p>
    ${room ? rulesForm(room.rules, false) : ''}
    <div class="sheet-actions">
      ${room ? `<button data-action="leave">${inMatch ? 'Leave match' : 'Leave room'}</button>` : ''}
      ${inMatch ? '<p class="muted small">Leaving ends the match for everyone. Finished rounds still count.</p>' : ''}
      <button class="primary" data-action="close-menu">Close</button>
    </div></div></div>`;
}

function render(): void {
  // Keep focus and typed text in inputs across re-renders.
  const active = document.activeElement as HTMLInputElement | null;
  const keep = active && active.name && active.form ? { form: active.form.id, name: active.name, value: active.value } : null;

  let html = '';
  if (state.screen === 'server' || !state.info) html = serverScreen();
  else if (state.screen === 'reset') html = resetScreen();
  else if (state.screen === 'auth' || !state.profile) html = authScreen();
  else if (state.screen === 'profile') html = profileScreen();
  else if (state.screen === 'leaderboard') {
    html = `<main class="page narrow">${header('Leaderboard', 'home')}${leaderboardHtml(state.leaders, state.leadersBy, state.profile.userId)}</main>`;
  } else if (state.screen === 'admin' && state.profile.isAdmin) {
    html = `<main class="page narrow">${header('Admin', 'home')}${adminHtml(state.admin.stats, state.admin.users, state.admin.query)}</main>`;
  } else if (state.screen === 'admin-user' && state.profile.isAdmin) {
    html = `<main class="page narrow">${header('Player', 'open-admin')}${adminUserHtml(state.admin.user, state.profile.userId, state.admin.reset)}</main>`;
  } else if (state.screen === 'room' && state.room) {
    html = state.room.status === 'lobby' ? lobbyScreen(state.room) : renderTable(state.room, state.ui);
  } else html = homeScreen();
  app.innerHTML = html + menu();

  if (keep) {
    const el = document.querySelector<HTMLInputElement>(`#${keep.form} [name="${keep.name}"]`);
    if (el) {
      el.value = keep.value;
      el.focus();
    }
  }
  tickTimers();
}

function tickTimers(): void {
  document.querySelectorAll<HTMLElement>('.timer[data-deadline]').forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000));
    el.textContent = `${left}s`;
    el.classList.toggle('low', left <= 10);
  });
}
setInterval(tickTimers, 500);

// ---------- Events ----------

function send(action: Action): void {
  socket?.send({ t: 'act', action });
  state.ui.selected.clear();
}

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  if (el.dataset.action === 'close-menu' && target.closest('[data-stop]') && el.classList.contains('overlay')) return;
  const room = state.room;
  const g = room?.game;
  const sel = [...state.ui.selected];
  switch (el.dataset.action) {
    case 'pick-server':
      chooseServer(el.dataset.url!);
      break;
    case 'forget-server':
      store.forgetServer(el.dataset.url!);
      render();
      break;
    case 'change-server':
      socket?.close();
      socket = null;
      state.info = null;
      state.profile = null;
      state.room = null;
      go('server');
      break;
    case 'auth-mode':
      state.authMode = el.dataset.mode as typeof state.authMode;
      state.forgotSent = false;
      render();
      break;
    case 'back-to-login':
      state.authMode = 'login';
      render();
      break;
    case 'open-leaders':
      go('leaderboard');
      loadLeaders();
      break;
    case 'leaders-by':
      state.leadersBy = el.dataset.by === 'wins' ? 'wins' : 'chips';
      loadLeaders();
      break;
    case 'open-admin':
      state.admin.user = null;
      state.admin.reset = null;
      go('admin');
      loadAdmin();
      break;
    case 'admin-user':
      openAdminUser(Number(el.dataset.id));
      break;
    case 'make-reset': {
      const u = state.admin.user?.user;
      if (!u) break;
      busy(async () => {
        const r = await api<{ token: string; expiresAt: string }>(`/api/admin/users/${u.userId}/reset`, 'POST');
        const base = `${location.origin}${location.pathname}`;
        const link = `${base}?${state.hosted ? '' : `server=${encodeURIComponent(state.serverUrl!)}&`}reset=${encodeURIComponent(r.token)}`;
        state.admin.reset = { link, expiresAt: r.expiresAt };
      });
      break;
    }
    case 'copy-reset':
      if (state.admin.reset) navigator.clipboard?.writeText(state.admin.reset.link).then(() => toast('Link copied.'), () => toast('Copy it from the box.', 'error'));
      break;
    case 'share-reset':
      if (state.admin.reset) navigator.share?.({ title: 'Reset your Tong-its password', url: state.admin.reset.link }).catch(() => {});
      break;
    case 'delete-user': {
      const u = state.admin.user?.user;
      if (!u || !confirm(`Delete ${u.displayName}'s account? Their finished games stay in other players' history. This cannot be undone.`)) break;
      busy(async () => {
        await api(`/api/admin/users/${u.userId}`, 'DELETE');
        toast('Account deleted.');
        state.admin.user = null;
        state.screen = 'admin';
        loadAdmin();
      });
      break;
    }
    case 'logout':
      logout();
      break;
    case 'home':
      go('home');
      break;
    case 'open-profile':
      state.history = null;
      go('profile');
      api<{ games: HistoryEntry[] }>('/api/me/history').then((r) => {
        state.history = r.games;
        render();
      });
      refreshProfile();
      break;
    case 'avatar':
      busy(async () => {
        state.profile = (await api<{ profile: Profile }>('/api/me', 'PUT', { avatar: el.dataset.avatar })).profile;
      });
      break;
    case 'create-room':
      socket?.send({ t: 'create' });
      break;
    case 'play-bots':
      socket?.send({ t: 'create', bots: 2, level: lastBotLevel() });
      break;
    case 'add-bot':
      socket?.send({ t: 'addBot', seat: Number(el.dataset.seat), level: lastBotLevel() });
      break;
    case 'remove-bot':
      socket?.send({ t: 'removeBot', seat: Number(el.dataset.seat) });
      break;
    case 'leave':
      if (room && room.mySeat >= 0 && (room.status === 'playing' || room.status === 'roundOver') &&
        !confirm('Leave the match? It ends for everyone, and finished rounds still count.')) break;
      socket?.send({ t: 'leave' });
      state.menuOpen = false;
      break;
    case 'share': {
      const link = `${location.origin}${location.pathname}?server=${encodeURIComponent(state.serverUrl!)}&room=${room!.code}`;
      const text = `Join my Tong-its game: room ${room!.code}`;
      if (navigator.share) navigator.share({ title: 'Tong-its', text, url: link }).catch(() => {});
      else navigator.clipboard?.writeText(`${text} ${link}`).then(() => toast('Invite link copied.'));
      break;
    }
    case 'join-table':
      socket?.send({ t: 'join', code: el.dataset.code! });
      break;
    case 'ready':
      socket?.send({ t: 'ready', ready: !room!.seats[room!.mySeat]?.ready });
      break;
    case 'start':
      socket?.send({ t: 'start' });
      break;
    case 'save-preset': {
      const name = prompt('Name for these house rules:');
      if (name) busy(async () => {
        state.presets = (await api<{ presets: Preset[] }>('/api/me/presets', 'POST', { name, rules: room!.rules })).presets;
        toast('Rules saved to your profile.');
      });
      break;
    }
    case 'select': {
      const c = el.dataset.card!;
      if (state.ui.selected.has(c)) state.ui.selected.delete(c);
      else state.ui.selected.add(c);
      render();
      break;
    }
    case 'sort':
      state.ui.sort = state.ui.sort === 'rank' ? 'suit' : 'rank';
      render();
      break;
    case 'toggle-log':
      state.ui.showLog = !state.ui.showLog;
      render();
      break;
    case 'menu':
      state.menuOpen = true;
      render();
      break;
    case 'close-menu':
      state.menuOpen = false;
      render();
      break;
    case 'draw-stock':
      send({ type: 'drawStock' });
      break;
    case 'pick-discard': {
      if (!g) break;
      const m = moves(g, state.ui);
      if (m.canPickDiscard) send({ type: 'pickDiscard', cards: sel });
      else if (m.discardPairs.length === 1) send({ type: 'pickDiscard', cards: m.discardPairs[0] });
      else if (m.discardPairs.length > 1) {
        // Several ways to use it: preselect the first and let the player adjust.
        state.ui.selected = new Set(m.discardPairs[0]);
        render();
        toast('Selected cards that meld with the discard. Change them if you like, then tap Take discard.');
      } else toast('The top discard does not make a meld with your cards.');
      break;
    }
    case 'meld':
      send({ type: 'meld', cards: sel });
      break;
    case 'sapaw':
      send({ type: 'sapaw', cards: sel, meldId: el.dataset.meld! });
      break;
    case 'discard':
      send({ type: 'discard', card: sel[0] });
      break;
    case 'call-draw':
      if (confirm('Call Draw? Everyone with a meld may fight; lowest hand wins.')) send({ type: 'callDraw' });
      break;
    case 'fight':
      send({ type: 'respondDraw', fight: true });
      break;
    case 'fold':
      send({ type: 'respondDraw', fight: false });
      break;
    case 'next-round':
      socket?.send({ t: 'nextRound' });
      break;
    case 'play-again':
      socket?.send({ t: 'playAgain' });
      break;
    case 'install':
      installPrompt?.prompt();
      installPrompt = null;
      render();
      break;
  }
});

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  if (form.id === 'server-form') chooseServer(data.url);
  if (form.id === 'auth-form') {
    busy(async () => {
      const path = state.authMode === 'register' ? '/api/register' : '/api/login';
      const res = await http<{ token: string; profile: Profile }>(state.serverUrl!, path, { method: 'POST', body: data });
      state.token = res.token;
      state.profile = res.profile;
      store.setToken(state.serverUrl!, res.token);
      connect();
      state.screen = 'home';
    });
  }
  if (form.id === 'forgot-form') {
    busy(async () => {
      await http(state.serverUrl!, '/api/password/forgot', { method: 'POST', body: { email: data.email } });
      state.forgotSent = true;
    });
  }
  if (form.id === 'reset-form') {
    if (data.password !== data.confirm) {
      toast('The two passwords are different.', 'error');
      return;
    }
    busy(async () => {
      const res = await http<{ token: string; profile: Profile }>(state.serverUrl!, '/api/password/reset', {
        method: 'POST',
        body: { token: state.resetToken, password: data.password },
      });
      state.resetToken = null;
      state.token = res.token;
      state.profile = res.profile;
      store.setToken(state.serverUrl!, res.token);
      connect();
      state.screen = 'home';
      toast('Password changed. You are logged in.');
    });
  }
  if (form.id === 'admin-edit') {
    const u = state.admin.user?.user;
    if (!u) return;
    const box = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
    if (box('disabled') && !u.disabled && !confirm(`Turn off ${u.displayName}'s account? They are logged out and cannot log in until you turn it back on.`)) return;
    busy(async () => {
      state.admin.user = await api(`/api/admin/users/${u.userId}`, 'PUT', {
        displayName: data.displayName,
        chips: Number(data.chips),
        isAdmin: box('isAdmin'),
        disabled: box('disabled'),
      });
      toast('Saved.');
    });
  }
  if (form.id === 'admin-search') loadAdmin();
  if (form.id === 'join-form') {
    socket?.send({ t: 'join', code: data.code.toUpperCase().trim() });
  }
  if (form.id === 'name-form') {
    busy(async () => {
      state.profile = (await api<{ profile: Profile }>('/api/me', 'PUT', { displayName: data.displayName })).profile;
      toast('Name saved.');
    });
  }
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
app.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.form?.id !== 'admin-search') return;
  state.admin.query = el.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadAdmin, 250);
});

app.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  const room = state.room;
  if (!room) return;
  if (el.classList.contains('bot-level')) {
    const level = (el as HTMLSelectElement).value;
    try { localStorage.setItem('tongits.botLevel', level); } catch { /* private mode */ }
    socket?.send({ t: 'botLevel', seat: Number(el.dataset.seat), level });
    return;
  }
  if (el.id === 'open-table') {
    socket?.send({ t: 'open', open: (el as HTMLInputElement).checked });
    return;
  }
  if (el.id === 'preset-select') {
    const v = (el as HTMLSelectElement).value;
    const rules: RuleSet = v === 'standard' ? DEFAULT_RULES : (state.presets.find((p) => String(p.id) === v)?.rules ?? DEFAULT_RULES);
    socket?.send({ t: 'rules', rules });
    return;
  }
  const form = el.closest<HTMLFormElement>('#rules-form');
  if (form && room.hostId === state.profile?.userId && !state.menuOpen) {
    socket?.send({ t: 'rules', rules: readRulesForm(form, room.rules) });
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') socket?.nudge();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  render();
});

// ---------- Start ----------

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const linkServer = params.get('server');
  state.pendingRoom = params.get('room');
  state.resetToken = params.get('reset');
  if (linkServer || state.pendingRoom || state.resetToken) history.replaceState(null, '', location.pathname);

  render();
  // When the app is served by a Tong-its server it always uses that server.
  // Only a copy hosted elsewhere (or a dev build) lets the player pick one.
  if (location.protocol.startsWith('http')) {
    try {
      const here = location.origin;
      await fetchInfo(here);
      state.hosted = true;
      await chooseServer(here);
    } catch {
      /* static hosting: fall through to the saved or linked server */
    }
  }
  if (!state.hosted) {
    const candidate = linkServer ?? store.current();
    if (candidate) await chooseServer(candidate);
  }
  if (state.resetToken && state.info) go('reset');
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
