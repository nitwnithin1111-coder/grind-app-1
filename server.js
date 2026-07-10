// server.js — GRIND AI backend
// Express + MongoDB + Passport(Google) + Socket.io multiplayer + multi-provider AI fallback
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── TRUST PROXY (CRITICAL FIX) ───────────────────────────
// Render/Railway/Heroku/etc terminate HTTPS at a load balancer and forward
// plain HTTP to your app. Without this, Express thinks every request is
// insecure, so a `secure` cookie is silently never set/sent back — the
// browser looks "logged in" for one request (right after the OAuth
// redirect) then immediately loses the session on the very next request,
// which is exactly what causes a login → home → login loop.
app.set('trust proxy', 1);

const isProd = process.env.NODE_ENV === 'production';

// ── STARTUP ENV VALIDATION ────────────────────────────────
// Fail loud, not silent. A missing/mismatched GOOGLE_CALLBACK_URL is the
// #2 cause of login loops (Google Console redirect URI must match this
// EXACTLY — same protocol, host, and path, no trailing slash difference).
(function validateEnv() {
  const required = ['MONGODB_URI', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.warn('⚠️  Missing env vars:', missing.join(', '));
  }
  if (process.env.GOOGLE_CALLBACK_URL && !process.env.GOOGLE_CALLBACK_URL.startsWith('https://') && isProd) {
    console.warn('⚠️  GOOGLE_CALLBACK_URL is not https:// while NODE_ENV=production — this will break OAuth/session cookies.');
  }
})();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ───────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: String,
  name: { type: String, required: true },
  photo: { type: String, default: '' },
  gender: { type: String, default: '' },
  exam: { type: String, default: '' },
  class: { type: String, default: '' },
  coaching: { type: String, default: '' },
  biggestStruggle: { type: String, default: '' },
  hoursPerDay: { type: String, default: '' },
  isOnboarded: { type: Boolean, default: false },
  streak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  responseSpeed: { type: String, default: 'balanced' },
  examDate: { type: Date, default: null },
  quizXP: { type: Number, default: 0 },
  quizLevel: { type: Number, default: 1 },
  totalQSolved: { type: Number, default: 0 },
  totalQCorrect: { type: Number, default: 0 },
  quizStreak: { type: Number, default: 0 },
  maxQuizStreak: { type: Number, default: 0 },
  achievements: [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP: { type: Number, default: 0 },
  weeklyXPReset: { type: Date, default: Date.now },
  weakTopics: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  lastMoodDate: { type: String, default: '' },
  dailyChallengeDate: { type: String, default: '' },
  dailyChallengeXP: { type: Number, default: 0 },
  totalStudyMins: { type: Number, default: 0 },
  pomodoroSessions: { type: Number, default: 0 },
  coins: { type: Number, default: 0 },
  gems: { type: Number, default: 0 },
  loginStreak: { type: Number, default: 0 },
  lastLoginDate: { type: String, default: '' },
  lastDailyRewardClaim: { type: String, default: '' },
  rankTier: { type: String, default: 'Bronze' },
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New Conversation' },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const mistakeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question: String,
  subject: String,
  chapter: String,
  topic: String,
  explanation: String,
  cheatSheet: { type: String, default: '' },
  trapAlert: { type: String, default: '' },
  userAnswer: String,
  correctAnswer: String,
  isPYQ: { type: Boolean, default: false },
  pyqYear: { type: String, default: '' },
  pyqExam: { type: String, default: '' },
  weekKey: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const plannerTaskSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  subject: { type: String, default: '' },
  priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  estimatedMins: { type: Number, default: 60 },
  status: { type: String, enum: ['pending', 'completed', 'missed', 'archived'], default: 'pending' },
  scheduledDate: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  notes: { type: String, default: '' },
  aiGenerated: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const pyqSchema = new mongoose.Schema({
  subject: String,
  chapter: String,
  exam: String,
  year: String,
  shift: String,
  question: String,
  options: [String],
  answer: String,
  explanation: String,
  cheatSheet: String,
  trapAlert: String,
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const moodSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mood: { type: Number, min: 1, max: 5, required: true },
  note: { type: String, default: '' },
  date: { type: String, required: true }
}, { timestamps: true });

const formulaSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: String,
  chapter: String,
  formula: { type: String, required: true },
  context: String,
  nextReview: { type: Date, default: Date.now },
  interval: { type: Number, default: 1 },
  repetitions: { type: Number, default: 0 },
  easeFactor: { type: Number, default: 2.5 }
}, { timestamps: true });

const storySessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: String,
  chapter: String,
  exam: String,
  round1Score: Number,
  round2Score: Number,
  improvement: Number,
  xpEarned: Number,
  wrongConcepts: [String]
}, { timestamps: true });

const bossSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject: String,
  chapter: String,
  type: { type: String, enum: ['chapter', 'world'], default: 'chapter' },
  score: Number,
  total: Number,
  beaten: { type: Boolean, default: false },
  xpEarned: Number
}, { timestamps: true });

const dailyChallengeSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  subject: String,
  chapter: String,
  question: String,
  options: [String],
  answer: String,
  explanation: String,
  cheatSheet: String,
  xpReward: { type: Number, default: 150 },
  coinsReward: { type: Number, default: 50 },
  solvedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const PYQ = mongoose.model('PYQ', pyqSchema);
const Mood = mongoose.model('Mood', moodSchema);
const Formula = mongoose.model('Formula', formulaSchema);
const StorySession = mongoose.model('StorySession', storySessionSchema);
const BossBattle = mongoose.model('BossBattle', bossSchema);
const DailyChallenge = mongoose.model('DailyChallenge', dailyChallengeSchema);

// ── SESSION & PASSPORT ────────────────────────────────────
const sessionStore = MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  touchAfter: 24 * 3600 // only re-save session once per 24h unless data changed
});
sessionStore.on('error', (err) => console.error('❌ Session store error:', err.message));

