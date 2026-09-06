# Smart Market Watchlist

A market watchlist that doesn't just show you current prices — it tells you what's actually worth your attention since you last checked, scored against each stock's own normal behavior rather than a flat threshold.

**Live demo:** https://smart-watchlist-q34s.onrender.com
*(Free-tier hosting — the first request after inactivity may take 30–60 seconds to wake up.)*

## The problem this solves

Most watchlists show you a price and a percent change. That's not the same as knowing whether something *meaningful* happened. A 2% move in a normally volatile stock is noise; the same 2% move in a normally quiet stock is a signal. This app scores every price change against that specific stock's own recent volatility, not a one-size-fits-all percentage.

## Architecture
┌─────────────┐ ┌──────────────────┐ ┌─────────────────┐
│ Frontend │◄────►│ Express API │◄────►│ PostgreSQL + │
│ (vanilla JS)│ │ + in-process │ │ TimescaleDB │
└─────────────┘ │ price poller │ │ (hypertable) │
└────────┬─────────┘ └─────────────────┘
│
┌──────▼──────┐
│ Finnhub API │
└─────────────┘

Redis (Render Key Value / Valkey) is provisioned for caching, alongside the core Postgres + Express path used for the current feature set.

## Why these technologies, over the alternatives considered

- **PostgreSQL + TimescaleDB**, not vanilla Postgres or MongoDB: the core feature requires rolling volatility over price history — TimescaleDB's hypertables make time-range queries efficient at scale, and the data is genuinely relational (users → watchlists → symbols → snapshots), which a document store doesn't help with.
- **Node.js/Express**, not Go or Java/Spring: the workload is almost entirely I/O-bound (external API polling, DB reads, concurrent requests) — exactly what Node's non-blocking event loop is built for. Go's goroutines would fit the same shape, but represented unnecessary language-risk for a 72-hour solo build.
- **Vanilla JS frontend**, not React: the UI is a live-updating table with no complex state tree — a full framework's overhead wasn't justified for this scope.
- **JWT + bcryptjs**, not session-based auth: keeps the API stateless and simple to deploy across a free-tier host that may spin down and restart.

## The core algorithm: what counts as "meaningful"

For each watched symbol, on every check:
1. Compare the current price to the first snapshot recorded *after* the user's last visit (not just the previous poll — the actual last time they looked).
2. Compute that stock's own rolling volatility from its last 20 snapshots (coefficient of variation).
3. Score the price move as a multiple of that stock's own normal volatility (a z-score), not a flat percentage.
4. Flag it as meaningful only if the move is a statistically unusual multiple (>1.5x) of what's normal for that specific stock.
5. Cold-start fallback: if a symbol has fewer than 5 snapshots, fall back to a flat 1% threshold until real history accumulates.

**A real bug caught and fixed during development:** during a closed-market period, flat repeated prices drove measured volatility toward zero, which meant even a tiny real price move produced an absurd 70x+ significance score once the market reopened (small denominator, huge z-score). Fixed by flooring relative volatility at a realistic minimum (0.1%) — documented in code as `MIN_RELATIVE_VOL`.

## Known limitations / trade-offs (honest, not hidden)

- **Worker merged in-process:** Render's free tier doesn't support Background Worker services, so the price-polling loop runs inside the same process as the API server rather than as an isolated service. At real production scale, these would be split for independent scaling and fault isolation.
- **Free-tier cold starts:** the hosted instance sleeps after 15 minutes of inactivity; the first request afterward is slow.
- **Finnhub free tier has no volume data** on the `/quote` endpoint, so the change-detection scoring uses price/volatility only, not volume spikes.
- **Single symbol source, no failover** — if Finnhub has an outage, snapshots simply stop until it recovers (handled gracefully, logged, doesn't crash the app).

## Setup & running locally

### Prerequisites
- Node.js (LTS)
- Docker Desktop
- A free [Finnhub](https://finnhub.io/register) API key

### Steps
```bash
# 1. Clone and install
git clone https://github.com/navyabathla/smart-watchlist.git
cd smart-watchlist
npm install

# 2. Start TimescaleDB + Redis
docker compose up -d

# 3. Create .env in the project root:
#    DATABASE_URL=postgresql://postgres:password@localhost:5433/watchlist
#    REDIS_URL=redis://localhost:6379
#    FINNHUB_API_KEY=your_key_here
#    JWT_SECRET=any_random_string
#    PORT=3000

# 4. Load the schema (via pgAdmin's Query Tool, or psql):
#    Run the contents of schema.sql against the watchlist database

# 5. Run it
npx nodemon index.js
```

Visit `http://localhost:3000`, sign up, and add a symbol.

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/signup` | — | Create an account |
| POST | `/auth/login` | — | Log in, returns a JWT |
| GET | `/watchlist` | ✅ | View your watchlist |
| POST | `/watchlist` | ✅ | Add a symbol |
| DELETE | `/watchlist/:symbol` | ✅ | Remove a symbol |
| GET | `/watchlist/changes` | ✅ | What's changed since you last checked |
| GET | `/health` | — | DB + Redis connectivity check |

## Future improvements, given more time

- Cross-stock correlation-break detection (flag when two normally-correlated watchlist stocks diverge)
- WebSocket/SSE push for live updates while the tab is open, rather than periodic polling
- Volume-based signals once paired with a data source that provides them
