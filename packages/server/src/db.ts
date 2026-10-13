import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Schema changes, applied in order once each. Never edit a shipped entry; add a new one. */
const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE profiles (
        user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        display_name  TEXT NOT NULL,
        avatar        TEXT NOT NULL DEFAULT '🐯',
        chips         INTEGER NOT NULL,
        games_played  INTEGER NOT NULL DEFAULT 0,
        wins          INTEGER NOT NULL DEFAULT 0,
        tongits_wins  INTEGER NOT NULL DEFAULT 0,
        times_burned  INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        token_hash    TEXT PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE games (
        id             SERIAL PRIMARY KEY,
        match_id       UUID NOT NULL,
        room_code      TEXT NOT NULL,
        round_no       INTEGER NOT NULL,
        started_at     TIMESTAMPTZ NOT NULL,
        ended_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_by       TEXT NOT NULL,
        winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        rules          JSONB NOT NULL
      );
      CREATE INDEX games_match ON games(match_id);
      CREATE TABLE game_players (
        game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        seat         INTEGER NOT NULL,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        points       INTEGER NOT NULL,
        burned       BOOLEAN NOT NULL,
        chips_delta  INTEGER NOT NULL,
        PRIMARY KEY (game_id, seat)
      );
      CREATE INDEX game_players_user ON game_players(user_id);
      CREATE TABLE rule_presets (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        rules      JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, name)
      );
    `,
  },
  {
    id: 2,
    sql: `
      ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN last_seen TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN reset_requested_at TIMESTAMPTZ;
      CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `,
  },
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id as number));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        console.log(`Applied migration ${m.id}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

/** Waits for Postgres to accept connections (it may still be starting under docker compose). */
export async function waitForDb(attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`Waiting for the database (${i}/${attempts})...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