app.use(session({
  name: 'grind.sid',
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  proxy: true, // trust the X-Forwarded-Proto header from the platform's proxy
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    // 'auto' checks req.secure (which correctly reflects X-Forwarded-Proto
    // because of app.set('trust proxy', 1) above) instead of trusting
    // NODE_ENV, which some hosts (Railway, etc.) don't set to 'production'.
    // This is the single most common reason this exact symptom happens.
    secure: 'auto',
    sameSite: 'lax'       // 'lax' allows the cookie to be sent on the top-level
                           // redirect Google sends back after login
  }
}));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    const today = new Date().toISOString().split('T')[0];
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email: profile.emails?.[0]?.value || '',
        name: profile.displayName,
        photo: profile.photos?.[0]?.value || '',
        lastLoginDate: today,
        loginStreak: 1,
        coins: 100,
        gems: 5
      });
      console.log('👤 New user created:', user._id.toString());
    } else {
      const diff = Math.floor((new Date() - new Date(user.lastActive)) / 86400000);
      if (diff === 1) user.streak += 1;
      else if (diff > 1) user.streak = 1;
      if (user.lastLoginDate !== today) {
        const lastDate = user.lastLoginDate ? new Date(user.lastLoginDate) : null;
        const dayDiff = lastDate ? Math.floor((new Date(today) - lastDate) / 86400000) : 999;
        if (dayDiff === 1) user.loginStreak = (user.loginStreak || 0) + 1;
        else if (dayDiff > 1) user.loginStreak = 1;
        user.lastLoginDate = today;
      }
      user.lastActive = new Date();
      if (user.streak > (user.longestStreak || 0)) user.longestStreak = user.streak;
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      if (new Date(user.weeklyXPReset) < weekAgo) { user.weeklyXP = 0; user.weeklyXPReset = new Date(); }
      await user.save();
      console.log('👤 Existing user logged in:', user._id.toString());
    }
    return done(null, user);
  } catch (err) {
    console.error('❌ Google strategy error:', err.message);
    return done(err, null);
  }
}));

passport.serializeUser((u, done) => done(null, u._id.toString()));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    if (!user) {
      console.warn('⚠️  deserializeUser: no user found for id', id, '— session cookie is stale/orphaned.');
      return done(null, false);
    }
    done(null, user);
  } catch (e) {
    console.error('❌ deserializeUser error:', e.message);
    done(e, null);
  }
});
app.use(passport.initialize());
app.use(passport.session());

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required', loginUrl: '/auth/google' });
};

// ── API KEYS (all optional — chain skips providers with no key) ──
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const OPENROUTER_MODELS = ['deepseek/deepseek-chat-v3-0324:free', 'google/gemma-2-9b-it:free', 'meta-llama/llama-3.3-70b-instruct:free'];
const GEMINI_KEYS = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const GROQ_KEYS = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);

let orIdx = 0, orMIdx = 0, gIdx = 0, grIdx = 0;

// ── HELPERS ───────────────────────────────────────────────
function getWeekKey() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}
function calcLevel(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1; }
function calcRank(xp) {
  if (xp >= 50000) return 'Grandmaster';
  if (xp >= 25000) return 'Diamond';
  if (xp >= 10000) return 'Platinum';
  if (xp >= 5000) return 'Gold';
  if (xp >= 2000) return 'Silver';
  return 'Bronze';
}
function safeParseJSON(raw) {
  if (!raw) return {};
  let clean = String(raw).replace(/```json/gi, '').replace(/```/g, '').trim();
  const objStart = clean.indexOf('{');
  const objEnd = clean.lastIndexOf('}');
  const arrStart = clean.indexOf('[');
  const arrEnd = clean.lastIndexOf(']');
  let candidate = clean;
  if (objStart !== -1 && objEnd !== -1 && (arrStart === -1 || objStart < arrStart)) {
    candidate = clean.slice(objStart, objEnd + 1);
  } else if (arrStart !== -1 && arrEnd !== -1) {
    candidate = clean.slice(arrStart, arrEnd + 1);
  }
  try { return JSON.parse(candidate); } catch (e) {
    try { return JSON.parse(clean); } catch (e2) { return {}; }
  }
}
async function fetchWithTimeout(url, options = {}, ms = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${response.status} - ${text}`);
    }
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── AI PROVIDERS (priority: DeepSeek → OpenRouter → Gemini → Groq) ──
async function callDeepSeek(messages, prompt) {
  if (!DEEPSEEK_KEY) throw new Error('No DeepSeek key configured');
  console.log('🚀 DeepSeek');
  const response = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4000,
      temperature: 0.5,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function callOpenRouter(messages, prompt) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  console.log(`🧠 OpenRouter -> ${model}`);
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': process.env.PUBLIC_URL || 'https://grind-ai.onrender.com',
      'X-Title': 'GRIND AI'
    },
    body: JSON.stringify({
      model, max_tokens: 4000, temperature: 0.4,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function callGemini(messages, prompt, imageBase64 = null) {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini keys configured');
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') last.parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  }
  console.log('⚡ Gemini');
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 4000 }
      })
    }
  );
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(messages, prompt) {
  if (!GROQ_KEYS.length) throw new Error('No Groq keys configured');
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  console.log('🚀 Groq');
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 4000, temperature: 0.4,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function getReply(messages, prompt, imageBase64 = null) {
  const providers = [
    () => callDeepSeek(messages, prompt),
    () => callOpenRouter(messages, prompt),
    () => callGemini(messages, prompt, imageBase64),
    () => callGroq(messages, prompt)
  ];
  let lastErr;
  for (const call of providers) {
    try { return await call(); }
    catch (err) { lastErr = err; console.error('Provider failed:', err.message); }
  }
  throw lastErr || new Error('All AI providers failed');
}

// ── PROMPT BUILDERS ───────────────────────────────────────
const speedMap = {
  fast: 'Keep answers short and punchy — 2-4 sentences max unless a full derivation is required.',
  balanced: 'Give complete but efficient answers — no fluff, no filler.',
  deep: 'Give thorough, step-by-step explanations with full reasoning.',
  ultra: 'Give exhaustive, textbook-level detail with multiple approaches and edge cases.'
};

function buildSystemPrompt(user, plannerCtx, todayMistakes, weakTopics) {
  const name = user?.name?.split(' ')[0] || 'Aspirant';
  const gender = user?.gender || 'other';
  const slang = gender === 'male' ? 'bhai' : gender === 'female' ? 'yaar' : 'champ';
  const speed = user?.responseSpeed || 'balanced';
  const mistakeCtx = todayMistakes.length
    ? `TODAY'S MISTAKE LOG:\n${todayMistakes.map(m => `- [${m.topic}] ${m.explanation?.slice(0, 100) || m.question?.slice(0, 100) || ''}`).join('\n')}\n`
    : '';

  return `You are GRIND — a premium, brutally honest, hyper-focused academic mentor for Indian IIT-JEE and NEET aspirants.
========================================================
STUDENT: ${name} | ${gender} ("${slang}") | ${user?.exam || 'JEE/NEET'} | Class ${user?.class || '?'}
Coaching: ${user?.coaching || 'self-study'} | Struggle: ${user?.biggestStruggle || '?'}
Weak Topics: ${weakTopics.length ? weakTopics.join(', ') : 'none tracked yet'} | Response depth: ${speedMap[speed] || speedMap.balanced}
${plannerCtx ? 'TODAY\'S PLAN:\n' + plannerCtx + '\n' : ''}${mistakeCtx}
========================================================
RULES:
- Anchor every response in real NTA/JEE/NEET exam patterns. Use terms like NCERT, PYQs, Mock Tests, Error Book naturally.
- LaTeX is MANDATORY for all math. Inline: $F=ma$ (no spaces just inside $). Block: \\[ W = \\Delta KE \\] with blank lines before/after. Never write plain-text math like "v^2 = u^2 + 2as".
- Tone: strict, urgent, motivating — not saccharine. Never say hollow filler like "You got this!" or "Great question!".
- Address ${name} by name occasionally. Use "${slang}" naturally, not in every message.
- Mirror the student's language style (Hinglish, Telugu-English, plain English, etc).
- End substantive academic answers with a line starting "🎯 YOUR NEXT CHALLENGE:" suggesting a concrete next step.
- When you detect a genuine conceptual error in the student's message, append at the very end (on its own line):
  [MISTAKE_START] Concept: <topic> | Context: <what went wrong and the fix> [MISTAKE_END]
  Only do this when there's an actual mistake to log — do not fabricate one.`;
}

