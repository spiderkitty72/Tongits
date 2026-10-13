// Admin tools, password resets and the leaderboard.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { hashPassword, tokenHash } from './auth.js';
import { cleanDisplayName } from './profiles.js';

/** Reset links work for a day. */
const RESET_HOURS = 24;

export async function isAdmin(userId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1 AND NOT disabled', [userId]);
  return rows[0]?.is_admin === true;
}

/** Makes the accounts named in ADMIN_EMAILS admins. Runs at startup and after sign-up. */
export async function applyAdminEmails(): Promise<void> {
  if (config.adminEmails.length === 0) return;
  await pool.query('UPDATE users SET is_admin = true WHERE email = ANY($1) AND NOT is_admin', [config.adminEmails]);
}

export async function touchLastSeen(userId: number): Promise<void> {
  await pool.query('UPDATE users SET last_seen = now() WHERE id = $1', [userId]);
}

export interface ServerStats {
  accounts: number;
  newThisWeek: number;
  activeThisWeek: number;
  roundsPlayed: number;
  roundsToday: number;
  chipsInPlay: number;
  resetRequests: number;
}

export async function serverStats(): Promise<ServerStats> {
  const { rows } = await pool.query(`
    SELECT (SELECT count(*) FROM users)::int AS accounts,
           (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS new_week,
           (SELECT count(*) FROM users WHERE last_seen > now() - interval '7 days')::int AS active_week,
           (SELECT count(*) FROM games)::int AS rounds,
           (SELECT count(*) FROM games WHERE ended_at > date_trunc('day', now()))::int AS rounds_today,
           (SELECT coalesce(sum(chips), 0) FROM profiles)::int AS chips,
           (SELECT count(*) FROM users WHERE reset_requested_at IS NOT NULL)::int AS resets`);
  const r = rows[0];
  return {
    accounts: r.accounts,
    newThisWeek: r.new_week,
    activeThisWeek: r.active_week,
    roundsPlayed: r.rounds,
    roundsToday: r.rounds_today,
    chipsInPlay: r.chips,
    resetRequests: r.resets,
  };
}

export interface AdminUser {
  userId: number;
  email: string;
  displayName: string;
  avatar: string;
  chips: number;
  gamesPlayed: number;
  wins: number;
  tongitsWins: number;
  timesBurned: number;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  lastSeen: string | null;
  resetRequestedAt: string | null;
}

const USER_COLUMNS = `u.id, u.email, u.is_admin, u.disabled, u.created_at, u.last_seen, u.reset_requested_at,
  p.display_name, p.avatar, p.chips, p.games_played, p.wins, p.tongits_wins, p.times_burned`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toAdminUser(r: any): AdminUser {
  return {
    userId: r.id,
    email: r.email,
    displayName: r.display_name,
    avatar: r.avatar,
    chips: r.chips,
    gamesPlayed: r.games_played,
    wins: r.wins,
    tongitsWins: r.tongits_wins,
    timesBurned: r.times_burned,
    isAdmin: r.is_admin,
    disabled: r.disabled,
    createdAt: iso(r.created_at)!,
    lastSeen: iso(r.last_seen),
    resetRequestedAt: iso(r.reset_requested_at),
  };
}

/** Accounts matching a name or email search; reset requests first, then most recently seen. */
export async function listUsers(search: string): Promise<AdminUser[]> {
  const q = `%${search.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE lower(u.email) LIKE $1 OR lower(p.display_name) LIKE $1
      ORDER BY u.reset_requested_at IS NULL, u.last_seen DESC NULLS LAST, u.created_at DESC
      LIMIT 200`,
    [q],
  );
  return rows.map(toAdminUser);
}

export async function getAdminUser(userId: number): Promise<AdminUser | null> {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [
    userId,
  ]);
  return rows[0] ? toAdminUser(rows[0]) : null;
}

export class AccountError extends Error {}

export interface AdminEdit {
  displayName?: unknown;
  chips?: unknown;
  isAdmin?: unknown;
  disabled?: unknown;
}

