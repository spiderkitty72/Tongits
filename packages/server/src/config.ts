import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type SignupMode = 'open' | 'invite' | 'closed';

const here = path.dirname(fileURLToPath(import.meta.url));

function signupMode(value: string | undefined): SignupMode {
  return value === 'open' || value === 'closed' ? value : 'invite';
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tongits',
  serverName: process.env.SERVER_NAME ?? 'Tong-its server',
  signupMode: signupMode(process.env.SIGNUP_MODE),
  inviteCode: process.env.INVITE_CODE ?? '',
  /** Comma-separated list of web origins allowed to call the API, or "*" for any. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  startingChips: Number(process.env.STARTING_CHIPS ?? 100),
  publicDir: process.env.PUBLIC_DIR ?? path.resolve(here, '../public'),
  sessionDays: 30,
};

export const SERVER_VERSION = '0.1.0';
/** Bumped whenever client and server messages change incompatibly. */
export const PROTOCOL_VERSION = 1;
