require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const helmet         = require('helmet');
const compression    = require('compression');
const mongoose       = require('mongoose');
const session        = require('express-session');
const MongoStore     = require('connect-mongo');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();

// ── SECURITY / PERF MIDDLEWARE ────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB:', err.message));

// ══════════════════════════════════════════════════════════
//  SCHEMAS
// ══════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  email:           String,
  name:            { type: String, required: true },
  photo:           { type: String, default: '' },
  exam:            { type: String, default: '' },
  class:           { type: String, default: '' },
  coaching:        { type: String, default: '' },
  biggestStruggle: { type: String, default: '' },
  isOnboarded:     { type: Boolean, default: false },
  lastActive:      { type: Date, default: Date.now },
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep'] },
  examDate:        { type: Date, default: null },
  isPro:           { type: Boolean, default: false },
  planType:        { type: String, default: '', enum: ['', 'weekly', 'monthly', 'promo'] },
  planExpiresAt:   { type: Date, default: null },
  promoRedeemed:   { type: [String], default: [] },

  // ── REQUIREMENT 1: Token Tracking ──────────────────────
  // Cumulative input + output tokens consumed by this user across
  // ALL calls to /api/solve-doubt. Used to enforce the 50,000 token
  // cost perimeter and trigger automatic model downgrade.
  totalTokensConsumed: { type: Number, default: 0 },

  createdAt:       { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:    { type: String, default: 'New chat' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, default: '' },
    model:     { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const noteSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:     { type: String, default: 'Untitled' },
  content:   { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const promoCodeSchema = new mongoose.Schema({
  code:            { type: String, required: true, unique: true, uppercase: true, trim: true },
  bonusDays:       { type: Number, required: true, min: 1 },
  maxRedemptions:  { type: Number, default: 0 },
  redeemedCount:   { type: Number, default: 0 },
  expiresAt:       { type: Date, default: null },
  active:          { type: Boolean, default: true },
  note:            { type: String, default: '' },
  createdAt:       { type: Date, default: Date.now }
});

const User        = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Note        = mongoose.model('Note', noteSchema);
const PromoCode   = mongoose.model('PromoCode', promoCodeSchema);

// ══════════════════════════════════════════════════════════
//  SESSION + PASSPORT
// ══════════════════════════════════════════════════════════
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET not set. Using insecure default — set it before deploying.');
}
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL
}, async (at, rt, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email:    profile.emails?.[0]?.value || '',
        name:     profile.displayName,
        photo:    profile.photos?.[0]?.value || ''
      });
    }
    user.lastActive = new Date();
    await user.save();
    return done(null, user);
  } catch (err) { return done(err, null); }
}));
passport.serializeUser((u, done) => done(null, u._id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); } catch (e) { done(e, null); }
});
app.use(passport.initialize());
app.use(passport.session());

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required', loginUrl: '/auth/google' });
};

async function enforcePlanExpiry(user) {
  if (user.isPro && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
    user.isPro = false;
    user.planType = '';
    if (user.responseSpeed === 'deep') user.responseSpeed = 'balanced';
    await user.save();
  }
  return user;
}

// ── RATE LIMITING ─────────────────────────────────────────
const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.user?._id?.toString() || req.ip;
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (bucket.length >= maxRequests) {
      return res.status(429).json({ error: 'You are sending messages faster than GRIND can keep up — wait a few seconds and try again.' });
    }
    bucket.push(now);
    rateBuckets.set(key, bucket);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) { if (!v.some(t => now - t < 5 * 60000)) rateBuckets.delete(k); }
}, 5 * 60000);

// ══════════════════════════════════════════════════════════
//  AI PROVIDERS (legacy general-purpose helpers — used by
//  /api/chat/stream and /api/notes/ai-assist, unrelated to the
//  cost-perimeter logic in /api/solve-doubt below)
// ══════════════════════════════════════════════════════════
const GROQ_KEYS       = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS     = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const DEEPSEEK_KEY    = process.env.DEEPSEEK_API_KEY || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const PERPLEXITY_KEY  = process.env.PERPLEXITY_API_KEY || '';

const OPENROUTER_REASON_MODELS = ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat:free', 'openai/gpt-oss-120b:free'];
const OPENROUTER_FAST_MODELS   = ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat:free'];
let gIdx = 0, grIdx = 0, orIdx = 0;

