// ============================================================
// database.js — ArchAI User Database (MongoDB + Mongoose)
// ============================================================
// Persistent cloud database — survives Railway redeployments!
// ============================================================
const mongoose = require('mongoose');

// ── Connect to MongoDB ───────────────────────────────────────
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI is not set! Database will not work.');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    console.log('✅ MongoDB connected — persistent cloud database');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

// ── Schemas ──────────────────────────────────────────────────
const analysisSchema = new mongoose.Schema({
  codeSnippet: { type: String, maxlength: 2000 },
  aiResponse:  { type: mongoose.Schema.Types.Mixed },
  mode:        { type: String, enum: ['single', 'codebase', 'github'], default: 'single' },
  timestamp:   { type: Date, default: Date.now }
}, { _id: true });

const userSchema = new mongoose.Schema({
  name:            { type: String, required: true },
  email:           { type: String, required: true, unique: true, lowercase: true },
  password_hash:   { type: String, required: true },
  plan:            { type: String, enum: ['free', 'pro'], default: 'free' },
  email_verified:  { type: Boolean, default: false },
  analyses_today:  { type: Number, default: 0 },
  analyses_total:  { type: Number, default: 0 },
  last_reset:      { type: String, default: () => new Date().toISOString().split('T')[0] },
  analyses:        [analysisSchema],
  pro_since:       { type: String },
  payment_id:      { type: String },
  created_at:      { type: Date, default: Date.now }
});

const verificationTokenSchema = new mongoose.Schema({
  token:      { type: String, required: true, unique: true },
  email:      { type: String, required: true, lowercase: true },
  name:       { type: String },
  expires:    { type: Number, required: true },
  created_at: { type: Date, default: Date.now }
});

const User              = mongoose.model('User', userSchema);
const VerificationToken = mongoose.model('VerificationToken', verificationTokenSchema);

// ── Helper ───────────────────────────────────────────────────
function getToday() { return new Date().toISOString().split('T')[0]; }

// ── User Functions ───────────────────────────────────────────
async function createUser(name, email, passwordHash) {
  const user = new User({
    name,
    email: email.toLowerCase(),
    password_hash: passwordHash,
  });
  await user.save();
  return user.toObject();
}

async function getUserByEmail(email) {
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (user) { user.id = user._id.toString(); }
  return user;
}

async function getUserById(id) {
  const user = await User.findById(id).lean();
  if (user) { user.id = user._id.toString(); }
  return user;
}

async function updateUser(id, updates) {
  const user = await User.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
  if (user) { user.id = user._id.toString(); }
  return user;
}

async function resetDailyIfNeeded(user) {
  const today = getToday();
  if (user.last_reset !== today) {
    await User.findByIdAndUpdate(user._id || user.id, {
      $set: { analyses_today: 0, last_reset: today }
    });
    user.analyses_today = 0;
    user.last_reset = today;
  }
  return user;
}

async function incrementUsage(id) {
  await User.findByIdAndUpdate(id, {
    $inc: { analyses_today: 1, analyses_total: 1 }
  });
}

// ── Verification Token Functions ─────────────────────────────
async function saveVerificationToken(token, email, name, expires) {
  // Remove any existing tokens for this email first
  await VerificationToken.deleteMany({ email: email.toLowerCase() });
  await VerificationToken.create({
    token,
    email: email.toLowerCase(),
    name,
    expires
  });
}

async function getVerificationToken(token) {
  return await VerificationToken.findOne({ token }).lean();
}

async function deleteVerificationToken(token) {
  await VerificationToken.deleteOne({ token });
}

async function deleteVerificationTokensByEmail(email) {
  await VerificationToken.deleteMany({ email: email.toLowerCase() });
}

async function deleteUserByEmail(email) {
  const user = await getUserByEmail(email);
  if (!user) return null;
  await User.deleteOne({ email: email.toLowerCase() });
  await VerificationToken.deleteMany({ email: email.toLowerCase() });
  return user;
}

async function getAllUsers() {
  const users = await User.find({}).lean();
  return users.map(u => ({ ...u, id: u._id.toString() }));
}

// ── Analysis History Functions ───────────────────────────────
async function saveAnalysis(email, codeSnippet, aiResponse, mode = 'single') {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return null;

  const record = {
    codeSnippet: (codeSnippet || '').substring(0, 2000),
    aiResponse,
    mode,
    timestamp: new Date()
  };

  user.analyses.push(record);
  await user.save();

  // Return the newly added record
  const saved = user.analyses[user.analyses.length - 1];
  return saved.toObject();
}

async function getUserAnalyses(email) {
  const user = await User.findOne({ email: email.toLowerCase() }).lean();
  if (!user) return [];
  return user.analyses || [];
}

module.exports = {
  connectDB,
  createUser, getUserByEmail, getUserById, updateUser,
  resetDailyIfNeeded, incrementUsage,
  saveVerificationToken, getVerificationToken,
  deleteVerificationToken, deleteVerificationTokensByEmail,
  deleteUserByEmail, getAllUsers,
  saveAnalysis, getUserAnalyses
};
