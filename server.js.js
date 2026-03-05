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
const razorpay = new Razorpay({ key_id: 'rzp_test_SNSG8RCUWrwAEk', key_secret: 'KcLngPGTVqcRNYzBE968TcSV' });
const crypto2  = require('crypto'); // for payment verification

const { createUser, getUserByEmail, updateUser } = require('./database');
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

    // Create user
    const user  = createUser(name, email, passwordHash);
    const token = generateToken(user.id);

    console.log(`✅ New user registered: ${email}`);
    res.json({ success: true, token, user, freeLimit: FREE_DAILY_LIMIT });

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
  console.log(`🐙 GitHub Token: ${process.env.GITHUB_TOKEN ? '✅ Set (higher rate limits)' : '⚠️  Not set (60 requests/hour limit)'}\n`);
});
