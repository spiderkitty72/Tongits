import { RuleSet, RoundResult } from '@tongits/engine';
import { pool } from './db.js';

export const AVATARS = ['🐯', '🦅', '🐉', '🐢', '🦊', '🐼', '🦁', '🐸', '🐙', '🦉', '🐺', '🦄'];

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

export async function getProfile(userId: number): Promise<Profile | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, p.display_name, p.avatar, p.chips, p.games_played, p.wins, p.tongits_wins, p.times_burned
       FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
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
  };
}

export function cleanDisplayName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.replace(/\s+/g, ' ').trim();
  return n.length >= 1 && n.length <= 24 ? n : null;
}

export async function updateProfile(userId: number, displayName?: string, avatar?: string): Promise<void> {
  if (displayName) await pool.query('UPDATE profiles SET display_name = $2 WHERE user_id = $1', [userId, displayName]);
  if (avatar && AVATARS.includes(avatar)) await pool.query('UPDATE profiles SET avatar = $2 WHERE user_id = $1', [userId, avatar]);
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

export async function getHistory(userId: number, limit = 50): Promise<HistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT g.id, g.ended_at, g.ended_by, g.room_code, g.round_no, g.winner_user_id,
            json_agg(json_build_object('seat', gp.seat, 'userId', gp.user_id, 'displayName', gp.display_name,
                     'points', gp.points, 'burned', gp.burned, 'chipsDelta', gp.chips_delta) ORDER BY gp.seat) AS players
       FROM games g JOIN game_players gp ON gp.game_id = g.id
      WHERE g.id IN (SELECT game_id FROM game_players WHERE user_id = $1)
      GROUP BY g.id ORDER BY g.ended_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => {
    const players = r.players as { seat: number; userId: number | null; displayName: string; points: number; burned: boolean; chipsDelta: number }[];
    const mine = players.find((p) => p.userId === userId);
    return {
      gameId: r.id,
      endedAt: new Date(r.ended_at).toISOString(),
      endedBy: r.ended_by,
      roomCode: r.room_code,
      roundNo: r.round_no,
      chipsDelta: mine?.chipsDelta ?? 0,
      won: r.winner_user_id === userId,
      players: players.map((p) => ({
        seat: p.seat,
        displayName: p.displayName,
        points: p.points,
        burned: p.burned,
        chipsDelta: p.chipsDelta,
        winner: p.userId !== null && p.userId === r.winner_user_id,
      })),
    };
  });
}

/** Saves one finished round and updates each player's totals in a single transaction. */
export async function recordRound(opts: {
  matchId: string;
  roomCode: string;
  roundNo: number;
  startedAt: Date;
  rules: RuleSet;
  /** userId is null for computer players. */
  seats: { userId: number | null; displayName: string }[];
  result: RoundResult;
}): Promise<void> {
  const { result } = opts;
  const winnerUser = result.winner === null ? null : opts.seats[result.winner].userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO games (match_id, room_code, round_no, started_at, ended_by, winner_user_id, rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [opts.matchId, opts.roomCode, opts.roundNo, opts.startedAt, result.endedBy, winnerUser, JSON.stringify(opts.rules)],
    );
    const gameId = rows[0].id;
    for (let seat = 0; seat < opts.seats.length; seat++) {
      const s = opts.seats[seat];
      const won = result.winner === seat;
      await client.query(
        `INSERT INTO game_players (game_id, seat, user_id, display_name, points, burned, chips_delta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [gameId, seat, s.userId, s.displayName, result.points[seat], result.burned[seat], result.payouts[seat]],
      );
      await client.query(
        `UPDATE profiles SET games_played = games_played + 1, chips = chips + $2,
                wins = wins + $3, tongits_wins = tongits_wins + $4, times_burned = times_burned + $5
          WHERE user_id = $1`,
        [s.userId, result.payouts[seat], won ? 1 : 0, won && result.endedBy === 'tongits' ? 1 : 0, result.burned[seat] ? 1 : 0],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listPresets(userId: number): Promise<{ id: number; name: string; rules: RuleSet }[]> {
  const { rows } = await pool.query('SELECT id, name, rules FROM rule_presets WHERE user_id = $1 ORDER BY name', [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, rules: r.rules }));
}

export async function savePreset(userId: number, name: string, rules: RuleSet): Promise<void> {
  await pool.query(
    `INSERT INTO rule_presets (user_id, name, rules) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET rules = EXCLUDED.rules`,
    [userId, name, JSON.stringify(rules)],
  );
}

export async function deletePreset(userId: number, id: number): Promise<void> {
  await pool.query('DELETE FROM rule_presets WHERE user_id = $1 AND id = $2', [userId, id]);
}