function buildPYQPrompt(subject, chapter, exam, difficulty) {
  const chapterLine = chapter ? `Chapter: ${chapter}. ` : '';
  const examLine = exam ? `Exam: ${exam}.` : 'Exam: JEE Main or NEET (pick whichever fits best).';
  return `You are a verified JEE/NEET question bank with knowledge of real past papers (2000-2024).
Task: Recall or closely reconstruct ONE real PYQ. Subject: ${subject}. ${chapterLine}${examLine} Difficulty: ${difficulty || 'medium'}.
If you cannot recall a genuine PYQ, generate a new question in authentic PYQ style and set "verified": false.
Return ONLY compact JSON, no markdown fences:
{"question":"text with LaTeX \\\\( \\\\) inline \\\\[ \\\\] display","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"complete step-by-step solution with LaTeX","cheatSheet":"one key trick or formula","trapAlert":"the most common wrong-answer trap","topic":"specific sub-topic","chapter":"${chapter || ''}","verified":true,"year":"2022","exam":"${exam || 'JEE Main'}"}`;
}

function buildPracticePrompt(subject, chapter, topic, difficulty, adaptTopics) {
  const chapterLine = chapter ? `Chapter: ${chapter}. ` : '';
  const topicLine = topic ? `Focus specifically on: ${topic}. ` : '';
  const adaptLine = adaptTopics?.length ? `PRIORITIZE these known weak topics if relevant: ${adaptTopics.join(', ')}. ` : '';
  return `Generate ONE original JEE/NEET-style practice question. Subject: ${subject}. ${chapterLine}${topicLine}${adaptLine}Difficulty: ${difficulty || 'medium'}.
Return ONLY compact JSON, no markdown fences:
{"question":"text with LaTeX \\\\( \\\\) inline \\\\[ \\\\] display","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"complete step-by-step solution with LaTeX","cheatSheet":"one key trick or formula","trapAlert":"the most common wrong-answer trap","topic":"specific sub-topic","chapter":"${chapter || ''}"}`;
}

function extractMistakeEntries(reply) {
  const entries = [];
  const re = /\[MISTAKE_START\]([\s\S]*?)\[MISTAKE_END\]/g;
  let m;
  while ((m = re.exec(reply)) !== null) entries.push(m[1].trim());
  return entries;
}

async function buildPlannerContext(userId) {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const tasks = await PlannerTask.find({ userId, scheduledDate: { $gte: today, $lt: tomorrow } }).lean();
    if (!tasks.length) return '';
    const done = tasks.filter(t => t.status === 'completed').length;
    return `${done}/${tasks.length} tasks done today.\n${tasks.map(t => `- ${t.title} (${t.subject || 'General'}, ${t.status})`).join('\n')}`;
  } catch { return ''; }
}
async function getTodayMistakes(userId) {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    return await Mistake.find({ userId, createdAt: { $gte: today, $lt: tomorrow } })
      .select('topic explanation question').limit(10).lean();
  } catch { return []; }
}
function getWeakTopicsList(user) {
  const wk = getWeekKey();
  const map = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
  const out = [];
  for (const [t, v] of map.entries()) if (v?.weeks?.includes(wk)) out.push(t);
  return out;
}

// ── ACHIEVEMENTS ──────────────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_blood', name: 'First Blood', icon: '🎯' },
  { id: 'hot_streak_5', name: 'Hot Streak x5', icon: '🔥' },
  { id: 'hot_streak_10', name: 'Unstoppable x10', icon: '🔥' },
  { id: 'login_streak_7', name: 'Week Warrior', icon: '📅' },
  { id: 'login_streak_30', name: 'Iron Discipline', icon: '🛡️' },
  { id: 'centurion', name: 'Centurion (100 solved)', icon: '💯' },
  { id: 'solver_500', name: '500 Club', icon: '🏅' },
  { id: 'solver_1000', name: '1000 Club', icon: '🏆' },
  { id: 'level_5', name: 'Level 5 Reached', icon: '⭐' },
  { id: 'level_10', name: 'Level 10 Reached', icon: '🌟' },
  { id: 'level_20', name: 'Level 20 Reached', icon: '💫' },
  { id: 'accuracy_90', name: 'Sharpshooter (90% acc)', icon: '🎯' },
  { id: 'night_owl', name: 'Night Owl', icon: '🦉' },
  { id: 'early_bird', name: 'Early Bird', icon: '🐦' },
  { id: 'boss_slayer', name: 'Boss Slayer', icon: '⚔️' },
  { id: 'world_boss_slayer', name: 'World Boss Slayer', icon: '🌍' },
  { id: 'story_master', name: 'Story Master', icon: '📖' }
];

