// Server admin commands, run next to the server:
//   docker compose exec server node packages/server/dist/admin.js list-users
//   docker compose exec server node packages/server/dist/admin.js reset-password <email> <new password>
//   docker compose exec server node packages/server/dist/admin.js make-admin <email>
import { hashPassword } from './auth.js';
import { pool } from './db.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'list-users') {
    const { rows } = await pool.query(
      `SELECT u.email, p.display_name, p.chips, p.games_played, u.created_at
         FROM users u JOIN profiles p ON p.user_id = u.id ORDER BY u.created_at`,
    );
    for (const r of rows) {
      console.log(`${r.email}\t${r.display_name}\t${r.chips} chips\t${r.games_played} rounds\tjoined ${r.created_at.toISOString().slice(0, 10)}`);
    }
    if (rows.length === 0) console.log('No accounts yet.');
  } else if (cmd === 'reset-password') {
    const [email, password] = args;
    if (!email || !password || password.length < 8) {
      throw new Error('Usage: reset-password <email> <new password of 8+ characters>');
    }
    const { rows } = await pool.query('UPDATE users SET password_hash = $2 WHERE email = $1 RETURNING id', [
      email.trim().toLowerCase(),
      await hashPassword(password),
    ]);
    if (!rows[0]) throw new Error(`No account with email ${email}.`);
    // Log the player out everywhere so the new password takes effect at once.
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    console.log(`Password reset for ${email}.`);
  } else if (cmd === 'make-admin') {
    const email = (args[0] ?? '').trim().toLowerCase();
    if (!email) throw new Error('Usage: make-admin <email>');
    const { rowCount } = await pool.query('UPDATE users SET is_admin = true WHERE email = $1', [email]);
    if (!rowCount) throw new Error(`No account with email ${email}.`);
    console.log(`${email} is now an admin. Admin appears on their home screen the next time they open the app.`);
  } else {
    console.log('Commands: list-users | reset-password <email> <new password> | make-admin <email>');
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
