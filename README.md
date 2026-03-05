# ArchAI — Deep Code Intelligence Engine

> Unlike other tools, ArchAI reasons through **4 deep layers** before fixing your code.
> It understands your intent, analyzes bugs, thinks architecturally, then delivers precise fixes.

---

## 🚀 How to Run (Step by Step)

### Step 1 — Get the API Key
1. Go to https://console.anthropic.com
2. Sign up / Log in
3. Click "API Keys" and create a new key
4. Copy the key

### Step 2 — Setup the .env file
1. In your project folder, rename `.env.example` to `.env`
2. Open `.env` and replace `your_api_key_here` with your actual API key:
```
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
```

### Step 3 — Install dependencies
Open your terminal in the project folder and run:
```bash
npm install
```
This downloads all required packages (Express, Anthropic SDK, etc.)

### Step 4 — Start the server
```bash
npm start
```
You should see:
```
╔════════════════════════════════════╗
║   Code Review Bot is RUNNING! 🚀   ║
╚════════════════════════════════════╝
Open your browser: http://localhost:3000
```

### Step 5 — Open the app
Open your browser and go to: **http://localhost:3000**

---

## 🧠 How the 4-Layer Reasoning Works

| Layer | What it does |
|-------|-------------|
| **Layer 1 — Understand** | Reads the code and understands the developer's intent |
| **Layer 2 — Analyze** | Finds all bugs, sorted by severity (Critical / Architectural / Performance / Best Practices) |
| **Layer 3 — Architect** | Thinks about the big picture — design patterns, scalability, maintainability |
| **Layer 4 — Fix & Explain** | Produces corrected code with inline comments explaining every change |

---

## 📁 File Structure

```
code-review-bot/
├── server.js          ← Backend (Node.js + Express + Claude API)
├── package.json       ← Project config & dependencies
├── .env               ← Your API key (NEVER share or commit this)
├── .env.example       ← Template for the .env file
├── .gitignore         ← Prevents .env from being committed to GitHub
└── public/
    └── index.html     ← The entire frontend (UI)
```

---

## 🔮 Coming Next (Phase 2)

- Upload ZIP files for full codebase analysis
- GitHub repo integration
- User accounts and history
- Enterprise team features

---

## ⚠️ Important Security Rules

1. **Never share your `.env` file** — it contains your secret API key
2. **Never commit `.env` to GitHub** — the `.gitignore` protects you from this
3. If you accidentally expose your key, go to console.anthropic.com and delete it immediately, then create a new one