async function awardXP(userId, xpEarned, correct, newStreak, totalSolved, totalCorrect) {
  const user = await User.findById(userId);
  if (!user) return { newAchievements: [], levelUp: false, newLevel: 1, totalXP: 0, coins: 0 };
  const oldLevel = calcLevel(user.quizXP);
  user.quizXP = Math.max(0, (user.quizXP || 0) + xpEarned);
  user.weeklyXP = (user.weeklyXP || 0) + xpEarned;
  user.totalQSolved = totalSolved ?? user.totalQSolved;
  user.totalQCorrect = totalCorrect ?? user.totalQCorrect;
  user.quizStreak = newStreak ?? user.quizStreak;
  if ((user.quizStreak || 0) > (user.maxQuizStreak || 0)) user.maxQuizStreak = user.quizStreak;
  if (correct) user.coins = (user.coins || 0) + Math.max(1, Math.floor(xpEarned / 3));
  const newLevel = calcLevel(user.quizXP);
  user.quizLevel = newLevel;
  user.rankTier = calcRank(user.quizXP);

  const newAchievements = [];
  const existingIds = user.achievements.map(a => a.id);
  const hour = new Date().getHours();
  const acc = user.totalQSolved ? user.totalQCorrect / user.totalQSolved : 0;
  const checks = [
    { id: 'first_blood', condition: user.totalQCorrect >= 1 },
    { id: 'hot_streak_5', condition: (user.quizStreak || 0) >= 5 },
    { id: 'hot_streak_10', condition: (user.quizStreak || 0) >= 10 },
    { id: 'login_streak_7', condition: (user.loginStreak || 0) >= 7 },
    { id: 'login_streak_30', condition: (user.loginStreak || 0) >= 30 },
    { id: 'centurion', condition: (user.totalQSolved || 0) >= 100 },
    { id: 'solver_500', condition: (user.totalQSolved || 0) >= 500 },
    { id: 'solver_1000', condition: (user.totalQSolved || 0) >= 1000 },
    { id: 'level_5', condition: newLevel >= 5 },
    { id: 'level_10', condition: newLevel >= 10 },
    { id: 'level_20', condition: newLevel >= 20 },
    { id: 'accuracy_90', condition: (user.totalQSolved || 0) >= 20 && acc >= 0.9 },
    { id: 'night_owl', condition: hour >= 23 || hour <= 3 },
    { id: 'early_bird', condition: hour >= 5 && hour <= 7 }
  ];
  for (const check of checks) {
    if (check.condition && !existingIds.includes(check.id)) {
      const ach = ACHIEVEMENTS.find(a => a.id === check.id);
      if (ach) { user.achievements.push({ ...ach, unlockedAt: new Date() }); newAchievements.push(ach); }
    }
  }
  await user.save();
  return { newAchievements, levelUp: newLevel > oldLevel, newLevel, totalXP: user.quizXP, coins: user.coins };
}

async function unlockAchievement(userId, id) {
  const ach = ACHIEVEMENTS.find(a => a.id === id);
  if (!ach) return null;
  const user = await User.findById(userId);
  if (!user) return null;
  if (user.achievements.some(a => a.id === id)) return null;
  user.achievements.push({ ...ach, unlockedAt: new Date() });
  await user.save();
  return ach;
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));

// AUTH
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    console.log('✅ OAuth callback success. session id:', req.sessionID, 'user:', req.user?._id?.toString());
    res.redirect('/');
  }
);
app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie('grind.sid');
      res.redirect('/');
    });
  });
});
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: req.isAuthenticated(),
    userId: req.isAuthenticated() ? req.user._id.toString() : null
  });
});

// USER
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u._id, name: u.name, email: u.email, photo: u.photo,
      isOnboarded: u.isOnboarded, exam: u.exam, class: u.class,
      coaching: u.coaching, gender: u.gender, streak: u.streak,
      responseSpeed: u.responseSpeed || 'balanced', examDate: u.examDate,
      hoursPerDay: u.hoursPerDay, biggestStruggle: u.biggestStruggle,
      quizXP: u.quizXP, quizLevel: u.quizLevel, totalQSolved: u.totalQSolved,
      totalQCorrect: u.totalQCorrect, quizStreak: u.quizStreak,
      maxQuizStreak: u.maxQuizStreak, achievements: u.achievements,
      weeklyXP: u.weeklyXP, coins: u.coins || 0, gems: u.gems || 0,
      loginStreak: u.loginStreak || 0, rankTier: u.rankTier || 'Bronze'
    }
  });
});

app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const { responseSpeed, examDate } = req.body;
    const update = {};
    if (responseSpeed) update.responseSpeed = responseSpeed;
    if (examDate !== undefined) update.examDate = examDate ? new Date(examDate) : null;
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;
    await User.findByIdAndUpdate(req.user._id, { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender, isOnboarded: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
});

// DAILY LOGIN REWARD (streak-scaled coins/gems, once per day)
app.post('/api/user/claim-daily', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const user = await User.findById(req.user._id);
    if (user.lastDailyRewardClaim === today) return res.json({ success: false, alreadyClaimed: true });
    const streak = user.loginStreak || 1;
    const coinsEarned = 20 + Math.min(streak * 5, 150);
    const gemsEarned = streak % 7 === 0 ? 10 : 0;
    user.coins = (user.coins || 0) + coinsEarned;
    user.gems = (user.gems || 0) + gemsEarned;
    user.lastDailyRewardClaim = today;
    await user.save();
    res.json({ success: true, coinsEarned, gemsEarned, streak });
  } catch (e) { res.status(500).json({ error: 'Could not claim.' }); }
});

// RIVAL — a fixed virtual competitor ("Aryan") for light-touch social pressure
app.get('/api/rival', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const aryanLevel = Math.max(2, (u.quizLevel || 1) + (Math.floor(Math.random() * 3) - 1));
    const aryanXP = Math.pow(aryanLevel - 1, 2) * 100 + Math.floor(Math.random() * 200);
    const aryanStreak = Math.max(0, (u.quizStreak || 0) + (Math.floor(Math.random() * 5) - 2));
    const xpGap = aryanXP - (u.quizXP || 0);
    const streakGap = aryanStreak - (u.quizStreak || 0);
    const levelGap = aryanLevel - (u.quizLevel || 1);
    let taunt;
    if (xpGap > 0) taunt = `I'm ${xpGap} XP ahead of you. Catch up if you can.`;
    else if (xpGap < 0) taunt = `You're ahead of me for once. Let's see how long that lasts.`;
    else taunt = `We're neck and neck. Next quiz decides it.`;
    res.json({ aryanLevel, aryanXP, aryanStreak, taunt, gap: { xp: xpGap, streak: streakGap, level: levelGap } });
  } catch { res.status(500).json({ error: 'Failed.' }); }
});

// LEADERBOARD
app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const sortField = type === 'weekly' ? 'weeklyXP' : type === 'streak' ? 'streak' : 'quizXP';
    const users = await User.find({ isOnboarded: true })
      .select('name photo quizXP weeklyXP quizLevel streak')
      .sort({ [sortField]: -1 }).limit(50).lean();
    const board = users.map((u, i) => ({
      rank: i + 1,
      name: u.name?.split(' ')[0] || 'Student',
      photo: u.photo,
      xp: type === 'weekly' ? (u.weeklyXP || 0) : type === 'streak' ? (u.streak || 0) : (u.quizXP || 0),
      level: u.quizLevel || 1,
      isMe: u._id.toString() === req.user._id.toString()
    }));
    res.json({ board });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});

