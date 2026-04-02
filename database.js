// ============================================================
// database.js — ArchAI User Database (lowdb - pure JS!)
// ============================================================
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path     = require('path');
const crypto   = require('crypto');

const adapter = new FileSync(path.join(__dirname, 'archai-db.json'));
const db      = low(adapter);

db.defaults({ users: [], verification_tokens: [] }).write();
console.log('✅ Database ready — archai-db.json');

function generateId() { return crypto.randomBytes(8).toString('hex'); }
function getToday()   { return new Date().toISOString().split('T')[0]; }

function createUser(name, email, passwordHash) {
  const user = {
    id: generateId(), name,
    email: email.toLowerCase(),
    password_hash: passwordHash,
    plan: 'free',
    email_verified: false,
    analyses_today: 0, analyses_total: 0,
    last_reset: getToday(),
    created_at: new Date().toISOString()
  };
  db.get('users').push(user).write();
  return user;
}

function getUserByEmail(email) {
  return db.get('users').find({ email: email.toLowerCase() }).value();
}

function getUserById(id) {
  return db.get('users').find({ id }).value();
}

function updateUser(id, updates) {
  db.get('users').find({ id }).assign(updates).write();
  return getUserById(id);
}

function resetDailyIfNeeded(user) {
  const today = getToday();
  if (user.last_reset !== today) {
    updateUser(user.id, { analyses_today: 0, last_reset: today });
    user.analyses_today = 0;
  }
  return user;
}

function incrementUsage(id) {
  const user = getUserById(id);
  if (user) {
    updateUser(id, {
      analyses_today: (user.analyses_today || 0) + 1,
      analyses_total: (user.analyses_total || 0) + 1
    });
  }
}

// ── Verification Token Functions ─────────────────────────────
function saveVerificationToken(token, email, name, expires) {
  // Remove any existing tokens for this email first
  db.get('verification_tokens').remove({ email: email.toLowerCase() }).write();
  db.get('verification_tokens').push({
    token,
    email: email.toLowerCase(),
    name,
    expires,
    created_at: new Date().toISOString()
  }).write();
}

function getVerificationToken(token) {
  return db.get('verification_tokens').find({ token }).value();
}

function deleteVerificationToken(token) {
  db.get('verification_tokens').remove({ token }).write();
}

function deleteVerificationTokensByEmail(email) {
  db.get('verification_tokens').remove({ email: email.toLowerCase() }).write();
}

module.exports = {
  createUser, getUserByEmail, getUserById, updateUser,
  resetDailyIfNeeded, incrementUsage,
  saveVerificationToken, getVerificationToken,
  deleteVerificationToken, deleteVerificationTokensByEmail
};
