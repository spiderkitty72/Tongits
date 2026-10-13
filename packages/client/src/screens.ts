// Leaderboard, admin and password screens. Pure HTML builders; main.ts owns state and events.
import type { AdminUser, HistoryEntry, LeaderRow, ServerStats } from './api';
import { esc, timeAgo } from './util';

const MEDAL = ['🥇', '🥈', '🥉'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function leaderboardHtml(rows: LeaderRow[] | null, by: 'chips' | 'wins', meId: number | undefined): string {
  const tabs = `<div class="tabs"><button class="${by === 'chips' ? 'active' : ''}" data-action="leaders-by" data-by="chips">Most chips</button>
    <button class="${by === 'wins' ? 'active' : ''}" data-action="leaders-by" data-by="wins">Most wins</button></div>`;
  if (rows === null) return `${tabs}<p class="muted center">Loading…</p>`;
  if (rows.length === 0) return `${tabs}<p class="muted center">Nobody has finished a round yet. Play one to get on the board.</p>`;
  const list = rows
    .map((r, i) => {
      const rate = r.gamesPlayed ? Math.round((r.wins / r.gamesPlayed) * 100) : 0;
      const main = by === 'wins' ? plural(r.wins, 'win') : plural(r.chips, 'chip');
      const sub = by === 'wins' ? `${plural(r.chips, 'chip')} · ${rate}% of ${plural(r.gamesPlayed, 'round')}` : `${plural(r.wins, 'win')} of ${plural(r.gamesPlayed, 'round')}`;
      return `<li class="${r.userId === meId ? 'me' : ''}"><span class="rank-no">${MEDAL[i] ?? i + 1}</span>
        <span class="avatar">${esc(r.avatar)}</span>
        <span class="who"><strong>${esc(r.displayName)}${r.userId === meId ? ' (you)' : ''}</strong><small>${sub}${r.tongitsWins ? ` · ${r.tongitsWins} Tong-its` : ''}</small></span>
        <span class="score">${main}</span></li>`;
    })
    .join('');
  return `${tabs}<ol class="leaders">${list}</ol>`;
}

function stat(value: number | string, label: string): string {
  return `<div><strong>${value}</strong><small>${label}</small></div>`;
}

function badges(u: AdminUser): string {
  return [
    u.online ? '<span class="badge on">Online</span>' : '',
    u.isAdmin ? '<span class="badge">Admin</span>' : '',
    u.disabled ? '<span class="badge off">Turned off</span>' : '',
    u.resetRequestedAt ? '<span class="badge warn">Wants a reset</span>' : '',
  ].join('');
}

export function adminHtml(stats: ServerStats | null, users: AdminUser[] | null, query: string): string {
  const s = stats;
  const grid = s
    ? `<div class="stats admin-stats">
        ${stat(s.online, 'Online now')}${stat(s.playing, 'Games on')}${stat(s.accounts, 'Accounts')}
        ${stat(s.activeThisWeek, 'Active this week')}${stat(s.newThisWeek, 'New this week')}${stat(s.roundsToday, 'Rounds today')}
        ${stat(s.roundsPlayed, 'Rounds ever')}${stat(s.chipsInPlay, 'Chips held')}${stat(s.resetRequests, 'Reset requests')}
      </div>`
    : '<p class="muted">Loading…</p>';
  const list =
    users === null
      ? '<p class="muted">Loading…</p>'
      : users.length === 0
        ? '<p class="muted">No players match.</p>'
        : `<ul class="people">${users
            .map(
              (u) => `<li><button data-action="admin-user" data-id="${u.userId}"><span class="avatar">${esc(u.avatar)}</span>
              <span class="who"><strong>${esc(u.displayName)}</strong><small>${esc(u.email)}</small>
                <small>${u.chips} chips · ${u.wins}/${u.gamesPlayed} won · ${u.lastSeen ? `seen ${timeAgo(u.lastSeen)}` : 'never played'}</small>
                <span class="badges">${badges(u)}</span></span><span>›</span></button></li>`,
            )
            .join('')}</ul>`;
  return `<section class="card-box">${grid}</section>
    <form id="admin-search" class="join" role="search"><input name="q" type="search" value="${esc(query)}" placeholder="Search name or email" aria-label="Search players" autocomplete="off"></form>
    ${list}`;
}

export function adminUserHtml(
  data: { user: AdminUser; games: HistoryEntry[] } | null,
  meId: number | undefined,
  reset: { link: string; expiresAt: string } | null,
): string {
  if (!data) return '<p class="muted center">Loading…</p>';
  const u = data.user;
  const self = u.userId === meId;
  const games = data.games.length
    ? `<ul class="history">${data.games
        .map(
          (g) => `<li class="${g.won ? 'won' : ''}"><div class="h-top"><strong>${g.won ? 'Won' : 'Lost'}</strong>
            <span class="${g.chipsDelta >= 0 ? 'plus' : 'minus'}">${g.chipsDelta > 0 ? '+' : ''}${g.chipsDelta}</span>
            <small>${timeAgo(g.endedAt)} · Room ${esc(g.roomCode)}</small></div>
            <div class="h-players">${g.players.map((x) => `<span class="${x.winner ? 'win' : ''}">${esc(x.displayName)} ${x.points}pts</span>`).join('')}</div></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">No rounds played yet.</p>';
  const resetBox = reset
    ? `<div class="reset-link"><p class="small">Send this link to ${esc(u.displayName)}. It works once, until ${new Date(reset.expiresAt).toLocaleString()}.</p>
        <input readonly value="${esc(reset.link)}" aria-label="Reset link">
        <div class="row-btns"><button data-action="copy-reset">Copy</button>
        <a class="button" href="mailto:${esc(u.email)}?subject=${encodeURIComponent('Reset your Tong-its password')}&body=${encodeURIComponent(`Open this link to choose a new password:\n${reset.link}`)}">Email it</a>
        ${'share' in navigator ? '<button data-action="share-reset">Share</button>' : ''}</div></div>`
    : '';
  return `<section class="card-box profile">
      <div class="profile-top"><span class="avatar huge">${esc(u.avatar)}</span>
        <div><strong>${esc(u.displayName)}</strong><p class="muted small">${esc(u.email)}</p><span class="badges">${badges(u)}</span></div></div>
      <div class="stats">
        ${stat(u.chips, 'Chips')}${stat(u.gamesPlayed, 'Rounds')}${stat(u.wins, 'Wins')}${stat(u.tongitsWins, 'Tong-its')}${stat(u.timesBurned, 'Burned')}
      </div>
      <p class="muted small">Joined ${timeAgo(u.createdAt)} · ${u.lastSeen ? `last seen ${timeAgo(u.lastSeen)}` : 'never played'}${u.resetRequestedAt ? ` · asked for a password reset ${timeAgo(u.resetRequestedAt)}` : ''}</p>
    </section>
    <form id="admin-edit" class="card-box">
      <h3>Edit</h3>
      <label>Display name<input name="displayName" maxlength="24" value="${esc(u.displayName)}" required></label>
      <label>Chips<input name="chips" type="number" inputmode="numeric" step="1" value="${u.chips}" required></label>
      <label class="open-toggle"><input type="checkbox" name="isAdmin" ${u.isAdmin ? 'checked' : ''} ${self ? 'disabled' : ''}> Server admin</label>
      <label class="open-toggle"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''} ${self ? 'disabled' : ''}> Turn off this account <small class="muted">They are logged out and cannot log in</small></label>
      <button class="primary">Save changes</button>
    </form>
    <section class="card-box">
      <h3>Password</h3>
      <p class="muted small">Make a one-time link that lets ${esc(u.displayName)} choose a new password.</p>
      <button data-action="make-reset">${reset ? 'Make a new link' : 'Make reset link'}</button>
      ${resetBox}
    </section>
    <h3>Recent rounds</h3>
    ${games}
    ${self ? '' : `<div class="links"><button class="danger" data-action="delete-user">Delete account</button></div>`}`;
}

/** The admin contact as a link: mailto for an email address, otherwise a web link. */
export function contactHtml(contact: string | null): string {
  if (!contact) return 'Ask the person who runs this server to send you a reset link.';
  const isEmail = /^[^\s@/]+@[^\s@/]+$/.test(contact);
  const href = isEmail ? `mailto:${contact}?subject=${encodeURIComponent('Tong-its password reset')}` : /^https?:\/\//i.test(contact) ? contact : `https://${contact}`;
  return `You can also reach the admin at <a href="${esc(href)}" target="_blank" rel="noopener">${esc(contact)}</a>.`;
}