// SESSIONS
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt').sort({ updatedAt: -1 }).limit(30);
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    res.json({ session: s });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.create({ userId: req.user._id, title: 'New Conversation', messages: [] });
    res.json({ sessionId: s._id });
  } catch { res.status(500).json({ error: 'Could not create.' }); }
});
app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// CHAT
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  const user = req.user;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request.' });
  const recent = messages.slice(-20);
  const plannerCtx = await buildPlannerContext(user._id);
  const todayMistakes = await getTodayMistakes(user._id);
  const weakTopics = getWeakTopicsList(user);
  const prompt = buildSystemPrompt(user, plannerCtx, todayMistakes, weakTopics);
  try {
    const reply = await getReply(recent, prompt, imageBase64 || null);
    const mistakeEntries = extractMistakeEntries(reply);
    for (const entry of mistakeEntries) {
      try {
        const conceptMatch = entry.match(/Concept:\s*([^|]+)/i);
        const contextMatch = entry.match(/Context:\s*(.+)/is);
        const topic = conceptMatch?.[1]?.trim() || 'General';
        const context = contextMatch?.[1]?.trim() || entry;
        await Mistake.create({
          userId: user._id, topic,
          subject: (user.exam || '').includes('NEET') ? 'Biology' : 'General',
          explanation: context, question: context, weekKey: getWeekKey()
        });
        const wk = getWeekKey();
        const wMap = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
        const ent = wMap.get(topic) || { count: 0, weeks: [] };
        ent.count = (ent.count || 0) + 1;
        if (!ent.weeks) ent.weeks = [];
        if (!ent.weeks.includes(wk)) ent.weeks.push(wk);
        wMap.set(topic, ent);
        await User.findByIdAndUpdate(user._id, { weakTopics: wMap });
      } catch (e) { console.error('Auto-mistake:', e.message); }
    }
    const cleanReply = reply.replace(/\[MISTAKE_START\][\s\S]*?\[MISTAKE_END\]/g, '').trim();
    if (sessionId && sessionId !== 'new' && String(sessionId).length === 24) {
      try {
        const userMsg = messages[messages.length - 1];
        const session = await ChatSession.findById(sessionId);
        const isFirstMsg = session && session.messages.length === 0;
        const update = {
          $push: { messages: [{ role: 'user', content: userMsg.content }, { role: 'assistant', content: cleanReply }] },
          $set: { updatedAt: new Date() }
        };
        if (isFirstMsg) update.$set.title = userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '');
        await ChatSession.findByIdAndUpdate(sessionId, update);
      } catch (e) { console.error('Session save:', e.message); }
    }
    res.json({ reply: cleanReply, autoMistakes: mistakeEntries.length });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Our AI is taking a break. Please try again.' });
  }
});

// QUIZ
app.post('/api/quiz/question', requireAuth, async (req, res) => {
  const { subject, chapter, topic, difficulty, pyqMode, exam } = req.body;
  const user = req.user;
  const weakTopics = getWeakTopicsList(user);
  const prompt = pyqMode
    ? buildPYQPrompt(subject || 'Physics', chapter, exam || user.exam, difficulty)
    : buildPracticePrompt(subject || 'Physics', chapter, topic, difficulty, weakTopics);
  try {
    const reply = await getReply(
      [{ role: 'user', content: prompt }],
      'You are an expert JEE/NEET question generator. Return ONLY valid compact JSON, no markdown fences.'
    );
    const q = safeParseJSON(reply);
    if (!q.question || !q.options || !q.answer) throw new Error('Incomplete question structure');
    res.json({ question: q });
  } catch (err) {
    console.error('Quiz gen:', err.message);
    res.status(500).json({ error: 'Could not generate a question. Try again.' });
  }
});

app.post('/api/quiz/award-xp', requireAuth, async (req, res) => {
  try {
    const { correct, streak, totalSolved, totalCorrect, xpEarned } = req.body;
    const result = await awardXP(req.user._id, xpEarned ?? (correct ? 10 : 2), correct, streak, totalSolved, totalCorrect);
    res.json(result);
  } catch { res.status(500).json({ error: 'Could not award XP.' }); }
});