const APP_REFERER = process.env.RENDER_EXTERNAL_URL || 'https://grind-ai.onrender.com';

async function fetchWithTimeout(url, options, ms = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
    return response;
  } catch (err) { clearTimeout(timeout); throw err; }
}

/* ── Line‑by‑line stream consumer ── */
async function consumeOpenAIStreamLines(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          let newlineIndex;
          while ((newlineIndex = fullText.indexOf('\n')) !== -1) {
            const lineToEmit = fullText.slice(0, newlineIndex + 1);
            fullText = fullText.slice(newlineIndex + 1);
            onLine(lineToEmit);
          }
        }
      } catch (e) { /* partial chunk */ }
    }
  }

  if (fullText) onLine(fullText);
}

async function streamLines(text, onLine) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    onLine(lines[i] + (i < lines.length - 1 ? '\n' : ''));
    await new Promise(r => setTimeout(r, 10));
  }
  return text;
}

async function callDeepSeekStreamLines(messages, prompt, onLine, abortSignal) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured');
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    signal: abortSignal,
    body: JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 4096, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
  await consumeOpenAIStreamLines(response, onLine);
}

async function callORStreamLines(messages, prompt, onLine, abortSignal, reasoning = false) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const pool = reasoning ? OPENROUTER_REASON_MODELS : OPENROUTER_FAST_MODELS;
  const model = pool[orIdx % pool.length];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': APP_REFERER, 'X-Title': 'GRIND AI' },
    signal: abortSignal,
    body: JSON.stringify({ model, max_tokens: 4096, temperature: reasoning ? 0.3 : 0.4, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
  await consumeOpenAIStreamLines(response, onLine);
}

async function callGemini(messages, prompt, imageBase64 = null) {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini keys configured');
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const contents = messages.map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }));
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') last.parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  }
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents, generationConfig: { temperature: 0.4, maxOutputTokens: 4096 } }) }
  );
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(messages, prompt) {
  if (!GROQ_KEYS.length) throw new Error('No Groq keys configured');
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 4096, temperature: 0.4, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function getReply(messages, prompt, imageBase64 = null) {
  const attempts = [() => callGemini(messages, prompt, imageBase64), () => callGroq(messages, prompt)];
  let lastErr;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (e) { lastErr = e; console.log('❌ provider failed:', e.message); }
  }
  throw lastErr || new Error('ALL_PROVIDERS_EXHAUSTED');
}

async function routeReplyStream({ messages, prompt, onLine, abortSignal, deep, imageBase64 }) {
  if (deep && DEEPSEEK_KEY) {
    try {
      await callDeepSeekStreamLines(messages, prompt, onLine, abortSignal);
      return { model: 'deepseek-r1' };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.log('❌ DeepSeek R1 stream failed, falling back:', e.message);
    }
  }

  try {
    await callORStreamLines(messages, prompt, onLine, abortSignal, deep);
    return { model: deep ? 'openrouter-reasoning' : 'openrouter-fast' };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.log('❌ OpenRouter stream failed, falling back to non-stream:', e.message);
  }

  const text = await getReply(messages, prompt, imageBase64);
  await streamLines(text, onLine);
  return { model: 'fallback' };
}

// ══════════════════════════════════════════════════════════
//  UNIFIED "/api/solve-doubt" AI LAYER — cost perimeter logic
// ══════════════════════════════════════════════════════════

// ── REQUIREMENT 2 config: model routing per requested mode ──
const TOKEN_LIMIT      = 50000;
const DOWNGRADE_MODEL  = 'openai/gpt-5.4-nano';

const MODE_ROUTING = {
  fast:     { model: 'openai/gpt-5.4-nano', provider: 'openrouter', reasoning: false, search: false },
  balanced: { model: 'sonar',               provider: 'perplexity', reasoning: false, search: true  },
  depth:    { model: 'openai/gpt-5.4-mini',  provider: 'openrouter', reasoning: true,  search: false }
};

function buildDowngradeConfig() {
  return { model: DOWNGRADE_MODEL, provider: 'openrouter', reasoning: false, search: false };
}

