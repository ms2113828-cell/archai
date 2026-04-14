require('dotenv').config();
// ============================================================
// server.js — Phase 4 — ArchAI Backend
// ============================================================
// THREE modes now:
// Mode 1: Single file analysis   (Phase 1)
// Mode 2: ZIP codebase upload    (Phase 2)
// Mode 3: GitHub URL analysis    (Phase 3 - NEW!)
// ============================================================



const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const cors      = require('cors');
const path      = require('path');
const multer    = require('multer');
const AdmZip    = require('adm-zip');
const https     = require('https'); // Built into Node.js - fetches GitHub API
const bcrypt   = require('bcryptjs');
const Razorpay = require('razorpay');
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
const crypto2  = require('crypto'); // for payment verification
const { Resend } = require('resend');

// ── Resend Email Client ───────────────────────────────────
// Uses HTTPS API instead of SMTP — bypasses Railway's egress
// firewall that blocks outbound SMTP ports (465/587).
const resend = new Resend(process.env.RESEND_API_KEY);
console.log(`📧 Resend email client initialized (API key ${process.env.RESEND_API_KEY ? 'present' : 'MISSING!'})`);


// Store pending verifications
// (Now persisted in database — see database.js)

const { createUser, getUserByEmail, updateUser, saveVerificationToken, getVerificationToken, deleteVerificationToken, deleteVerificationTokensByEmail, deleteUserByEmail, getAllUsers, saveAnalysis, getUserAnalyses } = require('./database');
const { generateToken, requireAuth, incrementUsage, FREE_DAILY_LIMIT } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ── Rate Limiting (Security Fix) ─────────────────────────────
// Max 20 analysis requests per IP per hour — prevents API abuse
const requestCounts = {};
const RATE_LIMIT    = 20;
const WINDOW_MS     = 60 * 60 * 1000; // 1 hour

function rateLimiter(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!requestCounts[ip]) {
    requestCounts[ip] = { count: 1, resetAt: now + WINDOW_MS };
    return next();
  }
  if (now > requestCounts[ip].resetAt) {
    requestCounts[ip] = { count: 1, resetAt: now + WINDOW_MS };
    return next();
  }
  if (requestCounts[ip].count >= RATE_LIMIT) {
    console.log(`⚠️  Rate limit hit for IP: ${ip}`);
    return res.status(429).json({
      error: `Rate limit reached. Max ${RATE_LIMIT} requests/hour. Please try again later.`
    });
  }
  requestCounts[ip].count++;
  next();
}
// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  Object.keys(requestCounts).forEach(ip => {
    if (now > requestCounts[ip].resetAt) delete requestCounts[ip];
  });
}, WINDOW_MS);

// ── File Upload (ZIP mode) ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' ||
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed!'));
    }
  }
});

// ── Claude AI ────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Supported Code Extensions ────────────────────────────────
const CODE_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx',
  '.py', '.java', '.cpp', '.c', '.h',
  '.cs', '.go', '.rs', '.php', '.rb',
  '.swift', '.kt', '.sql',
  '.html', '.css', '.scss',
  '.json', '.yaml', '.yml', '.md'
];

// ── Folders to Skip ──────────────────────────────────────────
const SKIP_FOLDERS = [
  'node_modules', '.git', 'dist', 'build',
  '.next', '__pycache__', '.venv', 'venv',
  'vendor', 'coverage', '.cache', '.github'
];

// ============================================================
// HELPER: Make HTTPS request (for GitHub API calls)
// Node.js has https built in — no extra package needed!
// ============================================================
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'ArchAI-Code-Reviewer', // GitHub requires a User-Agent
        'Accept': 'application/vnd.github.v3+json',
        ...headers
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Handle GitHub rate limit
          if (res.statusCode === 403) {
            reject(new Error('GitHub API rate limit reached. Please try again in an hour, or add a GitHub token.'));
            return;
          }
          if (res.statusCode === 404) {
            reject(new Error('Repository not found. Make sure the URL is correct and the repo is public.'));
            return;
          }
          resolve({ data: JSON.parse(data), status: res.statusCode });
        } catch (e) {
          reject(new Error('Failed to parse GitHub response'));
        }
      });
    }).on('error', reject);
  });
}