/** Applies an admin's edits. Returns true when the account was just disabled, so its sessions can be closed. */
export async function adminUpdateUser(actorId: number, userId: number, edit: AdminEdit): Promise<boolean> {
  const user = await getAdminUser(userId);
  if (!user) throw new AccountError('No such account.');
  if (userId === actorId && (edit.isAdmin === false || edit.disabled === true)) {
    throw new AccountError('You cannot remove your own admin access or disable your own account.');
  }
  if (edit.displayName !== undefined) {
    const name = cleanDisplayName(edit.displayName);
    if (!name) throw new AccountError('Display name must be 1 to 24 characters.');
    await pool.query('UPDATE profiles SET display_name = $2 WHERE user_id = $1', [userId, name]);
  }
  if (edit.chips !== undefined) {
    const chips = Number(edit.chips);
    if (!Number.isInteger(chips) || Math.abs(chips) > 1_000_000_000) throw new AccountError('Chips must be a whole number.');
    await pool.query('UPDATE profiles SET chips = $2 WHERE user_id = $1', [userId, chips]);
  }
  if (typeof edit.isAdmin === 'boolean') await pool.query('UPDATE users SET is_admin = $2 WHERE id = $1', [userId, edit.isAdmin]);
  let justDisabled = false;
  if (typeof edit.disabled === 'boolean') {
    await pool.query('UPDATE users SET disabled = $2 WHERE id = $1', [userId, edit.disabled]);
    if (edit.disabled && !user.disabled) {
      await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      justDisabled = true;
    }
  }
  return justDisabled;
}

/** Deletes an account. Finished games keep the player's name. */
export async function deleteUser(actorId: number, userId: number): Promise<void> {
  if (userId === actorId) throw new AccountError('You cannot delete your own account here.');
  const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  if (!rowCount) throw new AccountError('No such account.');
}

/** Creates a one-time reset link token for an account; older unused links stop working. */
export async function createResetToken(actorId: number, userId: number): Promise<{ token: string; expiresAt: string }> {
  if (!(await getAdminUser(userId))) throw new AccountError('No such account.');
  const token = randomBytes(24).toString('base64url');
  await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
  const { rows } = await pool.query(
    `INSERT INTO password_resets (token_hash, user_id, created_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
    [tokenHash(token), userId, actorId, RESET_HOURS],
  );
  return { token, expiresAt: iso(rows[0].expires_at)! };
}

/** Sets a new password from a reset link. Logs the account out everywhere and returns its id. */
export async function useResetToken(token: string, password: string): Promise<number> {
  if (password.length < 8 || password.length > 200) throw new AccountError('Password must be at least 8 characters.');
  const { rows } = await pool.query(
    'DELETE FROM password_resets WHERE token_hash = $1 RETURNING user_id, expires_at > now() AS valid',
    [tokenHash(token)],
  );
  if (!rows[0] || !rows[0].valid) throw new AccountError('This reset link has expired or was already used. Ask the admin for a new one.');
  const userId = rows[0].user_id as number;
  await pool.query('UPDATE users SET password_hash = $2, reset_requested_at = NULL WHERE id = $1', [
    userId,
    await hashPassword(password),
  ]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return userId;
}

/** Flags a "forgot password" request for the admins. Says nothing about whether the email exists. */
export async function requestReset(email: string): Promise<void> {
  await pool.query('UPDATE users SET reset_requested_at = now() WHERE email = $1 AND NOT disabled', [email]);
}

export interface LeaderRow {
  userId: number;
  displayName: string;
  avatar: string;
  chips: number;
  gamesPlayed: number;
  wins: number;
  tongitsWins: number;
}

/** Top players by chips or by wins. Accounts that have not played yet are left out. */
export async function leaderboard(by: 'chips' | 'wins'): Promise<LeaderRow[]> {
  const order = by === 'wins' ? 'p.wins DESC, p.chips DESC' : 'p.chips DESC, p.wins DESC';
  const { rows } = await pool.query(
    `SELECT u.id, p.display_name, p.avatar, p.chips, p.games_played, p.wins, p.tongits_wins
       FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE NOT u.disabled AND p.games_played > 0
      ORDER BY ${order}, p.display_name LIMIT 50`,
  );
  return rows.map((r) => ({
    userId: r.id,
    displayName: r.display_name,
    avatar: r.avatar,
    chips: r.chips,
    gamesPlayed: r.games_played,
    wins: r.wins,
    tongitsWins: r.tongits_wins,
  }));
}
