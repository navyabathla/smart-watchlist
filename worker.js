const pool = require('./db');
const { getQuote } = require('./finnhub');
require('dotenv').config();

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute — free tier is 60 calls/min total, so pace this to your symbol count

async function getWatchedSymbols() {
  const result = await pool.query(
    'SELECT DISTINCT symbol FROM watchlist_items'
  );
  return result.rows.map((row) => row.symbol);
}

async function pollOnce() {
  const symbols = await getWatchedSymbols();

  if (symbols.length === 0) {
    console.log('No symbols being watched yet, skipping poll');
    return;
  }

  for (const symbol of symbols) {
    try {
      const quote = await getQuote(symbol);
      if (quote.price == null) {
        console.warn(`No price returned for ${symbol}, skipping`);
        continue;
      }
      await pool.query(
        'INSERT INTO price_snapshots (symbol, price) VALUES ($1, $2)',
        [symbol, quote.price]
      );
      console.log(`Stored ${symbol}: $${quote.price}`);
    } catch (err) {
      console.error(`Failed to fetch/store ${symbol}:`, err.message);
    }
  }
}

console.log('Worker starting, polling every', POLL_INTERVAL_MS / 1000, 'seconds');
pollOnce(); // run once immediately on start
setInterval(pollOnce, POLL_INTERVAL_MS);