// ============================================================
// HELPER: Parse GitHub URL into owner/repo
// Input:  "https://github.com/facebook/react"
// Output: { owner: "facebook", repo: "react" }
// ============================================================
function parseGitHubUrl(url) {
  try {
    // Clean up the URL
    url = url.trim()
      .replace(/\/$/, '')           // Remove trailing slash
      .replace(/\.git$/, '');        // Remove .git if present

    // Handle various GitHub URL formats
    const patterns = [
      /github\.com\/([^\/]+)\/([^\/\?#]+)/,  // https://github.com/owner/repo
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return { owner: match[1], repo: match[2] };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// HELPER: Fetch all code files from a GitHub repo
// Uses GitHub Contents API recursively
// ============================================================
async function fetchGitHubFiles(owner, repo, githubToken = null) {
  const headers = {};
  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  const baseUrl = `https://api.github.com`;
  const files = [];
  let skipped = 0;

  // Step 1: Get the default branch
  console.log(`  📡 Fetching repo info for ${owner}/${repo}...`);
  const repoInfo = await httpsGet(`${baseUrl}/repos/${owner}/${repo}`, headers);
  const defaultBranch = repoInfo.data.default_branch || 'main';
  console.log(`  🌿 Default branch: ${defaultBranch}`);

  // Step 2: Get the full file tree (recursive = all files at once!)
  console.log(`  📂 Fetching file tree...`);
  const treeUrl = `${baseUrl}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`;
  const treeData = await httpsGet(treeUrl, headers);

  if (!treeData.data.tree) {
    throw new Error('Could not fetch repository file tree');
  }

  const allFiles = treeData.data.tree.filter(item => item.type === 'blob'); // Only files
  console.log(`  📄 Found ${allFiles.length} total files in repo`);

  // Step 3: Filter to only code files, skip unwanted folders
  const codeFiles = allFiles.filter(file => {
    // Check if in a skip folder
    const inSkipFolder = SKIP_FOLDERS.some(folder =>
      file.path.includes(`${folder}/`) || file.path.startsWith(`${folder}/`)
    );
    if (inSkipFolder) { skipped++; return false; }

    // Check if it's a code file
    const hasCodeExt = CODE_EXTENSIONS.some(ext => file.path.endsWith(ext));
    if (!hasCodeExt) { skipped++; return false; }

    // Skip very large files (over 100KB)
    if (file.size > 100000) { skipped++; return false; }

    return true;
  });

  console.log(`  ✅ ${codeFiles.length} code files to analyze (${skipped} skipped)`);

  // Step 4: Limit to 25 files for large repos
  const filesToFetch = codeFiles.slice(0, 25);
  if (codeFiles.length > 25) {
    console.log(`  ⚠️  Large repo — fetching 25 most important files`);
  }

  // Step 5: Fetch content of each file
  console.log(`  📥 Downloading file contents...`);
  for (const file of filesToFetch) {
    try {
      const contentUrl = `${baseUrl}/repos/${owner}/${repo}/contents/${file.path}`;
      const contentData = await httpsGet(contentUrl, headers);

      // GitHub returns content as base64
      if (contentData.data.encoding === 'base64') {
        const content = Buffer.from(contentData.data.content, 'base64').toString('utf8');

        if (content.trim()) {
          files.push({
            path:      file.path,
            content:   content,
            extension: path.extname(file.path).toLowerCase(),
            size:      content.length,
            lines:     content.split('\n').length,
          });
        }
      }

      // Small delay to be respectful to GitHub API
      await new Promise(r => setTimeout(r, 100));

    } catch (e) {
      console.log(`  ⚠️  Skipped ${file.path}: ${e.message}`);
      skipped++;
    }
  }

  return { files, skipped, totalFiles: allFiles.length, repoName: `${owner}/${repo}` };
}

// ============================================================
// HELPER: Build project structure tree
// ============================================================
function buildProjectStructure(files) {
  const lines = [];
  const seen  = new Set();

  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const indent = '  '.repeat(i - 1);
      const name   = parts[i];
      const key    = parts.slice(0, i + 1).join('/');
      if (!seen.has(key)) {
        seen.add(key);
        if (i === parts.length - 1) {
          lines.push(`${indent}📄 ${name} (${file.lines} lines)`);
        } else {
          lines.push(`${indent}📁 ${name}/`);
        }
      }
    }
  }

  return lines.join('\n') || files.map(f => f.path).join('\n');
}

// ============================================================
// PROMPT: Single File (Phase 1)
// ============================================================
function buildSingleFilePrompt(code, language, context) {
  return `You are an elite software architect with 20+ years of experience.
Analyze this ${language} code through 4 deep reasoning layers.

${context ? `DEVELOPER CONTEXT: ${context}\n` : ''}

\`\`\`${language}
${code}
\`\`\`

LAYER 1 — UNDERSTAND: What is this code doing and what was the developer trying to achieve?
LAYER 2 — ANALYZE: Find all bugs and issues (critical, architectural, performance, best practices)
LAYER 3 — ARCHITECTURAL REASONING: Think about scalability, security, maintainability
LAYER 4 — FIX & EXPLAIN: Provide corrected code with every change explained

Respond ONLY with valid JSON:
{
  "summary": "What this code does",
  "intentUnderstanding": "What the developer was trying to accomplish",
  "issues": {
    "critical":      [{"title": "...", "description": "...", "line": "...", "impact": "..."}],
    "architectural": [{"title": "...", "description": "...", "impact": "..."}],
    "performance":   [{"title": "...", "description": "...", "impact": "..."}],
    "bestPractices": [{"title": "...", "description": "..."}]
  },
  "totalIssues": 0,
  "fixedCode": "complete corrected code here",
  "changeLog": [{"change": "...", "reason": "...", "layer": "bug|architecture|performance|bestpractice"}],
  "architecturalRecommendations": [{"title": "...", "description": "...", "priority": "high|medium|low"}],
  "overallHealthScore": 75,
  "healthLabel": "Needs Work"
}`;
}

// ============================================================
// PROMPT: Full Codebase (Phase 2 & 3 — same prompt!)
// ============================================================
function buildCodebasePrompt(files, projectStructure, context, repoName = null) {
  const filesSummary = files.map(f => {
    const preview = f.content.length > 2500
      ? f.content.substring(0, 2500) + '\n\n[... file continues ...]'
      : f.content;
    return `\n${'─'.repeat(50)}\nFILE: ${f.path} | ${f.lines} lines\n${'─'.repeat(50)}\n${preview}`;
  }).join('\n');

  return `You are an elite software architect reviewing an ENTIRE codebase.
${repoName ? `Repository: ${repoName}` : ''}
${context ? `DEVELOPER CONTEXT: ${context}` : ''}

PROJECT STRUCTURE:
${projectStructure}

FILES: ${files.length} | TOTAL LINES: ${files.reduce((s, f) => s + f.lines, 0)}

${filesSummary}

LAYER 1 — UNDERSTAND THE PROJECT: What type of project, purpose, tech stack, how files connect
LAYER 2 — FIND CROSS-FILE ISSUES: Critical bugs, architectural problems, performance, best practices
LAYER 3 — DEEP ARCHITECTURAL REASONING: Separation of concerns, coupling, scalability, security, maintainability
LAYER 4 — ACTION PLAN: Specific prioritized actions with exact files to change

Respond ONLY with valid JSON:
{
  "projectSummary": "What this project is",
  "techStack": ["technologies", "detected"],
  "projectType": "web app | API | library | etc",
  "intentUnderstanding": "What the developer is building",
  "overallHealthScore": 72,
  "healthLabel": "Needs Work",
  "issues": {
    "critical":      [{"title": "...", "description": "...", "file": "...", "impact": "..."}],
    "architectural": [{"title": "...", "description": "...", "file": "...", "impact": "..."}],
    "performance":   [{"title": "...", "description": "...", "file": "...", "impact": "..."}],
    "bestPractices": [{"title": "...", "description": "...", "file": "..."}]
  },
  "totalIssues": 0,
  "architecturalAnalysis": {
    "separationOfConcerns": "...",
    "coupling": "...",
    "scalability": "...",
    "security": "...",
    "maintainability": "..."
  },
  "fileAnalysis": [
    {"file": "...", "purpose": "...", "issues": 0, "healthScore": 80, "keyProblems": ["..."]}
  ],
  "actionPlan": [
    {"priority": 1, "action": "...", "file": "...", "reason": "...", "effort": "low|medium|high"}
  ],
  "architecturalRecommendations": [{"title": "...", "description": "...", "priority": "high|medium|low"}],
  "missingPieces": ["things that should exist but dont"]
}`;
}

// ============================================================


// ── Email Verification Routes ─────────────────────────────

// Helper: Send verification email with token
async function sendVerificationEmail(email, name, token) {
  const baseUrl = process.env.BASE_URL || 'https://archai-production-74d9.up.railway.app';
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;
  console.log(`📧 Sending verification email to ${email} — link: ${verifyUrl}`);

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'ArchAI <onboarding@resend.dev>',
      to: [email],
      subject: '⚡ Verify your ArchAI account',
      html: `
        <div style="background:#03030a;padding:40px;font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border-radius:16px">
          <div style="text-align:center">
            <h1 style="color:#a78bfa;font-size:32px;margin-bottom:4px;font-family:monospace">ARCH<span style="color:#00f5ff">AI</span></h1>
            <p style="color:#5a5a7a;font-size:11px;margin-bottom:30px;letter-spacing:3px">DEEP CODE INTELLIGENCE ENGINE</p>
          </div>
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(108,79,255,0.2);border-radius:12px;padding:30px;margin-bottom:20px">
            <h2 style="color:#ffffff;font-size:20px;margin-bottom:12px">Welcome, ${name}! 👋</h2>
            <p style="color:#a0b4d0;line-height:1.8;font-size:14px">Thank you for joining ArchAI! Please verify your email to activate your free account with <strong style="color:#a78bfa">5 deep analyses per day</strong>.</p>
            <div style="text-align:center;margin:28px 0">
              <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#6c4fff,#9333ea);color:#fff;text-decoration:none;padding:16px 40px;border-radius:12px;font-weight:700;font-size:14px;letter-spacing:0.5px">⚡ Verify My Email</a>
            </div>
            <p style="color:#5a5a7a;font-size:12px;text-align:center">This link expires in <strong style="color:#a0b4d0">24 hours</strong>.</p>
          </div>
          <p style="color:#5a5a7a;font-size:11px;text-align:center">If you didn't create an account, you can safely ignore this email.</p>
          <hr style="border:none;border-top:1px solid rgba(108,79,255,0.15);margin:20px 0">
          <p style="color:#5a5a7a;font-size:11px;text-align:center">ArchAI — Code That Thinks Before It Fixes</p>
        </div>
      `
    });

    if (error) {
      console.error('❌ Resend API error:', error);
      throw new Error(error.message || 'Resend API returned an error');
    }

    console.log(`✅ Email sent successfully — id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email failed:', err);
    throw err;  // Re-throw so callers can handle it
  }
}

// GET /api/auth/verify-email — User clicks this link from their email
app.get('/api/auth/verify-email', async (req, res) => {
  const { token } = req.query;

  console.log(`🔍 Verify-email hit — token: ${token ? token.substring(0, 12) + '...' : 'MISSING'}`);

  // Check if token exists and is valid
  const pending = getVerificationToken(token);
  console.log(`🔍 Token lookup result: ${pending ? `found for ${pending.email}` : 'NOT FOUND'}`);

  if (!token || !pending) {
    return res.send(`<!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <style>
      body{background:#03030a;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:60px;margin:0}
      h1{color:#a78bfa;font-size:32px;margin-bottom:4px;font-family:monospace}
      .tag{color:#5a5a7a;font-size:11px;letter-spacing:3px;margin-bottom:40px}
      h2{color:#ff4757;font-size:22px;margin-bottom:16px}
      p{color:#a0b4d0;line-height:1.8;font-size:14px}
      a{color:#a78bfa;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
    </head>
    <body>
      <h1>ARCH<span style="color:#00f5ff">AI</span></h1>
      <div class="tag">DEEP CODE INTELLIGENCE ENGINE</div>
      <h2>❌ Invalid or Expired Link</h2>
      <p>This verification link is invalid or has expired.<br>Please <a href="/login.html">register again</a> or request a new verification email.</p>
    </body></html>`);
  }

  // Check if token has expired
  if (Date.now() > pending.expires) {
    deleteVerificationToken(token);
    return res.send(`<!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <style>
      body{background:#03030a;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:60px;margin:0}
      h1{color:#a78bfa;font-size:32px;margin-bottom:4px;font-family:monospace}
      .tag{color:#5a5a7a;font-size:11px;letter-spacing:3px;margin-bottom:40px}
      h2{color:#ff4757;font-size:22px;margin-bottom:16px}
      p{color:#a0b4d0;line-height:1.8;font-size:14px}
      a{color:#a78bfa;text-decoration:none}
      a:hover{text-decoration:underline}
    </style>
    </head>
    <body>
      <h1>ARCH<span style="color:#00f5ff">AI</span></h1>
      <div class="tag">DEEP CODE INTELLIGENCE ENGINE</div>
      <h2>⏰ Link Expired</h2>
      <p>This verification link has expired (24h limit).<br>Please <a href="/login.html">log in</a> and request a new verification email.</p>
    </body></html>`);
  }

  // Mark user as verified in database
  const user = getUserByEmail(pending.email);
  if (user) {
    updateUser(user.id, { email_verified: true });
    console.log(`✅ Email verified: ${pending.email}`);
  }

  // Clean up used token
  deleteVerificationToken(token);

  res.send(`<!DOCTYPE html>
  <html><head><meta charset="UTF-8">
  <meta http-equiv="refresh" content="3;url=/login.html">
  <style>
    body{background:#03030a;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:60px;margin:0}
    h1{color:#a78bfa;font-size:32px;margin-bottom:4px;font-family:monospace}
    .tag{color:#5a5a7a;font-size:11px;letter-spacing:3px;margin-bottom:40px}
    h2{color:#00ff9d;font-size:24px;margin-bottom:16px}
    p{color:#a0b4d0;line-height:1.8;font-size:14px}
    .btn{display:inline-block;background:linear-gradient(135deg,#6c4fff,#9333ea);color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-weight:700;margin:20px 0;font-size:14px}
    .btn:hover{box-shadow:0 8px 30px rgba(108,79,255,.5)}
    .countdown{color:#5a5a7a;font-size:12px;margin-top:10px}
  </style>
  </head>
  <body>
    <h1>ARCH<span style="color:#00f5ff">AI</span></h1>
    <div class="tag">DEEP CODE INTELLIGENCE ENGINE</div>
    <h2>✓ Email Verified Successfully!</h2>
    <p>Your account is now active!<br>You have <strong style="color:#a78bfa">5 free analyses per day!</strong></p>
    <a href="/login.html" class="btn">→ Sign In to ArchAI</a>
    <div class="countdown">Redirecting to login in 3 seconds...</div>
  </body></html>`);
});

// POST /api/auth/resend-verification — Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account found with this email.' });
  if (user.email_verified) return res.json({ success: true, message: 'Email is already verified! You can log in.' });

  // Invalidate any existing tokens for this email
  deleteVerificationTokensByEmail(email);

  // Generate new token
  const token = crypto2.randomBytes(32).toString('hex');
  const expires = Date.now() + 24*60*60*1000;
  saveVerificationToken(token, email.toLowerCase(), user.name, expires);

  try {
    await sendVerificationEmail(email, user.name, token);
    console.log(`📧 Verification email re-sent to: ${email}`);
    res.json({ success: true, message: 'Verification email sent! Check your inbox.' });
  } catch (err) {
    console.error('Resend email error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please try again.' });
  }
});

// ── Guest Trial Route (no auth required) ─────────────────────
let guestTrialUsed = {}; // Track by IP

app.post('/api/guest-analyze', rateLimiter, async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  
  if (guestTrialUsed[ip]) {
    return res.status(403).json({ error: 'Guest trial already used. Please create a free account for 5 analyses per day!' });
  }

  const { code } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'No code provided.' });

  try {
    const prompt = `You are ArchAI — a senior code reviewer with 10 years of experience.

Analyze this code in 4 deep layers:

LAYER 1 — UNDERSTAND: What does this code do?
LAYER 2 — ANALYZE: Bugs, security issues, performance problems
LAYER 3 — ARCHITECT: Design and structural improvements  
LAYER 4 — FIX & EXPLAIN: Specific fixes with code examples

Code to analyze:
\`\`\`
${code}
\`\`\`

Be thorough, specific, and actionable.`;

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    guestTrialUsed[ip] = true;
    
    // Clear after 24 hours
    setTimeout(() => { delete guestTrialUsed[ip]; }, 24 * 60 * 60 * 1000);

    res.json({ result: message.content[0].text, guest: true });
  } catch (err) {
    console.error('Guest analysis error:', err.message);
    res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }
});

// ROUTE 1: Single File — POST /api/analyze
// ============================================================
app.post('/api/analyze', rateLimiter, requireAuth, async (req, res) => {
  try {
    const { code, language, context } = req.body;
    if (!code || code.trim() === '') {
      return res.status(400).json({ error: 'No code provided.' });
    }

    console.log(`\n🔍 Single file: ${language} (${code.length} chars)...`);

    const message = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: buildSingleFilePrompt(code, language, context) }]
    });

    const responseText = message.content[0].text;
    let result;
    try {
      const match = responseText.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { rawResponse: responseText };
    } catch (e) {
      result = { rawResponse: responseText };
    }

    console.log(`✅ Done! Score: ${result.overallHealthScore}`);
    incrementUsage(req.user.id);

    // Save analysis to user history
    saveAnalysis(req.user.email, code, result, 'single');

    res.json({ success: true, analysis: result });

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (error.status === 429) return res.status(429).json({ error: 'Rate limit. Try again.' });
    res.status(500).json({ error: `Analysis failed: ${error.message}` });
  }
});

// ============================================================
// ROUTE 2: ZIP Codebase — POST /api/analyze-codebase
// ============================================================
app.post('/api/analyze-codebase', rateLimiter, requireAuth, upload.single('codebase'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a ZIP file.' });
    }

    const context = req.body.context || '';
    console.log(`\n📦 ZIP: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)}KB)`);

    // Extract files from ZIP
    const zip     = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const files   = [];
    let skipped   = 0;

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const filePath = entry.entryName;

      const shouldSkip = SKIP_FOLDERS.some(f =>
        filePath.includes(`/${f}/`) || filePath.startsWith(`${f}/`)
      );
      if (shouldSkip) { skipped++; continue; }

      const hasCodeExt = CODE_EXTENSIONS.some(e => filePath.endsWith(e));
      if (!hasCodeExt) { skipped++; continue; }

      try {
        const content = entry.getData().toString('utf8');
        if (!content.trim() || content.length > 100000) { skipped++; continue; }
        files.push({
          path: filePath, content,
          extension: path.extname(filePath).toLowerCase(),
          size: content.length,
          lines: content.split('\n').length,
        });
      } catch (e) { skipped++; }
    }

    if (files.length === 0) {
      return res.status(400).json({ error: 'No code files found in ZIP.' });
    }

    console.log(`📂 ${files.length} files found (${skipped} skipped)`);

    const projectStructure = buildProjectStructure(files);
    const filesToAnalyze   = files.length > 25 ? files.sort((a,b) => a.size - b.size).slice(0,25) : files;

    const message = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: buildCodebasePrompt(filesToAnalyze, projectStructure, context) }]
    });

    let result;
    try {
      const match = message.content[0].text.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { rawResponse: message.content[0].text };
    } catch (e) {
      result = { rawResponse: message.content[0].text };
    }

    result.totalFiles    = files.length;
    result.totalLines    = files.reduce((s,f) => s+f.lines, 0);
    result.filesAnalyzed = filesToAnalyze.length;

    console.log(`✅ ZIP done! Score: ${result.overallHealthScore}`);
    incrementUsage(req.user.id);

    // Save analysis to user history
    const snippetSummary = `ZIP: ${req.file.originalname} (${files.length} files, ${files.reduce((s,f) => s+f.lines, 0)} lines)`;
    saveAnalysis(req.user.email, snippetSummary, result, 'codebase');

    res.json({ success: true, analysis: result, mode: 'codebase' });

  } catch (error) {
    console.error('❌ ZIP error:', error.message);
    res.status(500).json({ error: `ZIP analysis failed: ${error.message}` });
  }
});

// ============================================================
// ROUTE 3: GitHub — POST /api/analyze-github  ← NEW!
// ============================================================
app.post('/api/analyze-github', rateLimiter, requireAuth, async (req, res) => {
  try {
    const { repoUrl, context, githubToken } = req.body;

    if (!repoUrl || repoUrl.trim() === '') {
      return res.status(400).json({ error: 'Please provide a GitHub repository URL.' });
    }

    // Parse the GitHub URL
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return res.status(400).json({
        error: 'Invalid GitHub URL. Please use format: https://github.com/username/repository'
      });
    }

    const { owner, repo } = parsed;
    console.log(`\n🐙 GitHub: ${owner}/${repo}`);

    // Fetch all files from GitHub
    const { files, skipped, totalFiles, repoName } = await fetchGitHubFiles(
      owner, repo,
      githubToken || process.env.GITHUB_TOKEN || null
    );

    if (files.length === 0) {
      return res.status(400).json({
        error: 'No code files found in this repository. Make sure it is a public repo with code files.'
      });
    }

    console.log(`🧠 Analyzing ${files.length} files from ${repoName}...`);

    const projectStructure = buildProjectStructure(files);

    const message = await anthropic.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 8000,
      messages:   [{
        role:    'user',
        content: buildCodebasePrompt(files, projectStructure, context, repoName)
      }]
    });

    let result;
    try {
      const match = message.content[0].text.match(/\{[\s\S]*\}/);
      result = match ? JSON.parse(match[0]) : { rawResponse: message.content[0].text };
    } catch (e) {
      result = { rawResponse: message.content[0].text };
    }

    // Add GitHub-specific stats
    result.totalFiles    = totalFiles;
    result.filesAnalyzed = files.length;
    result.totalLines    = files.reduce((s,f) => s+f.lines, 0);
    result.repoName      = repoName;
    result.repoUrl       = repoUrl;

    console.log(`✅ GitHub done! Score: ${result.overallHealthScore}`);
    incrementUsage(req.user.id);

    // Save analysis to user history
    const snippetSummary = `GitHub: ${repoName} (${files.length} files, ${files.reduce((s,f) => s+f.lines, 0)} lines)`;
    saveAnalysis(req.user.email, snippetSummary, result, 'github');

    res.json({ success: true, analysis: result, mode: 'github', repoName });

  } catch (error) {
    console.error('❌ GitHub error:', error.message);
    if (error.message.includes('rate limit')) {
      return res.status(429).json({ error: error.message });
    }
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: `GitHub analysis failed: ${error.message}` });
  }
});


// ============================================================
// AUTH ROUTE: Register — POST /api/auth/register
// ============================================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash password securely
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user (email_verified defaults to false in database.js)
    const user = createUser(name, email, passwordHash);

    // Generate verification token and store it in database
    const verificationToken = crypto2.randomBytes(32).toString('hex');
    const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    saveVerificationToken(verificationToken, email.toLowerCase(), name, expires);

    // ── NON-BLOCKING email dispatch ──────────────────────────
    // Respond to the frontend immediately — don't let a slow SMTP
    // connection hold up the HTTP request for 2 minutes.
    // The email fires in the background; errors are logged, not thrown.
    sendVerificationEmail(email, name, verificationToken)
      .then(() => console.log(`✅ Verification email sent to: ${email}`))
      .catch(err => console.error(`❌ Background email failed for ${email}:`, err));

    console.log(`✅ New user registered: ${email} — verification email queued`);

    res.status(201).json({
      success: true,
      needsVerification: true,
      message: 'Account created! Please check your email and click the verification link to activate your account.',
      email: email
    });

  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ============================================================
// AUTH ROUTE: Login — POST /api/auth/login
// ============================================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Block login if email not verified
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in. Check your inbox for the verification link.',
        needsVerification: true,
        email: user.email
      });
    }

    const token = generateToken(user.id);
    const { password_hash, ...safeUser } = user;

    console.log(`✅ User logged in: ${email}`);
    res.json({ success: true, token, user: safeUser, freeLimit: FREE_DAILY_LIMIT });

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ============================================================
// AUTH ROUTE: Get Profile — GET /api/auth/profile
// ============================================================
app.get('/api/auth/profile', requireAuth, (req, res) => {
  const { password_hash, ...safeUser } = req.user;
  res.json({ success: true, user: safeUser, freeLimit: FREE_DAILY_LIMIT });
});

// ============================================================
// HISTORY ROUTE: Get Analysis History — GET /api/history
// ============================================================
app.get('/api/history', requireAuth, (req, res) => {
  try {
    const analyses = getUserAnalyses(req.user.email);

    // Return newest first
    const sorted = [...analyses].reverse();

    res.json({
      success: true,
      count: sorted.length,
      analyses: sorted
    });
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch analysis history.' });
  }
});


// ============================================================
// PAYMENT ROUTE 1: Create Order — POST /api/payment/create-order
// ============================================================
app.post('/api/payment/create-order', requireAuth, async (req, res) => {
  try {
    const amount   = 99900; // ₹999 in paise (Razorpay uses paise)
    const currency = 'INR';

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `archai_${req.user.id}_${Date.now()}`,
      notes: { userId: req.user.id, plan: 'pro' }
    });

    console.log(`💳 Payment order created for user: ${req.user.email}`);
    res.json({
      success:  true,
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      keyId:    process.env.RAZORPAY_KEY_ID,
      userName: req.user.name,
      userEmail: req.user.email
    });

  } catch (err) {
    console.error('Payment order error:', err.message);
    res.status(500).json({ error: 'Could not create payment order. Please try again.' });
  }
});

