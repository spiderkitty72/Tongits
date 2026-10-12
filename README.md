# Tong-its

Play the Filipino card game Tong-its with friends in the browser on a phone, iPad or computer. It installs as an app (PWA) on iPhone and Android.

- **Anyone can host a server.** One `docker compose up` starts the game server and its own Postgres database.
- **Players pick the server.** The app's first screen asks for a server address and remembers the ones you've used.
- **Accounts and profiles.** Sign up with email and password. Your profile keeps your chips, wins, Tong-its, times burned, and every round you played with who was at the table.
- **House rules.** Before a game the host picks the variants on a rules page: Draw ties, stock-out ties, sapaw blocking, secret four-of-a-kind, Q-K-A runs, next dealer, turn timer, payouts and game length. Hosts can save their rule sets.

## Host your own server

You need a machine with [Docker](https://docs.docker.com/get-docker/) (a home PC, a Raspberry Pi 4/5 or a small VPS).

```sh
mkdir tongits && cd tongits
curl -O https://raw.githubusercontent.com/spiderkitty72/Tongits/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/spiderkitty72/Tongits/main/.env.example
# edit .env: set SERVER_NAME, POSTGRES_PASSWORD and INVITE_CODE
docker compose up -d
```

The game is now at `http://<your machine>:8080`. Share that address and your invite code with friends.

| Setting in `.env` | What it does |
| --- | --- |
| `SERVER_NAME` | Name players see when they connect |
| `PORT` | Port on the host machine (default 8080) |
| `POSTGRES_PASSWORD` | Database password; required |
| `SIGNUP_MODE` | `open`, `invite` (needs `INVITE_CODE`) or `closed` |
| `INVITE_CODE` | Code new players must enter when `SIGNUP_MODE=invite` |
| `CORS_ORIGINS` | Browser origins allowed to use the API. `*` lets any copy of the app connect |
| `STARTING_CHIPS` | Chips every new account starts with |

**HTTPS.** Phones only install the app and keep logins safe over HTTPS. The simplest way is [Caddy](https://caddyserver.com/) in front of the server:

```
tongits.example.com {
    reverse_proxy localhost:8080
}
```

At home without a domain, [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) or [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) give you a public HTTPS address.

**Backups.** Everything lives in the `tongits-db` Docker volume. Back it up with:

```sh
docker compose exec db pg_dump -U tongits tongits > tongits-$(date +%F).sql
```

**Upgrades.** `docker compose pull && docker compose up -d`. Database changes are applied automatically on start.

**Without the published image.** Clone this repo and run `docker compose up -d --build` to build the image yourself.

## Install the app on a phone

Open the server address in the phone's browser.

- **iPhone / iPad (Safari):** tap Share, then **Add to Home Screen**.
- **Android (Chrome):** tap **Install the app** on the home screen, or the browser menu's **Install app**.

The installed app can connect to any Tong-its server; change it from the home screen with **Change server**.

## How to play (default rules)

- 3 players, 52 cards. The dealer gets 13, the others 12; 15 cards form the stock.
- Melds are sets (3 or 4 of a rank) or runs (3+ in a row of one suit; Ace is low).
- On your turn: draw from the stock, or take the top discard only if you meld it at once. Then lay down melds, **sapaw** (add cards to any meld on the table), and discard one card.
- **Tong-its:** empty your hand and win immediately.
- **Draw:** at the start of your turn, if you have a meld down and were not sapawed since your last turn, call Draw. Others with a meld fight or fold; the lowest hand wins.
- **Stock runs out:** lowest hand among players with a meld wins.
- **Burned:** a player with no meld when the round ends cannot win and pays a penalty.

## Develop

Requires Node 22 and a Postgres database.

```sh
npm install
npm test                 # rules engine tests
npm run build            # engine, server and client
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tongits SIGNUP_MODE=open \
  PUBLIC_DIR=$PWD/packages/client/dist npm start -w @tongits/server
npm run dev:client       # Vite dev server on :5173; connect it to http://localhost:8080
node scripts/smoke.mjs http://localhost:8080   # three bots play a full match
```

| Package | What it holds |
| --- | --- |
| `packages/engine` | Rules: cards, melds, turns, Draw calls, scoring, rule settings. No I/O. |
| `packages/server` | HTTP API (accounts, profiles, history, presets), WebSocket rooms, Postgres. Serves the built client. |
| `packages/client` | The PWA: plain TypeScript and CSS built with Vite. |

The server is authoritative: it shuffles, deals and checks every move, and each player only receives their own hand.