async function callOpenRouterUnified(model, messages, systemPrompt, { reasoning = false, search = false } = {}) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];

  const payload = {
    model,
    max_tokens: 4096,
    temperature: reasoning ? 0.3 : 0.4,
    messages: [{ role: 'system', content: systemPrompt }, ...messages]
  };
  if (reasoning) payload.reasoning = { enabled: true };
  if (search)    payload.plugins  = [{ id: 'web' }];

  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': APP_REFERER,
      'X-Title': 'GRIND AI'
    },
    body: JSON.stringify(payload)
  }, 45000);

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {}
  };
}

async function callPerplexityUnified(model, messages, systemPrompt, { search = true } = {}) {
  if (!PERPLEXITY_KEY) throw new Error('PERPLEXITY_API_KEY not configured');

  const payload = {
    model,
    max_tokens: 4096,
    temperature: 0.4,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    return_related_questions: false,
    // Perplexity's "sonar" model performs web search by default.
    // When search === false we explicitly disable it to keep costs flat.
    ...(search ? {} : { disable_search: true })
  };

  const response = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PERPLEXITY_KEY}` },
    body: JSON.stringify(payload)
  }, 45000);

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Perplexity error');

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {}
  };
}

async function callUnifiedAI(config, messages, systemPrompt) {
  if (config.provider === 'perplexity') {
    return callPerplexityUnified(config.model, messages, systemPrompt, { search: config.search });
  }
  return callOpenRouterUnified(config.model, messages, systemPrompt, {
    reasoning: config.reasoning,
    search: config.search
  });
}

function extractTokensUsed(usage) {
  if (!usage) return 0;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const inputTokens  = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return inputTokens + outputTokens;
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPT (knowledge-base / RAG block fully removed)
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, usingReasoner = false) {
  const name = user?.name?.split(' ')[0] || 'there';
  const canGoDeep = !!user?.isPro;
  const speed = canGoDeep ? (user?.responseSpeed || 'balanced')
    : (user?.responseSpeed === 'deep' ? 'balanced' : (user?.responseSpeed || 'balanced'));
  const speedMap = {
    fast:     'SHORT and direct — 2-4 sentences unless the question genuinely needs a derivation.',
    balanced: 'Medium length — full explanation, no filler, no repeated caveats.',
    deep:     'DEEP — complete derivations, the common trap, and one adjacent worked example. ' +
              (usingReasoner ? "You are running as GRIND's Deep Reasoning model — reason through edge cases before answering." : '')
  };

  const lines = [
    "You are GRIND, operating in persona 'AIR-1 Ranker AI' — an elite AI mentor for Indian JEE and NEET aspirants. You teach concepts well enough to top the exam, AND you are a steady, caring presence during one of the most stressful stretches of a student's life. Both matter; neither is optional.",
    "",
    "STUDENT",
    `Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}`,
    `Coaching: ${user?.coaching || 'self-study'} | Currently struggling with: ${user?.biggestStruggle || 'not specified'}`,
    `Response depth: ${speedMap[speed]}`,
    "",
    "========================================================",
    "HARD SUBJECT CONSTRAINTS (non-negotiable)",
    "========================================================",
    "1. BIOLOGY: strictly use NCERT terminology, word-for-word where NCERT is specific. Do not paraphrase defined terms.",
    "2. PHYSICS & MATH: ALWAYS perform an explicit dimensional-analysis (units) check on the final expression BEFORE stating the final answer. Show the check.",
    "3. NON-ACADEMIC questions: gently and briefly steer the student back to studying — one warm line, then pivot to a useful next study action. Do not lecture.",
    "",
    "========================================================",
    "HOW YOU TEACH (default shape)",
    "========================================================",
    "You are \"GRIND,\" an elite IIT Professor and a compassionate elder brother (\"Bhaiya\") to students preparing for JEE Main, JEE Advanced, and NEET. Your goal is not to turn students into rote-learning machines, but to mold them into original thinkers, brilliant problem-solvers, and resilient human beings.",
    "Balance intellectual rigor with psychological empathy. Warm, honest, intellectually stimulating, grounding tone. Blend conversational English with relatable Hindi phrases (\"Suno,\" \"Bhai,\" \"Samjhe?\") to build a fraternal bond.",
    "",
    "### CORE PEDAGOGICAL PILLARS",
    "1. Socratic first-principles approach — never dump raw answers immediately; break problems into checkpoints and ask leading questions.",
    "2. Deep physical/mathematical intuition — explain the 'why' before the equation, use vivid analogies.",
    "3. Strip the glamour — use Stoicism/Gita philosophy to help students cope with pressure; remind them the exam is a checkpoint, not their identity.",
    "",
    "### EMOTIONAL SUPPORT",
    "If a student is overwhelmed, ask for their native language and switch into a warm mix of that language + English, using affectionate elder-sibling terms. Use CBT-style reframing, somatic grounding, and the 2-minute rule for motivation friction. Remind them of life beyond the exam.",
    "",
    "========================================================",
    "MATH FORMATTING — MANDATORY",
    "========================================================",
    "- Inline math uses $...$ (no space just inside the delimiters).",
    "- Standalone equations use \\[...\\] on their own line, blank line before and after.",
    "- Never write formulas/fractions/exponents in plain text. Never leave a delimiter unclosed.",
    "",
    "========================================================",
    "GROUNDING & SOURCES",
    "========================================================",
    "- Reference standard texts naturally: Physics → HC Verma, Irodov, DC Pandey. Chemistry → MS Chouhan (Org), N Awasthi (Phys), NCERT (Inorg). Biology → NCERT for NEET.",
    "- If a photo is attached, transcribe the relevant part first, then correct/solve.",
    "========================================================",
    "HARD RULES",
    "========================================================",
    "- Only authenticated students use you.",
    "- Mirror the student's language (Hinglish stays Hinglish).",
    "- Keep paragraphs under 10-20 sentences; use line breaks/steps."
  ];

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);
}

// ── AUTH ──
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── USER ──
app.get('/api/me', requireAuth, async (req, res) => {
  const u = await enforcePlanExpiry(req.user);
  res.json({
    user: {
      id: u._id, name: u.name, email: u.email, photo: u.photo,
      isOnboarded: u.isOnboarded, exam: u.exam, class: u.class,
      coaching: u.coaching, biggestStruggle: u.biggestStruggle,
      responseSpeed: u.responseSpeed || 'balanced', examDate: u.examDate,
      isPro: u.isPro, planType: u.planType, planExpiresAt: u.planExpiresAt,
      totalTokensConsumed: u.totalTokensConsumed || 0,
      deepSeekConfigured: !!DEEPSEEK_KEY
    }
  });
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle } = req.body;
    if (!exam || !cls) return res.status(400).json({ error: 'Exam and class are required.' });
    await User.findByIdAndUpdate(req.user._id, { exam, class: cls, coaching: coaching || '', biggestStruggle: biggestStruggle || '', isOnboarded: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Something went wrong.' }); }
});

app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const { responseSpeed, examDate } = req.body;
    const update = {};
    if (responseSpeed) {
      if (!['fast', 'balanced', 'deep'].includes(responseSpeed)) return res.status(400).json({ error: 'Invalid response depth.' });
      if (responseSpeed === 'deep' && !req.user.isPro) return res.status(402).json({ error: 'Deep mode requires Pro.' });
      update.responseSpeed = responseSpeed;
    }
    if (examDate !== undefined) update.examDate = examDate ? new Date(examDate) : null;
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Could not save settings.' }); }
});

// ── PLAN / PAYWALL ──
const PLAN_DURATIONS_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000 };
app.post('/api/user/upgrade', requireAuth, async (req, res) => {
  try {
    const { plan, promoCode } = req.body;
    if (!PLAN_DURATIONS_MS[plan]) return res.status(400).json({ error: 'Unknown plan.' });
    let durationMs = PLAN_DURATIONS_MS[plan];
    let promoApplied = null;
    if (promoCode) {
      const applied = await applyPromoCode(req.user, promoCode);
      if (applied.ok) { durationMs += applied.bonusDays * 86400000; promoApplied = applied.code; }
      else return res.status(400).json({ error: applied.error });
    }
    const expires = new Date(Date.now() + durationMs);
    await User.findByIdAndUpdate(req.user._id, { isPro: true, planType: plan, planExpiresAt: expires });
    res.json({ success: true, planType: plan, planExpiresAt: expires, promoApplied, testMode: true });
  } catch (err) { res.status(500).json({ error: 'Could not start upgrade.' }); }
});

app.post('/api/user/redeem-promo', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'Enter a code.' });
    const applied = await applyPromoCode(req.user, code);
    if (!applied.ok) return res.status(400).json({ error: applied.error });
    const user = await User.findById(req.user._id);
    const base = user.isPro && user.planExpiresAt && new Date(user.planExpiresAt) > new Date() ? new Date(user.planExpiresAt) : new Date();
    const expires = new Date(base.getTime() + applied.bonusDays * 86400000);
    user.isPro = true;
    user.planType = user.planType || 'promo';
    user.planExpiresAt = expires;
    await user.save();
    res.json({ success: true, bonusDays: applied.bonusDays, planExpiresAt: expires });
  } catch (err) { res.status(500).json({ error: 'Could not redeem code.' }); }
});

async function applyPromoCode(reqUser, rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (reqUser.promoRedeemed?.includes(code)) return { ok: false, error: 'You have already used this code.' };
  const promo = await PromoCode.findOne({ code });
  if (!promo || !promo.active) return { ok: false, error: 'Invalid or inactive promo code.' };
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return { ok: false, error: 'This promo code has expired.' };
  if (promo.maxRedemptions > 0 && promo.redeemedCount >= promo.maxRedemptions) return { ok: false, error: 'This promo code has been fully redeemed.' };
  const updateFilter = { code, active: true, ...(promo.maxRedemptions > 0 ? { redeemedCount: { $lt: promo.maxRedemptions } } : {}) };
  const updated = await PromoCode.findOneAndUpdate(updateFilter, { $inc: { redeemedCount: 1 } }, { new: true });
  if (!updated) return { ok: false, error: 'This promo code just ran out. Try another.' };
  await User.findByIdAndUpdate(reqUser._id, { $addToSet: { promoRedeemed: code } });
  return { ok: true, bonusDays: promo.bonusDays, code };
}

// ── ADMIN: promo codes ──
const requireAdmin = (req, res, next) => {
  if (process.env.ADMIN_KEY && req.query.key === process.env.ADMIN_KEY) return next();
  res.status(403).json({ error: 'Forbidden' });
};
app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try {
    const { code, bonusDays, maxRedemptions, expiresAt, note } = req.body;
    if (!code || !bonusDays) return res.status(400).json({ error: 'code and bonusDays are required.' });
    const promo = await PromoCode.create({ code: code.trim().toUpperCase(), bonusDays, maxRedemptions: maxRedemptions || 0, expiresAt: expiresAt ? new Date(expiresAt) : null, note: note || '' });
    res.json({ promo });
  } catch (e) { res.status(500).json({ error: e.code === 11000 ? 'That code already exists.' : 'Could not create code.' }); }
});
app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try { res.json({ promoCodes: await PromoCode.find().sort({ createdAt: -1 }) }); } catch (err) { res.status(500).json({ error: 'Could not load.' }); }
});
app.patch('/api/admin/promo-codes/:code', requireAdmin, async (req, res) => {
  try {
    const promo = await PromoCode.findOneAndUpdate({ code: req.params.code.toUpperCase() }, req.body, { new: true });
    if (!promo) return res.status(404).json({ error: 'Not found.' });
    res.json({ promo });
  } catch (err) { res.status(500).json({ error: 'Could not update.' }); }
});

// ══════════════════════════════════════════════════════════
//  UNIFIED DOUBT-SOLVING ENDPOINT — 50K TOKEN COST PERIMETER
// ══════════════════════════════════════════════════════════
app.post('/api/solve-doubt', requireAuth, rateLimit(20, 60000), async (req, res) => {
  try {
    const { message, mode, sessionId } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        answer: null,
        limitWarning: false,
        message: 'A question is required.',
        tokensUsedSession: req.user?.totalTokensConsumed || 0
      });
    }

    // ── Fetch the LIVE user document from Mongo (fresh token count) ──
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ success: false, error: 'User not found.' });
    await enforcePlanExpiry(user);

    const requestedMode = ['fast', 'balanced', 'depth'].includes(mode) ? mode : 'balanced';

    let activeConfig;
    let wasDowngraded;

    // ── REQUIREMENT 2: Automated Model Downgrade & Fallback Logic ──
    if (user.totalTokensConsumed > TOKEN_LIMIT) {
      // Over the 50k allowance → FORCE nano, disable reasoning + search,
      // regardless of what the frontend requested.
      activeConfig = buildDowngradeConfig();
      wasDowngraded = true;
    } else {
      // Still under budget → normal routing map
      activeConfig = MODE_ROUTING[requestedMode];
      wasDowngraded = false;
    }

    const systemPrompt = buildSystemPrompt(user, activeConfig.reasoning);
    const messages = [{ role: 'user', content: message }];

    let aiResult;
    try {
      aiResult = await callUnifiedAI(activeConfig, messages, systemPrompt);
    } catch (primaryErr) {
      // Safety net: if the routed model/provider call fails outright,
      // retry once on the cheapest model instead of failing the request.
      console.error('❌ Primary model call failed, retrying on nano:', primaryErr.message);
      activeConfig = buildDowngradeConfig();
      wasDowngraded = true;
      aiResult = await callUnifiedAI(activeConfig, messages, systemPrompt);
    }

    const { content: answer, usage } = aiResult;

    // ── REQUIREMENT 3: Token Accumulation & Database Update ──
    const tokensUsed = extractTokensUsed(usage);
    user.totalTokensConsumed = (user.totalTokensConsumed || 0) + tokensUsed;
    user.lastActive = new Date();
    await user.save();

    // Optional: persist the exchange to the chat session
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          {
            $push: {
              messages: {
                $each: [
                  { role: 'user', content: message },
                  { role: 'assistant', content: answer, model: activeConfig.model }
                ]
              }
            },
            $set: { updatedAt: new Date() }
          }
        );
      } catch (e) { console.error('Session save (solve-doubt):', e.message); }
    }

    // ── REQUIREMENT 4: Frontend Notification Flag — exact payload shape ──
    return res.json({
      success: true,
      answer,
      limitWarning: wasDowngraded,
      message: wasDowngraded
        ? 'High-performance reasoning limit reached. Automatically switched to lightweight model.'
        : null,
      tokensUsedSession: user.totalTokensConsumed
    });

  } catch (err) {
    console.error('❌ /api/solve-doubt error:', err.message);
    return res.status(500).json({
      success: false,
      answer: null,
      limitWarning: false,
      message: 'GRIND hit a snag processing that. Please try again in a moment.',
      tokensUsedSession: req.user?.totalTokensConsumed || 0
    });
  }
});

// ══════════════════════════════════════════════════════════
//  CHAT STREAM (SSE over POST) — line‑by‑line
//  (knowledge-base / RAG retrieval removed)
// ══════════════════════════════════════════════════════════
app.post('/api/chat/stream', requireAuth, rateLimit(20, 60000), async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  if (!messages || !Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'Invalid request.' });

  const user = await enforcePlanExpiry(req.user);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const recent = messages.slice(-20);

    // Phase 1: thinking steps (no RAG lookup anymore)
    send('thinking', { step: 'Reading your question…' });
    await sleep(120);
    send('thinking', { step: 'Identifying the core concept…' });
    await sleep(140);

    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const q = lastUserMsg?.content || '';

    const useDeep = !!(user.isPro && user.responseSpeed === 'deep');
    if (useDeep) { send('thinking', { step: 'Engaging Deep Reasoning model — mapping edge cases…' }); await sleep(160); }
    if (/physics|force|velocity|energy|math|integral|derivat|newton|circuit/i.test(q)) {
      send('thinking', { step: 'Preparing dimensional-analysis check…' }); await sleep(120);
    }
    send('thinking', { step: 'Drafting solution…' });

    // Phase 2: generate with line‑by‑line streaming
    const prompt = buildSystemPrompt(user, useDeep);

    let fullReply = '';
    const onLine = (line) => {
      if (!fullReply) send('answer_start', {});
      fullReply += line;
      send('chunk', { text: line });
    };

    const { model } = await routeReplyStream({
      messages: recent,
      prompt,
      onLine,
      abortSignal: abortController.signal,
      deep: useDeep,
      imageBase64: imageBase64 || null
    });

    // Persist
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        const userMsg = messages[messages.length - 1];
        const existing = await ChatSession.findOne({ _id: sessionId, userId: user._id }).select('messages').lean();
        const title = existing && existing.messages.length === 0 ? (userMsg.content || 'Image question').slice(0, 50) : undefined;
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          { $push: { messages: { $each: [
                { role: 'user', content: userMsg.content },
                { role: 'assistant', content: fullReply, model }
              ] } },
            $set: { updatedAt: new Date(), ...(title ? { title } : {}) } }
        );
      } catch (e) { console.error('Session save:', e.message); }
    }

    send('done', { reply: fullReply, model });
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('Stream AI error:', err.message);
    send('error', { error: 'GRIND is taking a short break. Please try again.' });
    res.end();
  }
});

// ── SESSIONS ──
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id }).select('title createdAt updatedAt').sort({ updatedAt: -1 }).limit(50);
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: 'Could not load chats.' }); }
});
app.get('/api/sessions/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ sessions: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sessions = await ChatSession.find({ userId: req.user._id, $or: [{ title: regex }, { 'messages.content': regex }] })
      .select('title updatedAt').sort({ updatedAt: -1 }).limit(20).lean();
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: 'Search failed.' }); }
});
app.get('/api/sessions/last', requireAuth, async (req, res) => {
  try {
    const last = await ChatSession.findOne({ userId: req.user._id }).sort({ updatedAt: -1 }).select('_id').lean();
    res.json({ sessionId: last ? last._id : null });
  } catch (err) { res.status(500).json({ error: 'Could not get last session.' }); }
});
app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid session id.' });
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    res.json({ session: s });
  } catch (err) { res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.create({ userId: req.user._id, title: 'New chat', messages: [] });
    res.json({ sessionId: s._id });
  } catch (err) { res.status(500).json({ error: 'Could not create chat.' }); }
});
app.post('/api/sessions/:id/truncate', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid session id.' });
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    s.messages = s.messages.slice(0, Math.max(0, req.body.keepCount || 0));
    s.updatedAt = new Date();
    await s.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Could not update chat.' }); }
});
app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try { await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id }); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Could not delete.' }); }
});

// ── NOTES ──
app.get('/api/notes', requireAuth, async (req, res) => {
  try { res.json({ notes: await Note.find({ userId: req.user._id }).sort({ updatedAt: -1 }).lean() }); }
  catch (err) { res.status(500).json({ error: 'Could not load notes.' }); }
});
app.post('/api/notes', requireAuth, async (req, res) => {
  try {
    const note = await Note.create({ userId: req.user._id, title: req.body.title || 'Untitled', content: req.body.content || '' });
    res.json({ note });
  } catch (err) { res.status(500).json({ error: 'Could not create note.' }); }
});
app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    const note = await Note.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { title, content, updatedAt: new Date() }, { new: true });
    if (!note) return res.status(404).json({ error: 'Not found.' });
    res.json({ note });
  } catch (err) { res.status(500).json({ error: 'Could not update.' }); }
});
app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try { await Note.deleteOne({ _id: req.params.id, userId: req.user._id }); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Could not delete.' }); }
});
app.post('/api/notes/ai-assist', requireAuth, rateLimit(15, 60000), async (req, res) => {
  try {
    const { content, action } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'No content provided.' });
    const actionPrompts = {
      improve:     'Improve clarity, flow and grammar. Keep meaning and length similar. Keep LaTeX/markdown intact.',
      summarize:   'Summarize into a tight, high-yield bullet summary. Keep key formulas in LaTeX.',
      expand:      'Expand with more detail and examples useful for a JEE/NEET student. Use LaTeX for all math.',
      fix_grammar: 'Fix all spelling and grammar. Do not change meaning or formatting.',
      bullets:     'Convert into clean, well-organized bullet points. Keep LaTeX intact.',
      explain:     'Explain this simply, as if teaching a confused student. Use analogies and LaTeX for math.'
    };
    const instruction = actionPrompts[action] || actionPrompts.improve;
    const prompt = 'You are a study-notes assistant for a JEE/NEET student.\nTask: ' + instruction + '\nRespond with ONLY the rewritten text — no preamble, no code fences. Use $inline$ and \\[block\\] LaTeX.';
    const result = await getReply([{ role: 'user', content }], prompt);
    res.json({ result: result.trim() });
  } catch (e) { console.error('Notes AI assist:', e.message); res.status(500).json({ error: 'AI assist failed. Try again.' }); }
});

// ── SPA FALLBACK ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND v2 running on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OpenRouter=${OPENROUTER_KEYS.length} Perplexity=${PERPLEXITY_KEY ? 'ON' : 'off'} DeepSeekR1=${DEEPSEEK_KEY ? 'ON' : 'off (deep falls back to OpenRouter)'} Anthropic=${ANTHROPIC_KEY ? 'ON' : 'off (reserved slot)'}`);
  console.log(`💰 Cost perimeter: ${TOKEN_LIMIT} tokens/user before forced downgrade to ${DOWNGRADE_MODEL}`);
});