// ============================================================
// PAYMENT ROUTE 2: Verify Payment — POST /api/payment/verify
// ============================================================
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Verify signature (security check — makes sure payment is real)
    const body      = razorpay_order_id + '|' + razorpay_payment_id;
    const expected  = crypto2
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret')
      .update(body)
      .digest('hex');

    if (expected !== razorpay_signature) {
      console.log(`⚠️  Invalid payment signature for user: ${req.user.email}`);
      return res.status(400).json({ error: 'Payment verification failed. Please contact support.' });
    }

    // Upgrade user to Pro!
    updateUser(req.user.id, {
      plan:       'pro',
      pro_since:  new Date().toISOString(),
      payment_id: razorpay_payment_id
    });

    console.log(`⭐ User upgraded to Pro: ${req.user.email}`);
    res.json({ success: true, message: 'Welcome to ArchAI Pro! 🎉', plan: 'pro' });

  } catch (err) {
    console.error('Payment verify error:', err.message);
    res.status(500).json({ error: 'Payment verification failed.' });
  }
});

// ── Health Check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'running',
    phase:     3,
    modes:     ['single-file', 'zip-upload', 'github'],
    apiKeySet: !!process.env.ANTHROPIC_API_KEY
  });
});

// ── Admin Routes (for testing/debugging) ─────────────────────
// DELETE a user by email (for testing reset)
app.delete('/api/admin/user/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const deleted = deleteUserByEmail(email);
  if (deleted) {
    console.log(`🗑️  Admin: deleted user ${email}`);
    res.json({ success: true, message: `User ${email} and their tokens deleted.` });
  } else {
    res.status(404).json({ error: `No user found with email: ${email}` });
  }
});

// LIST all users (for debugging)
app.get('/api/admin/users', (req, res) => {
  const users = getAllUsers().map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    plan: u.plan,
    email_verified: u.email_verified,
    created_at: u.created_at
  }));
  res.json({ users, count: users.length });
});

// ── Serve Frontend ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║      ArchAI Phase 4 — RUNNING! 🚀            ║`);
  console.log(`║  Single File + ZIP + GitHub + Auth System    ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\n🌐 Open: http://localhost:${PORT}`);
  console.log(`🔑 API Key:    ${process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`🐙 GitHub Token: ${process.env.GITHUB_TOKEN ? '✅ Set (higher rate limits)' : '⚠️  Not set (60 requests/hour limit)'}`);
  console.log(`📧 EMAIL_USER: ${process.env.EMAIL_USER ? '✅ ' + process.env.EMAIL_USER : '❌ Missing'}`);
  console.log(`📧 EMAIL_PASS: ${process.env.EMAIL_PASS ? '✅ Set (' + process.env.EMAIL_PASS.length + ' chars)' : '❌ Missing'}\n`);
});
