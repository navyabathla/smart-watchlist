-- Users: minimal auth, enough for cross-device persistence
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- What each user is watching, and when they last looked
CREATE TABLE watchlist_items (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    added_at TIMESTAMPTZ DEFAULT now(),
    last_viewed_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, symbol)
);

-- Price history: one row per symbol per poll, append-only
CREATE TABLE price_snapshots (
    time TIMESTAMPTZ NOT NULL DEFAULT now(),
    symbol TEXT NOT NULL,
    price NUMERIC NOT NULL,
    volume BIGINT
);

-- Convert price_snapshots into a hypertable — this is the whole point of TimescaleDB:
-- it auto-partitions this table by time under the hood for fast range queries
SELECT create_hypertable('price_snapshots', 'time');

-- Index for the common lookup pattern: "give me symbol X's history"
CREATE INDEX idx_price_symbol_time ON price_snapshots (symbol, time DESC);