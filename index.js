const express = require('express');
const cors = require('cors');
require('dotenv').config();

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('./db');
const redis = require('./redis');

const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  const status = { server: 'ok', database: 'unknown', redis: 'unknown' };

  try {
    await pool.query('SELECT 1');
    status.database = 'ok';
  } catch (err) {
    status.database = 'error: ' + err.message;
  }

  try {
    await redis.ping();
    status.redis = 'ok';
  } catch (err) {
    status.redis = 'error: ' + err.message;
  }

  const allOk = status.database === 'ok' && status.redis === 'ok';
  res.status(allOk ? 200 : 500).json(status);
});

// Sign up
app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, password_hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ user_id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on email
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Log in
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ user_id: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user_id = payload.user_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Add a symbol to the logged-in user's watchlist
app.post('/watchlist', requireAuth, async (req, res) => {
  const { symbol } = req.body;
  const user_id = req.user_id;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO watchlist_items (user_id, symbol)
       VALUES ($1, $2)
       ON CONFLICT (user_id, symbol) DO NOTHING
       RETURNING *`,
      [user_id, symbol.toUpperCase()]
    );
    if (result.rows.length === 0) {
      return res.status(200).json({ message: 'Already on watchlist' });
    }
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add symbol' });
  }
});

// View the logged-in user's watchlist
app.get('/watchlist', requireAuth, async (req, res) => {
  const user_id = req.user_id;
  try {
    const result = await pool.query(
      'SELECT * FROM watchlist_items WHERE user_id = $1 ORDER BY added_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch watchlist' });
  }
});

// Remove a symbol from the logged-in user's watchlist
app.delete('/watchlist/:symbol', requireAuth, async (req, res) => {
  const user_id = req.user_id;
  const { symbol } = req.params;
  try {
    await pool.query(
      'DELETE FROM watchlist_items WHERE user_id = $1 AND symbol = $2',
      [user_id, symbol.toUpperCase()]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove symbol' });
  }
});

// What's changed since the logged-in user last checked
app.get('/watchlist/changes', requireAuth, async (req, res) => {
  const user_id = req.user_id;
  const markViewed = req.query.mark_viewed === 'true';

  try {
    const watchlist = await pool.query(
      'SELECT * FROM watchlist_items WHERE user_id = $1',
      [user_id]
    );

    const results = [];

    for (const item of watchlist.rows) {
      const { symbol, last_viewed_at } = item;

      const latestRes = await pool.query(
        'SELECT price, time FROM price_snapshots WHERE symbol = $1 ORDER BY time DESC LIMIT 1',
        [symbol]
      );
      if (latestRes.rows.length === 0) {
        results.push({ symbol, status: 'no_data_yet' });
        continue;
      }
      const current = latestRes.rows[0];

      const baselineRes = await pool.query(
        `SELECT price, time FROM price_snapshots
         WHERE symbol = $1 AND time >= $2
         ORDER BY time ASC LIMIT 1`,
        [symbol, last_viewed_at]
      );

      if (baselineRes.rows.length === 0) {
        results.push({
          symbol,
          current_price: current.price,
          status: 'no_new_data_since_last_visit',
          meaningful: false,
        });
        continue;
      }

      const baseline = baselineRes.rows[0];
      const pctChange = (current.price - baseline.price) / baseline.price;

      const volRes = await pool.query(
        `SELECT STDDEV(price) AS vol, AVG(price) AS avg_price, COUNT(*) AS n
         FROM (SELECT price FROM price_snapshots WHERE symbol = $1 ORDER BY time DESC LIMIT 20) sub`,
        [symbol]
      );
      const { vol, avg_price, n } = volRes.rows[0];

      let meaningful, reason;

      if (n < 5 || vol == null || Number(avg_price) === 0) {
        meaningful = Math.abs(pctChange) > 0.01;
        reason = `insufficient history (${n} points) — used flat 1% threshold`;
      } else {
        const MIN_RELATIVE_VOL = 0.001;
        const relativeVol = Math.max(vol / avg_price, MIN_RELATIVE_VOL);
        const zScore = relativeVol > 0 ? Math.abs(pctChange) / relativeVol : 0;
        meaningful = zScore > 1.5;
        reason = `${zScore.toFixed(2)}x this stock's normal volatility`;
      }

      results.push({
        symbol,
        baseline_price: baseline.price,
        current_price: current.price,
        pct_change: (pctChange * 100).toFixed(2) + '%',
        meaningful,
        reason,
      });
    }

    if (markViewed) {
      await pool.query(
        'UPDATE watchlist_items SET last_viewed_at = now() WHERE user_id = $1',
        [user_id]
      );
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute changes' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});