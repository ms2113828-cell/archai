// ============================================================
// auth.js — Authentication Middleware
// ============================================================
// Handles JWT token verification
// Protects API routes so only logged-in users can analyze code
// ============================================================

const jwt = require('jsonwebtoken');
const { getUserById, resetDailyIfNeeded, incrementUsage: dbIncrement } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'archai-secret-key-change-in-production';

// ── FREE TIER LIMITS ─────────────────────────────────────────
const FREE_DAILY_LIMIT = 5;   // Free users: 5 analyses per day
const PRO_DAILY_LIMIT  = 999; // Pro users: unlimited

// ── Generate Token ───────────────────────────────────────────
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

// ── Verify Token Middleware ──────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1]; // "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'Please log in to analyze code.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = getUserById(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User not found. Please log in again.' });
    }

    // Reset daily count if it's a new day
    resetDailyIfNeeded(user);

    // Check daily limit for free users
    const limit = user.plan === 'pro' ? PRO_DAILY_LIMIT : FREE_DAILY_LIMIT;
    if (user.analyses_today >= limit) {
      return res.status(429).json({
        error: `Daily limit reached! Free plan allows ${FREE_DAILY_LIMIT} analyses per day.`,
        upgradeRequired: true,
        plan: user.plan,
        analysesToday: user.analyses_today,
        limit
      });
    }

    req.user = user;
    next();

  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── Increment Usage After Analysis ──────────────────────────
function incrementUsage(userId) {
  dbIncrement(userId);
}

module.exports = { generateToken, requireAuth, incrementUsage, FREE_DAILY_LIMIT };