app.post('/api/quiz/log-wrong', requireAuth, async (req, res) => {
  try {
    const { topic, subject, chapter, question, userAnswer, correctAnswer, explanation, cheatSheet, trapAlert, isPYQ, pyqYear, pyqExam } = req.body;
    const wk = getWeekKey();
    const user = req.user;
    const wMap = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
    const ent = wMap.get(topic || subject) || { count: 0, weeks: [] };
    ent.count = (ent.count || 0) + 1;
    if (!ent.weeks) ent.weeks = [];
    if (!ent.weeks.includes(wk)) ent.weeks.push(wk);
    wMap.set(topic || subject, ent);
    await User.findByIdAndUpdate(user._id, { weakTopics: wMap });
    await Mistake.create({
      userId: user._id, topic: topic || subject, subject, chapter, question,
      userAnswer, correctAnswer, explanation, cheatSheet, trapAlert,
      isPYQ: !!isPYQ, pyqYear: pyqYear || '', pyqExam: pyqExam || '', weekKey: wk
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not log mistake.' }); }
});

// MISTAKES
app.get('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const { subject } = req.query;
    const filter = { userId: req.user._id };
    if (subject && subject !== 'All') filter.subject = subject;
    res.json({ mistakes: await Mistake.find(filter).sort({ createdAt: -1 }).limit(100) });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.delete('/api/mistakes/:id', requireAuth, async (req, res) => {
  try {
    await Mistake.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// PLANNER
app.get('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const { view } = req.query;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    let filter = { userId: req.user._id };
    if (view === 'today') filter.scheduledDate = { $gte: today, $lt: tomorrow };
    else if (view === 'week') filter.scheduledDate = { $gte: today, $lt: weekEnd };
    else if (view === 'completed') filter.status = 'completed';
    else filter.scheduledDate = { $gte: today, $lt: tomorrow };
    res.json({ tasks: await PlannerTask.find(filter).sort({ priority: 1, scheduledDate: 1 }) });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const task = await PlannerTask.create({ ...req.body, userId: req.user._id, scheduledDate: new Date(req.body.scheduledDate || Date.now()) });
    res.json({ task });
  } catch { res.status(500).json({ error: 'Could not create task.' }); }
});
app.patch('/api/planner/tasks/:id', requireAuth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (req.body.status === 'completed') update.completedAt = new Date();
    const task = await PlannerTask.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, update, { new: true });
    if (req.body.status === 'completed') {
      await User.findByIdAndUpdate(req.user._id, { $inc: { coins: 5 } });
    }
    res.json({ task });
  } catch { res.status(500).json({ error: 'Could not update.' }); }
});
app.delete('/api/planner/tasks/:id', requireAuth, async (req, res) => {
  try {
    await PlannerTask.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});
app.post('/api/planner/generate', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const weakTopics = getWeakTopicsList(user);
    const prompt = `Generate a realistic daily study plan for a ${user.exam || 'JEE/NEET'} aspirant (${user.class || 'Class 12'}) studying ${user.hoursPerDay || '4-6 hrs'} per day. Weak topics to prioritize: ${weakTopics.join(', ') || 'general revision'}. Energy level today: ${req.body.energyLevel || 'medium'}.
Return ONLY a JSON array of 4-6 tasks, no markdown fences:
[{"title":"...","subject":"Physics|Chemistry|Mathematics|Biology","priority":"high|medium|low","estimatedMins":60}]`;
    const raw = await getReply([{ role: 'user', content: prompt }], 'Return ONLY a valid JSON array.');
    const parsed = safeParseJSON(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.tasks || []);
    const created = [];
    for (const t of list) {
      if (!t.title) continue;
      const task = await PlannerTask.create({
        userId: user._id, title: t.title, subject: t.subject || '',
        priority: t.priority || 'medium', estimatedMins: t.estimatedMins || 60,
        scheduledDate: new Date(), aiGenerated: true
      });
      created.push(task);
    }
    res.json({ tasks: created });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Could not generate plan.' }); }
});

// MOOD
app.post('/api/mood', requireAuth, async (req, res) => {
  try {
    const { mood } = req.body;
    const date = new Date().toISOString().split('T')[0];
    await Mood.findOneAndUpdate(
      { userId: req.user._id, date },
      { mood, userId: req.user._id, date },
      { upsert: true, new: true }
    );
    await User.findByIdAndUpdate(req.user._id, { lastMoodDate: date });
    const msgs = {
      1: "Rough day. Take 10 minutes off, then come back to just one easy topic. Don't push through this.",
      2: "Not your best. Do a light review session — flashcards or one easy quiz — instead of new material.",
      3: "Steady. A normal study block works fine today.",
      4: "Good energy. Good day to tackle a weak topic head-on.",
      5: "Locked in. Push hardest on your toughest chapter today."
    };
    res.json({ success: true, aiMsg: msgs[mood] || 'Logged.' });
  } catch { res.status(500).json({ error: 'Could not save mood.' }); }
});
app.get('/api/mood/history', requireAuth, async (req, res) => {
  try {
    const moods = await Mood.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(14).lean();
    const today = new Date().toISOString().split('T')[0];
    res.json({ moods, checkedToday: moods.length > 0 && moods[0].date === today });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});

// FORMULA FORTRESS (spaced repetition, SM-2-like)
app.get('/api/formulas', requireAuth, async (req, res) => {
  try {
    const due = await Formula.find({ userId: req.user._id, nextReview: { $lte: new Date() } }).sort({ nextReview: 1 }).limit(20).lean();
    const total = await Formula.countDocuments({ userId: req.user._id });
    const mastered = await Formula.countDocuments({ userId: req.user._id, repetitions: { $gte: 5 } });
    res.json({ formulas: due, total, mastered, dueCount: due.length });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/formulas', requireAuth, async (req, res) => {
  try {
    const f = await Formula.create({ userId: req.user._id, ...req.body });
    res.json({ formula: f });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});
app.post('/api/formulas/:id/review', requireAuth, async (req, res) => {
  try {
    const { quality } = req.body;
    const f = await Formula.findOne({ _id: req.params.id, userId: req.user._id });
    if (!f) return res.status(404).json({ error: 'Not found.' });
    if (quality >= 3) {
      f.interval = f.repetitions === 0 ? 1 : f.repetitions === 1 ? 6 : Math.round(f.interval * f.easeFactor);
      f.repetitions++;
    } else {
      f.repetitions = 0; f.interval = 1;
    }
    f.easeFactor = Math.max(1.3, f.easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    f.nextReview = new Date(Date.now() + f.interval * 86400000);
    await f.save();
    res.json({ formula: f, mastered: f.repetitions >= 5 });
  } catch { res.status(500).json({ error: 'Failed.' }); }
});
app.delete('/api/formulas/:id', requireAuth, async (req, res) => {
  try {
    await Formula.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed.' }); }
});

// STORY MODE — round1 (8 Qs) -> AI teaching on misses -> round2 (same 8, shuffled)
async function getPYQsForChapter(subject, chapter, exam, count) {
  const dbQs = await PYQ.find({ subject, chapter }).limit(count * 2).lean();
  if (dbQs.length >= count) {
    return { questions: dbQs.sort(() => Math.random() - 0.5).slice(0, count) };
  }
  const prompt = `Generate exactly ${count} JEE/NEET PYQ-style questions covering DIFFERENT sub-concepts.
Subject: ${subject} | Chapter: ${chapter} | Exam: ${exam || 'JEE Main'}
Use LaTeX: \\\\( \\\\) inline, \\\\[ \\\\] display.
Return ONLY compact JSON, no markdown fences:
{"questions":[{"concept":"sub-concept name","question":"text with LaTeX","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"step-by-step","cheatSheet":"key formula"}]}`;
  const raw = await getReply([{ role: 'user', content: prompt }], 'Return ONLY valid JSON, no markdown.');
  const data = safeParseJSON(raw);
  const questions = data.questions || [];
  if (!questions.length) throw new Error('No questions generated');
  for (const q of questions) {
    PYQ.create({ subject, chapter, exam, question: q.question, options: q.options, answer: q.answer, explanation: q.explanation, cheatSheet: q.cheatSheet, verified: false }).catch(() => {});
  }
  return { questions };
}

app.post('/api/story/questions', requireAuth, async (req, res) => {
  const { subject, chapter, exam } = req.body;
  if (!chapter) return res.status(400).json({ error: 'Chapter required.' });
  try {
    const data = await getPYQsForChapter(subject, chapter, exam, 8);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message || 'Could not load questions.' }); }
});

app.post('/api/story/teach', requireAuth, async (req, res) => {
  const { subject, chapter, questions, round1Answers, score } = req.body;
  const user = req.user;
  const name = user?.name?.split(' ')[0] || 'champ';
  const wrongQs = (questions || []).filter((q, i) => round1Answers[i] !== q.answer);
  const rightQs = (questions || []).filter((q, i) => round1Answers[i] === q.answer);
  const wrongConcepts = wrongQs.map(q => q.concept || chapter).join(', ') || 'a few concepts';
  const prompt = `You are GRIND — a warm but sharp IITian senior mentor teaching ${name}.
They scored ${score}/8 on "${chapter}" (${subject}) BEFORE learning.
WRONG concepts: ${wrongConcepts}
RIGHT concepts: ${rightQs.map(q => q.concept || '').join(', ') || 'none'}
Write a focused teaching session:
1. "🎯 Let's Fix What Tripped You Up" — explain the wrong concepts clearly, with LaTeX for math.
2. "📚 The Full Picture" — a concise complete overview of the chapter.
3. "⚡ Your Cheat Sheet" — 3-5 bullet key formulas/tricks.
4. "🔄 Ready for Round 2" — one motivating sentence.
Use $...$ inline and \\\\[...\\\\] block LaTeX. Talk like a real mentor, not a textbook.`;
  try {
    const teaching = await getReply([{ role: 'user', content: prompt }], `You are GRIND, a warm IITian mentor teaching ${chapter}. Use LaTeX for all math.`);
    for (const q of wrongQs) {
      await Mistake.create({
        userId: user._id, topic: q.concept || chapter, subject, chapter,
        question: q.question, correctAnswer: q.answer, explanation: q.explanation || '',
        cheatSheet: q.cheatSheet || '', isPYQ: true, weekKey: getWeekKey()
      }).catch(() => {});
    }
    res.json({ teaching });
  } catch { res.status(500).json({ error: 'Could not generate teaching.' }); }
});

app.post('/api/story/complete', requireAuth, async (req, res) => {
  try {
    const { subject, chapter, exam, questions, round1Score, round2Score, round2Answers } = req.body;
    const improvement = round2Score - round1Score;
    const xp = Math.max(20, improvement * 20 + round2Score * 8 + 10);
    const wrongConcepts = (questions || [])
      .filter((q, i) => (round2Answers || [])[i] !== q.answer)
      .map(q => q.concept || '');
    await StorySession.create({ userId: req.user._id, subject, chapter, exam, round1Score, round2Score, improvement, xpEarned: xp, wrongConcepts });
    const storyCount = await StorySession.countDocuments({ userId: req.user._id });
    const result = await awardXP(req.user._id, xp, round2Score > round1Score, req.user.quizStreak, (req.user.totalQSolved || 0) + 8, (req.user.totalQCorrect || 0) + round2Score);
    if (storyCount >= 5) {
      const ach = await unlockAchievement(req.user._id, 'story_master');
      if (ach) result.newAchievements = [...(result.newAchievements || []), ach];
    }
    const msg = improvement >= 5 ? `🔥 ${improvement} more correct. The method works.`
      : improvement >= 3 ? `📈 +${improvement} — solid progress.`
      : improvement >= 1 ? `👍 +${improvement} — building.`
      : round2Score >= 6 ? `💎 Already strong. Move to the next chapter.`
      : `🔄 Try again in a couple of days.`;
    res.json({ ...result, improvement, xpEarned: xp, message: msg });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

// BOSS BATTLES
app.post('/api/boss/start', requireAuth, async (req, res) => {
  const { subject, chapter, type } = req.body;
  const isWorld = type === 'world';
  const count = isWorld ? 20 : 12;
  const prompt = `Generate ${count} JEE/NEET PYQ-style questions for a BOSS BATTLE. Subject: ${subject}${chapter && !isWorld ? ` | Chapter: ${chapter}` : ' | mix multiple chapters'}.
${isWorld ? 'Include JEE Advanced-level difficulty. Mix easy/medium/hard.' : 'Medium-hard difficulty.'}
Use LaTeX in JSON: \\\\( \\\\) inline, \\\\[ \\\\] display.
Return ONLY compact JSON, no markdown fences:
{"bossName":"${isWorld ? subject + ' World Boss' : (chapter || subject) + ' Boss'}","intro":"one dramatic sentence","questions":[{"concept":"name","question":"text with LaTeX","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"step-by-step"}]}`;
  try {
    const raw = await getReply([{ role: 'user', content: prompt }], 'Return ONLY valid JSON, no markdown.');
    const data = safeParseJSON(raw);
    if (!data.questions?.length) throw new Error('No questions generated');
    res.json({ ...data, total: data.questions.length, type });
  } catch (e) { res.status(500).json({ error: e.message || 'Could not start boss.' }); }
});
app.post('/api/boss/complete', requireAuth, async (req, res) => {
  try {
    const { subject, chapter, type, score, total } = req.body;
    const beaten = type === 'world' ? score >= total * 0.7 : score >= total * 0.6;
    const xp = beaten ? (type === 'world' ? 500 : 200) : Math.max(20, score * 8);
    await BossBattle.create({ userId: req.user._id, subject, chapter, type, score, total, beaten, xpEarned: xp });
    const result = await awardXP(req.user._id, xp, beaten, req.user.quizStreak, (req.user.totalQSolved || 0) + total, (req.user.totalQCorrect || 0) + score);
    if (beaten) {
      const achId = type === 'world' ? 'world_boss_slayer' : 'boss_slayer';
      const ach = await unlockAchievement(req.user._id, achId);
      if (ach) result.newAchievements = [...(result.newAchievements || []), ach];
    }
    res.json({ ...result, beaten, xpEarned: xp });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

// DAILY CHALLENGE
app.get('/api/daily-challenge', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    let challenge = await DailyChallenge.findOne({ date: today });
    if (!challenge) {
      const subjects = ['Physics', 'Chemistry', 'Mathematics'];
      const subject = subjects[new Date().getDay() % 3];
      const prompt = `Generate ONE high-difficulty JEE-level daily challenge question for ${subject}. It should be hard enough that ~70-80% of students get it wrong.
Return ONLY compact JSON, no markdown fences:
{"subject":"${subject}","chapter":"chapter name","question":"full question with LaTeX \\\\( \\\\) inline \\\\[ \\\\] display","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"complete step-by-step","cheatSheet":"key trick"}`;
      const raw = await getReply([{ role: 'user', content: prompt }], 'Return ONLY valid JSON, no markdown.');
      const q = safeParseJSON(raw);
      challenge = await DailyChallenge.create({
        date: today, subject: q.subject || subject, chapter: q.chapter || '',
        question: q.question, options: q.options, answer: q.answer,
        explanation: q.explanation, cheatSheet: q.cheatSheet,
        xpReward: 150, coinsReward: 50, solvedBy: []
      });
    }
    const alreadySolved = challenge.solvedBy.some(id => id.toString() === req.user._id.toString());
    res.json({
      challenge: {
        id: challenge._id, subject: challenge.subject, chapter: challenge.chapter,
        question: challenge.question, options: challenge.options,
        explanation: alreadySolved ? challenge.explanation : undefined,
        xpReward: challenge.xpReward, coinsReward: challenge.coinsReward,
        solversCount: challenge.solvedBy.length
      },
      alreadySolved
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/daily-challenge/submit', requireAuth, async (req, res) => {
  try {
    const { challengeId, answer } = req.body;
    const challenge = await DailyChallenge.findById(challengeId);
    if (!challenge) return res.status(404).json({ error: 'Not found.' });
    const alreadySolved = challenge.solvedBy.some(id => id.toString() === req.user._id.toString());
    const correct = answer === challenge.answer;
    let xpEarned = 0, coinsEarned = 0;
    if (correct && !alreadySolved) {
      challenge.solvedBy.push(req.user._id);
      await challenge.save();
      xpEarned = challenge.xpReward;
      coinsEarned = challenge.coinsReward;
      await awardXP(req.user._id, xpEarned, true, req.user.quizStreak + 1, (req.user.totalQSolved || 0) + 1, (req.user.totalQCorrect || 0) + 1);
      await User.findByIdAndUpdate(req.user._id, { $inc: { coins: coinsEarned } });
    }
    res.json({ correct, alreadySolved, xpEarned, coinsEarned, correctAnswer: challenge.answer, explanation: challenge.explanation });
  } catch { res.status(500).json({ error: 'Could not submit.' }); }
});

// WEEKLY REPORT
app.get('/api/report/weekly', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const name = user.name?.split(' ')[0] || 'Warrior';
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [mistakes, tasks, moods, bosses, storySessions] = await Promise.all([
      Mistake.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      PlannerTask.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      Mood.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      BossBattle.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      StorySession.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean()
    ]);
    const weakTopics = getWeakTopicsList(user);
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const bossesBeaten = bosses.filter(b => b.beaten).length;
    const avgImprovement = storySessions.length
      ? (storySessions.reduce((a, s) => a + (s.improvement || 0), 0) / storySessions.length).toFixed(1) : 0;
    const prompt = `Write a personal weekly war report for ${name}, a ${user.exam || 'JEE/NEET'} student.
DATA: Weekly XP: ${user.weeklyXP} | Level: ${user.quizLevel} | Login streak: ${user.loginStreak}d
Story sessions: ${storySessions.length} | Avg improvement: +${avgImprovement}
Mistakes logged: ${mistakes.length} | Tasks done: ${completedTasks}/${tasks.length} | Bosses beaten: ${bossesBeaten}/${bosses.length}
Weak topics: ${weakTopics.slice(0, 4).join(', ') || 'not tracked'}
Write: opening line -> what they crushed -> what needs work -> a 3-bullet priority plan -> closing battle cry.
Tone: senior IITian who genuinely cares. Real talk, not corporate. 150-180 words. No LaTeX. Use emojis sparingly.`;
    const reportText = await getReply([{ role: 'user', content: prompt }], 'You are GRIND, an IITian mentor writing a weekly war report.');
    res.json({
      weeklyXP: user.weeklyXP, streak: user.loginStreak, level: user.quizLevel,
      storySessions: storySessions.length, avgImprovement, mistakesLogged: mistakes.length,
      tasksCompleted: completedTasks, totalTasks: tasks.length, bossesBeaten,
      weakTopics: weakTopics.slice(0, 5), reportText
    });
  } catch (e) { console.error(e.message); res.status(500).json({ error: 'Could not generate.' }); }
});

// POMODORO
app.post('/api/pomodoro/complete', requireAuth, async (req, res) => {
  try {
    const { duration } = req.body;
    const mins = duration || 25;
    const xp = mins >= 50 ? 60 : 30;
    const coins = mins >= 50 ? 30 : 15;
    await User.findByIdAndUpdate(req.user._id, { $inc: { totalStudyMins: mins, pomodoroSessions: 1, coins } });
    await awardXP(req.user._id, xp, true, req.user.quizStreak, req.user.totalQSolved, req.user.totalQCorrect);
    res.json({ xp, coins });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

// ── SOCKET.IO MULTIPLAYER ─────────────────────────────────
const quizRooms = {};

io.on('connection', socket => {
  socket.on('create-room', ({ name, config }) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    quizRooms[code] = {
      host: socket.id,
      config: config || { questionCount: 5, subjects: ['Physics'] },
      players: [{ id: socket.id, name, score: 0, streak: 0, correct: 0, total: 0 }],
      started: false, currentQ: 0, currentAnswer: ''
    };
    socket.join(code);
    socket.emit('room-created', { code, config: quizRooms[code].config });
    io.to(code).emit('players-update', quizRooms[code].players);
  });

  socket.on('join-room', ({ code, name }) => {
    const room = quizRooms[code];
    if (!room) return socket.emit('room-error', 'Room not found.');
    if (room.started) return socket.emit('room-error', 'Game already started.');
    room.players.push({ id: socket.id, name, score: 0, streak: 0, correct: 0, total: 0 });
    socket.join(code);
    socket.emit('room-joined', { code, config: room.config });
    io.to(code).emit('players-update', room.players);
  });

  socket.on('start-game', ({ code }) => {
    const room = quizRooms[code];
    if (!room || room.host !== socket.id) return;
    room.started = true;
    io.to(code).emit('game-started', { totalQ: room.config?.questionCount || 5 });
    startMultiplayerQuestion(code);
  });

  socket.on('submit-answer', ({ code, answer, timeLeft }) => {
    const room = quizRooms[code]; if (!room) return;
    const player = room.players.find(p => p.id === socket.id); if (!player) return;
    player.total = (player.total || 0) + 1;
    const correct = answer === room.currentAnswer;
    if (correct) {
      player.score += 10 + Math.floor((timeLeft || 0) / 3);
      player.streak = (player.streak || 0) + 1;
      player.correct = (player.correct || 0) + 1;
    } else { player.streak = 0; }
    socket.emit('answer-result', { correct, correctAnswer: room.currentAnswer });
    io.to(code).emit('players-update', room.players);
  });

  socket.on('disconnect', () => {
    Object.keys(quizRooms).forEach(code => {
      const room = quizRooms[code];
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(code).emit('players-update', room.players);
        if (!room.players.length) delete quizRooms[code];
      }
    });
  });
});

async function startMultiplayerQuestion(code) {
  const room = quizRooms[code]; if (!room) return;
  const totalQ = room.config?.questionCount || 5;
  if (room.currentQ >= totalQ) {
    io.to(code).emit('game-over', { players: room.players });
    delete quizRooms[code];
    return;
  }
  const subject = room.config?.subjects?.[room.currentQ % room.config.subjects.length] || 'Physics';
  const prompt = buildPracticePrompt(subject, '', null, 'medium', []);
  try {
    const reply = await getReply([{ role: 'user', content: prompt }], 'Return ONLY valid JSON, no markdown.');
    const q = safeParseJSON(reply);
    if (!q.question || !q.options || !q.answer) throw new Error('Bad question structure');
    room.currentAnswer = q.answer;
    io.to(code).emit('new-question', { ...q, timeLimit: 30, questionNumber: room.currentQ + 1, totalQuestions: totalQ });
    setTimeout(() => {
      io.to(code).emit('question-ended', { correctAnswer: q.answer, explanation: q.explanation });
      setTimeout(() => { room.currentQ++; startMultiplayerQuestion(code); }, 6000);
    }, 30000);
  } catch (err) {
    console.error('Multiplayer question error:', err.message);
    setTimeout(() => { room.currentQ++; startMultiplayerQuestion(code); }, 2000);
  }
}

// SPA FALLBACK
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI running on port ${PORT}`);
  console.log(`🔑 DeepSeek=${DEEPSEEK_KEY ? 1 : 0} OpenRouter=${OPENROUTER_KEYS.length} Gemini=${GEMINI_KEYS.length} Groq=${GROQ_KEYS.length}`);
  console.log(`🍪 Cookie secure=auto (matches request protocol) | NODE_ENV=${process.env.NODE_ENV || '(unset)'}`);
});
