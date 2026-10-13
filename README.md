# Tong-its

Play the Filipino card game Tong-its with friends in the browser on a phone, iPad or computer. It installs like an app on iPhone and Android.

- **Anyone can host a server.** One `docker compose up` starts the game server and its own Postgres database.
- **The app comes with the server.** Open the server's address and you're on that server. To play somewhere else, open that server's address instead.
- **Admin page and leaderboard.** Admins see server stats, look up and edit players, turn accounts off and make password reset links. Everyone can see the leaderboard.
- **Accounts and profiles.** Players sign up with email and password. Each profile keeps chips, wins, Tong-its wins, times burned, and every round played with who was at the table.
- **House rules.** Before a game the host sets the variants on a rules page: Draw ties, stock-out ties, sapaw blocking, secret four-of-a-kind, Q-K-A runs, next dealer, turn timer, payouts and game length. Hosts can save rule sets to their profile.

**Contents:** [Host a server](#host-a-server) · [Connect players](#connect-players) · [Play a game](#play-a-game) · [Run the server](#run-the-server) · [Troubleshooting](#troubleshooting) · [Rules](#rules) · [Develop](#develop)

---

## Host a server

### What you need

- A computer that stays on while people play: a home PC, a Raspberry Pi 4 or 5 (64-bit OS), or a small cloud VPS. 1 GB of RAM is plenty.
- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin. Check with `docker compose version`.
- For phones to **install** the app and to play from **outside your home network**: an HTTPS address. See [HTTPS](#https). Without it you can still play in the browser on your own Wi-Fi.

### 1. Get the files

```sh
mkdir tongits && cd tongits
curl -O https://raw.githubusercontent.com/spiderkitty72/Tongits/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/spiderkitty72/Tongits/main/.env.example
```

Or clone the whole repo: `git clone https://github.com/spiderkitty72/Tongits.git && cd Tongits && cp .env.example .env`.

### 2. Fill in `.env`

Open `.env` in a text editor. At minimum, change `POSTGRES_PASSWORD` and `INVITE_CODE`.

| Setting | What it does | Default |
| --- | --- | --- |
| `SERVER_NAME` | Name players see when they connect | `Tong-its server` |
| `PORT` | Port on this machine the game listens on | `8080` |
| `POSTGRES_PASSWORD` | Database password. **Required.** Any long random string; nobody types it | none |
| `SIGNUP_MODE` | Who can create accounts: `open` (anyone), `invite` (must enter `INVITE_CODE`) or `closed` (nobody new) | `invite` |
| `INVITE_CODE` | The code new players type on the sign-up screen when `SIGNUP_MODE=invite` | empty, so nobody can sign up until you set it |
| `CORS_ORIGINS` | Which web addresses may run the app against this server. `*` allows any copy of the app (needed for the shared app on GitHub Pages). Use a comma-separated list such as `https://tongits.example.com` to lock it down | `*` |
| `STARTING_CHIPS` | Chips every new account starts with | `100` |
| `ADMIN_EMAILS` | Comma-separated emails whose accounts get the **Admin** page. Sign up with one of them after the server starts | empty |
| `ADMIN_CONTACT` | Your email address or a web link, shown on **Forgot password?** so players can reach you | empty |
| `TONGITS_IMAGE` | Which server image to run | `ghcr.io/spiderkitty72/tongits:latest` |

### 3. Start it

```sh
docker compose up -d
```

This downloads the server and Postgres images, creates the database, and starts both. They restart on their own after a reboot. If the image can't be downloaded, build it from source instead: clone the repo and run `docker compose up -d --build`.

### 4. Check it works

```sh
docker compose ps                         # both services should be "running" / "healthy"
curl http://localhost:8080/api/info       # shows your server name, version and sign-up mode
docker compose logs -f server             # live server log; Ctrl+C to stop watching
```

Then open `http://localhost:8080` in a browser on that machine. You should see the sign-up screen with your server name. Create your own account first.

### HTTPS

Phones only install the app, and browsers only keep logins safe, over HTTPS. Pick one:

**A. You have a domain and a server with ports 80/443 open.** Run [Caddy](https://caddyserver.com/docs/install), which gets a free certificate automatically. Point a DNS record (for example `tongits.example.com`) at the machine, then use this `Caddyfile`:

```
tongits.example.com {
    reverse_proxy localhost:8080
}
```

Players then connect to `https://tongits.example.com`.

**B. Home server, no domain or open ports.** Use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (needs a free Cloudflare account and a domain on Cloudflare) or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) (gives you a free `https://<machine>.<tailnet>.ts.net` address). Point either at `http://localhost:8080`.

**C. Only playing at home on the same Wi-Fi.** Skip HTTPS and connect with the machine's local address, such as `http://192.168.1.20:8080`. Find it with `ipconfig` (Windows), `ipconfig getifaddr en0` (Mac) or `hostname -I` (Linux). The game works in the browser, but phones won't offer to install it as an app.

If players can't reach the server from other devices, allow the port through the machine's firewall (for example `sudo ufw allow 8080/tcp`).

---

## Connect players

Each player needs two things from the host: the **server address** and, on an invite-only server, the **invite code**.

### Open the app

Either of these works:

1. **The server's own address.** Every server includes the app. Open `https://tongits.example.com` (or the local address) and the app always uses that server; there is no server picker. To play on a different server, open that server's address.
2. **The shared app** at `https://spiderkitty72.github.io/Tongits/`, if GitHub Pages is turned on for this repo. Type the server address on the first screen. The server must use **HTTPS**, because a secure page can't talk to an `http://` server, and its `CORS_ORIGINS` must allow the app's address (the default `*` does).

On the **Choose a server** screen you can type an address with or without `https://`. Local addresses such as `192.168.1.20:8080` get `http://` automatically. Saved servers are listed underneath; tap one to switch. **Change server** on the home screen comes back here. This screen only appears in the shared app, never on a server's own address.

### Create an account

1. Tap **Sign up**.
2. Enter email, a password of at least 8 characters, a display name, and the invite code if the server asks for one.
3. You stay logged in on that device for 30 days. Accounts belong to one server: an account on a friend's server is separate from yours.

### Install as an app

Open the server's HTTPS address in the phone's browser, then:

- **iPhone or iPad:** in **Safari**, tap **Share**, then **Add to Home Screen**.
- **Android:** in **Chrome**, tap **Install the app** on the home screen, or open the browser menu and choose **Install app** (or **Add to Home screen**).
- **Windows, Mac or Chromebook:** in Chrome or Edge, click the install icon in the address bar.

The installed app opens full screen and remembers your servers and logins. It loads without a connection, but playing needs the server.

---

## Play a game

1. **Create a room** on the home screen. You become the host and get a 4-letter room code.
2. **Invite two friends.** Tap **Share invite** to send a link that opens the app on the right server and joins the room. Or friends type the code under **Join**. Anyone joining a full or running room watches as a spectator.
   - Short of players? The host taps **Add computer** on an empty seat (and **Remove** to free it again). To play alone, tap **Play against computers** on the home screen: you get a room with two computer players already seated. The host sets each computer to **Easy**, **Normal** or **Hard** in the lobby (new computers use the last level picked). Easy is slow to meld and passes up chances; Hard keeps four-of-a-kinds hidden, remembers which cards are gone, and times its Draw calls. Computer rounds are saved to your history; computers have no account or chips.
   - To let anyone on the server join without a code, the host ticks **Open table** in the lobby. Open tables are listed on everyone's home screen with a **Join** button (or **Watch** once the match is running).
3. **Set the house rules** (host only). Pick **Standard** or one of your saved presets, change anything on the rules page, and tap **Save as…** to keep it for next time. Everyone in the lobby sees the rules; they lock when the game starts.
4. Everyone taps **I'm ready**, then the host taps **Start game**.
5. **On your turn**:
   - Tap the stock pile or **Draw from stock**. When the top discard melds with two or more of your cards, the discard pile lights up: tap it or **Take discard** to take it and meld it at once.
   - Select cards and tap **Meld** to lay them down. To **sapaw**, select cards and tap a glowing meld on the table.
   - Select one card and tap **Discard** to end your turn.
   - At the start of your turn, if you have a meld down, **Call Draw** appears. Other players with a meld choose **Fight** or **Fold**.
   - Cards with a gold edge can form a meld with other cards in your hand. **Sort** switches between rank and suit order. 📜 shows what happened recently.
6. After each round the result shows every hand, points and chips. Any player taps **Deal next round**. When the match ends, the host can go **Back to lobby** for another. Leaving from the ☰ menu mid-match ends the match for everyone; finished rounds still count.

If someone's turn timer runs out, the server plays for them: it draws, then discards their highest card, and folds if Draw was called. Players who close the app or lose signal can reopen it and they're put straight back at the table. You can't leave a match until it ends.

---

## Run the server

| Task | Command (run in the folder with `docker-compose.yml`) |
| --- | --- |
| Start or apply `.env` changes | `docker compose up -d` |
| Stop | `docker compose down` (your data is kept) |
| See the log | `docker compose logs -f server` |
| Update to the latest version | `docker compose pull && docker compose up -d` |
| Make someone an admin | `docker compose exec server node packages/server/dist/admin.js make-admin friend@example.com` |
| List accounts | `docker compose exec server node packages/server/dist/admin.js list-users` |
| Reset a player's password | `docker compose exec server node packages/server/dist/admin.js reset-password friend@example.com NewPassword123` |
| Back up the database | `docker compose exec -T db pg_dump -U tongits tongits > tongits-backup.sql` |
| Restore a backup | `docker compose down -v && docker compose up -d db`, wait a few seconds, then `docker compose exec -T db psql -U tongits tongits < tongits-backup.sql && docker compose up -d` |
| Delete everything, including all accounts | `docker compose down -v` |

- **Data** lives in the `tongits-db` Docker volume and survives updates and restarts. Back it up regularly, for example with a nightly cron job running the backup command.
- **Database changes** in new versions are applied automatically when the server starts.
- **Games in progress** live in server memory. Restarting the server ends any match being played; finished rounds are already saved.
- **Admin page.** Accounts in `ADMIN_EMAILS` (or made admin with `make-admin`, or ticked **Server admin** by another admin) see **Admin** on the home screen. It shows who is online, games in progress, accounts, active and new players this week, and rounds played. Search players by name or email, then open one to see their stats and recent rounds, change their name or chips, make them an admin, turn the account off (logs them out and blocks login) or delete it.
- **Password resets.** A player taps **Forgot password?** and enters their email. They show up at the top of the Admin list marked **Wants a reset**. Open them, tap **Make reset link**, and send the link with **Copy**, **Email it** or **Share**. The link works once, for 24 hours, and logs the player out on their other devices. The server doesn't send email itself. The command-line `reset-password` still works too.
- **Leaderboard.** Everyone logged in can open **🏆 Leaderboard** from the home screen to see the top 50 by chips or by wins. Players who haven't finished a round yet and turned-off accounts are left out.
- **Changing sign-up** later: edit `SIGNUP_MODE` or `INVITE_CODE` in `.env`, then `docker compose up -d`.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Please enter a URL" when typing the server address | Fixed in the current version. On an older copy, type it with `http://` in front, such as `http://192.168.1.20:8080`. |
| The page is blank or only says "Loading…" | You opened the source file `packages/client/index.html`. Open the server's address instead, or run `npm install && npm run build` and host or open the files in `packages/client/dist`. |
| "Could not reach …" on the server screen | Check the address and port. Make sure `docker compose ps` shows the server running and the firewall allows the port. From another device, try `http://<address>:8080/api/info` in a browser. |
| "That address is not a Tong-its server" | The address points at something else, often a router or another web page. Check the port. |
| The shared GitHub Pages app can't reach the server, but the server's own address works | The server must be HTTPS, and `CORS_ORIGINS` must be `*` or include `https://spiderkitty72.github.io`. |
| "That invite code is not right" | Codes are case-sensitive. Check `INVITE_CODE` in `.env` and restart with `docker compose up -d`. |
| "Sign-up is closed on this server" | `SIGNUP_MODE=closed`. Change it to `invite` or `open`. |
| No "Install" option on the phone | The page must be on HTTPS, opened in Safari (iPhone) or Chrome (Android). A local `http://192.168…` address can't be installed. |
| The red dot is blinking at the top | The app lost its connection and is reconnecting. It catches up automatically when the connection returns. |
| "This app version does not match the server" | Reload the page, or close and reopen the installed app, to load the server's latest version. |
| `docker compose up` says `set POSTGRES_PASSWORD in .env` | `.env` is missing or `POSTGRES_PASSWORD` is empty. |
| Image download fails or is denied | Build it yourself: clone the repo and run `docker compose up -d --build`. |

---

## Rules

These are the **Standard** rules. Every choice marked *(setting)* can be changed on the rules page.

- **Deal:** 3 players, one 52-card deck, no jokers. The dealer gets 13 cards, the others 12. The other 15 cards form the stock. The dealer starts by discarding without drawing.
- **Points:** Ace = 1, 2 to 10 = face value, J/Q/K = 10.
- **Melds:** a set is 3 or 4 cards of the same rank. A run is 3 or more cards in a row of one suit. Aces are low; Q-K-A counts only when allowed *(setting)*.
- **Your turn:** draw from the stock, or take the top discard only if you meld it right away. Then lay down melds, **sapaw** (add cards to any meld on the table, yours or an opponent's), and discard one card.
- **Sapaw block:** if someone sapaws onto your meld, you can't call Draw on your next turn *(setting)*.
- **Tong-its:** empty your hand and you win at once, with a bonus.
- **Draw:** at the start of your turn, before drawing, you may call Draw if you have a meld down and aren't blocked. Each opponent with a meld fights (shows their hand) or folds. The lowest unmelded points win. Ties go to the caller *(setting)*.
- **Stock runs out:** after the last stock card is drawn and discarded, the lowest hand among players with a meld wins. The player who drew last loses a tie *(setting)*.
- **Burned:** a player with no meld down when the round ends can't win and pays a penalty.
- **Secret four-of-a-kind:** four of a kind kept in your hand counts as melded: it scores 0 and keeps you from being burned *(setting)*.
- **Payouts** *(settings)*: each loser pays the winner the base stake. They pay extra if the winner called Tong-its, if the loser was burned, or if the loser fought a Draw and lost. They also pay extra for each four-of-a-kind and each Ace the winner holds.
- **Match length** *(setting)*: one round, a fixed number of rounds, or until someone reaches a chip target. The round winner deals next *(setting)*.

---

## Develop

Requires Node 22 and a Postgres database (for example `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tongits postgres:16-alpine`).

```sh
npm install
npm run typecheck
npm test                       # rules engine tests
npm run build                  # engine, server and client

# run the server with the built client
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tongits SIGNUP_MODE=open \
  PUBLIC_DIR=$PWD/packages/client/dist npm start -w @tongits/server

npm run dev:client             # live-reloading client on http://localhost:5173; connect it to http://localhost:8080
node scripts/smoke.mjs http://localhost:8080   # three bots sign up and play a full match
```

| Package | What it holds |
| --- | --- |
| `packages/engine` | The rules: cards, melds, turns, Draw calls, scoring, rule settings. No network or database code. |
| `packages/server` | HTTP API (accounts, profiles, history, rule presets), WebSocket game rooms, Postgres migrations, admin commands. Serves the built client. |
| `packages/client` | The PWA: plain TypeScript and CSS built with Vite. |

The server holds the deck and checks every move. Each player only receives their own hand.

**Releases:** every push to `main` runs CI. The Release workflow publishes the server image to `ghcr.io/spiderkitty72/tongits` (for `amd64` and `arm64`, so it runs on a Raspberry Pi) and the client to GitHub Pages. Repo owner, after the first release: in the package's settings on GitHub, set the `tongits` package's visibility to **Public** so others can pull it, and turn on **Settings → Pages → Source: GitHub Actions** for the shared app.
