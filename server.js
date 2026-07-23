require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const compression    = require('compression');
const helmet         = require('helmet');
const mongoose       = require('mongoose');
const session        = require('express-session');
const MongoStore     = require('connect-mongo');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();

// ── SECURITY & PERF MIDDLEWARE ────────────────────────────
// CSP disabled here because index.html pulls fonts/katex from CDNs and
// uses inline scripts/styles. If you self-host assets later, tighten this.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ───────────────────────────────────────────────
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
  createdAt:       { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:    { type: String, default: 'New chat' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, default: '' },
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

// ── SESSION ───────────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set. Using an insecure default — set this before deploying.');
}
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

// ── PASSPORT ──────────────────────────────────────────────
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

// ── LIGHTWEIGHT RATE LIMITING ─────────────────────────────
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
//  AI PROVIDER LAYER — Hybrid Router
//  No Anthropic key needed. Uses your existing free-tier stack.
//  DeepSeek R1 slot is ready: set DEEPSEEK_API_KEY and it becomes
//  the primary "Deep Dive" reasoner automatically.
// ══════════════════════════════════════════════════════════
const GROQ_KEYS       = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS     = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const DEEPSEEK_KEY    = process.env.DEEPSEEK_API_KEY || '';

// Fast lane (Sonnet-equivalent) vs Deep lane (Opus/R1-equivalent) models on OpenRouter
const OR_FAST_MODELS = ['deepseek/deepseek-chat:free', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free'];
const OR_DEEP_MODELS = ['deepseek/deepseek-r1:free', 'deepseek/deepseek-chat:free', 'openai/gpt-oss-120b:free'];

let gIdx = 0, grIdx = 0, orIdx = 0, orFastMIdx = 0, orDeepMIdx = 0;

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

// ── DeepSeek (R1 reasoner) — non-stream + stream ──────────
async function callDeepSeek(messages, prompt, deep) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured yet');
  const model = deep ? 'deepseek-reasoner' : 'deepseek-chat';
  const response = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'system', content: prompt }, ...messages] })
  }, 90000);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}
async function callDeepSeekStream(messages, prompt, onToken, abortSignal, deep) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured yet');
  const model = deep ? 'deepseek-reasoner' : 'deepseek-chat';
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    signal: abortSignal,
    body: JSON.stringify({ model, max_tokens: 4000, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
  return consumeOpenAIStream(response, onToken);
}

// ── OpenRouter — non-stream + stream, lane-aware ──────────
function pickORModel(deep) {
  return deep ? OR_DEEP_MODELS[orDeepMIdx++ % OR_DEEP_MODELS.length]
              : OR_FAST_MODELS[orFastMIdx++ % OR_FAST_MODELS.length];
}
async function callOR(messages, prompt, deep) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = pickORModel(deep);
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.35, messages: [{ role: 'system', content: prompt }, ...messages] })
  }, deep ? 90000 : 45000);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}
async function callORStream(messages, prompt, onToken, abortSignal, deep) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = pickORModel(deep);
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
    signal: abortSignal,
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.35, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
  return consumeOpenAIStream(response, onToken);
}

// Shared OpenAI-style SSE stream reader
async function consumeOpenAIStream(response, onToken) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '', buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken(delta); }
      } catch (e) { /* ignore partial chunk */ }
    }
  }
  if (!full) throw new Error('Empty stream response');
  return full;
}

// ── Gemini (vision-capable, handles image attachments) ────
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
      body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents, generationConfig: { temperature: 0.35, maxOutputTokens: 4000 } }) }
  );
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
}

// ── Groq (fast fallback) ──────────────────────────────────
async function callGroq(messages, prompt) {
  if (!GROQ_KEYS.length) throw new Error('No Groq keys configured');
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 4000, temperature: 0.35, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

// ── ROUTER — non-streaming (used by notes assist etc.) ────
async function getReply(messages, prompt, imageBase64 = null, deep = false) {
  const attempts = [];
  if (imageBase64) attempts.push(() => callGemini(messages, prompt, imageBase64)); // vision first
  if (DEEPSEEK_KEY) attempts.push(() => callDeepSeek(messages, prompt, deep));
  attempts.push(
    () => callOR(messages, prompt, deep),
    () => callGemini(messages, prompt, imageBase64),
    () => callGroq(messages, prompt)
  );
  let lastErr;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (e) { lastErr = e; console.log('❌ provider failed:', e.message); }
  }
  throw lastErr || new Error('ALL_PROVIDERS_EXHAUSTED');
}

// ── ROUTER — streaming ────────────────────────────────────
async function getReplyStream(messages, prompt, onToken, abortSignal, imageBase64 = null, deep = false) {
  // Vision requests can't stream through Gemini here — do it non-streamed then emit.
  if (imageBase64) {
    const text = await getReply(messages, prompt, imageBase64, deep);
    onToken(text);
    return text;
  }
  if (DEEPSEEK_KEY) {
    try { return await callDeepSeekStream(messages, prompt, onToken, abortSignal, deep); }
    catch (e) { if (e.name === 'AbortError') throw e; console.log('❌ DeepSeek stream failed, falling back:', e.message); }
  }
  try { return await callORStream(messages, prompt, onToken, abortSignal, deep); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    console.log('❌ OR-stream failed, falling back to non-streaming:', e.message);
  }
  const text = await getReply(messages, prompt, null, deep);
  onToken(text);
  return text;
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPT — "AIR-1 Ranker AI"
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, deep = false) {
  const name = user?.name?.split(' ')[0] || 'there';
  const canGoDeep = !!user?.isPro;
  const speed = canGoDeep ? (user?.responseSpeed || 'balanced')
                          : (user?.responseSpeed === 'deep' ? 'balanced' : (user?.responseSpeed || 'balanced'));
  const speedMap = {
    fast:     'SHORT and direct — 2–4 sentences unless the question genuinely needs a derivation.',
    balanced: 'Medium length — full explanation, no filler, no repeated caveats.',
    deep:     'DEEP — complete derivations, every step, the common trap, and one adjacent worked example. ' +
              (deep ? 'You are running as GRIND\'s Deep Reasoning model — actually reason through edge cases before answering.' : '')
  };

  const lines = [
    "You are GRIND, presenting as \"AIR-1 Ranker AI\" — an elite AI mentor for Indian JEE and NEET aspirants. You explain concepts so completely and clearly that a motivated student can go from confused to confident in a single answer. You are also a steady, caring presence during a very stressful phase of life.",
    "",
    "STUDENT",
    `Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}`,
    `Coaching: ${user?.coaching || 'self-study'} | Struggling with: ${user?.biggestStruggle || 'not specified'}`,
    `Response depth: ${speedMap[speed]}`,
    "",
    "========================================================",
    "HOW YOU THINK (INTERNAL — do not narrate these labels)",
    "========================================================",
    "Before answering, silently: (1) identify the exact concept and sub-topic, (2) recall the governing principles/formulas from memory, (3) plan the cleanest solution path. Then write the polished answer. Explain everything in full detail — never rely on any external database; use your own knowledge deeply.",
    "",
    "========================================================",
    "HOW YOU TEACH",
    "========================================================",
    "For any concept or question:",
    "1. **Name the concept plainly** in one line.",
    "2. **Build intuition first** — explain like to a smart friend who hasn't seen it, before any formula.",
    "3. **Walk a worked example** step by step — every algebraic/logical step shown, nothing skipped.",
    "4. **Flag the trap** — how NTA/JEE likes to test this, or the mistake students reliably make.",
    "5. **End with ONE self-try question** pitched just above what they saw. Then stop and let them attempt it. When they answer, check their reasoning (not just the final number), correct the actual misstep, then offer the next question.",
    "",
    "For \"solve this for me\" requests: solve it fully, but narrate your reasoning like a great teacher thinking out loud.",
    "",
    "========================================================",
    "SUBJECT CONSTRAINTS — NON-NEGOTIABLE",
    "========================================================",
    "- **Biology (NEET):** Strictly use NCERT terminology, word-for-word where it matters. Do not invent synonyms NCERT doesn't use.",
    "- **Physics & Math:** ALWAYS perform an explicit dimensional-analysis / units check before stating the final answer. Show the check as its own short step.",
    "- **Chemistry:** Ground in standard sources naturally — MS Chouhan (Organic), N Awasthi (Physical), NCERT (Inorganic).",
    "- Reference standard texts when relevant: Physics → HC Verma, Irodov, DC Pandey.",
    "",
    "========================================================",
    "STEP-BY-STEP FORMATTING (for the frontend toggle)",
    "========================================================",
    "When you give a multi-step derivation, wrap the detailed steps between the markers <<<STEPS>>> and <<<END STEPS>>> on their own lines. Put the intuition and final answer OUTSIDE those markers. Example:",
    "Intuition + setup here.",
    "<<<STEPS>>>",
    "Step 1: ...",
    "Step 2: ...",
    "<<<END STEPS>>>",
    "Final answer + the trap + one self-try question.",
    "Use the markers only when there are genuine derivation steps.",
    "",
    "========================================================",
    "MATH FORMATTING — MANDATORY",
    "========================================================",
    "- Every variable/symbol/expression uses inline LaTeX: $...$ (no space just inside the delimiters).",
    "- Standalone equations use \\[...\\] on their own line, blank line before and after.",
    "- Never write formulas, fractions, or exponents in plain text. Never leave a delimiter unclosed.",
    "",
    "========================================================",
    "EMOTIONAL SUPPORT",
    "========================================================",
    "- Validate before you fix — name the likely feeling in one honest sentence, no diagnosing.",
    "- No hollow encouragement (\"you got this!\", \"great question!\").",
    "- Offer one small next step, not a lecture. Stay with them if they want to talk before studying.",
    "- **Crisis protocol (non-negotiable):** if a message signals self-harm or suicidal thinking, stop all academic talk, say plainly you're concerned, and give these without burying them: Kiran 1800-599-0019, iCall 9152987821, Tele-MANAS 14416. Encourage reaching out to a real person now.",
    "- Never put a clinical label on something the student hasn't named.",
    "",
    "========================================================",
    "HARD RULES",
    "========================================================",
    "- Only authenticated students use you — never mention guest mode or trials.",
    "- Mirror the student's language (Hinglish stays Hinglish) — never translate unless asked.",
    "- If asked a clearly non-academic / off-topic question, answer briefly and warmly, then gently steer back to studying.",
    "- Keep paragraphs under 3 sentences — use line breaks/steps, not walls of text."
  ];

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);
}

// ── AUTH ──────────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── USER ──────────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  const u = await enforcePlanExpiry(req.user);
  res.json({
    user: {
      id: u._id, name: u.name, email: u.email, photo: u.photo,
      isOnboarded: u.isOnboarded, exam: u.exam, class: u.class,
      coaching: u.coaching, biggestStruggle: u.biggestStruggle,
      responseSpeed: u.responseSpeed || 'balanced', examDate: u.examDate,
      isPro: u.isPro, planType: u.planType, planExpiresAt: u.planExpiresAt,
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

// ── PLAN / PAYWALL ────────────────────────────────────────
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

// ── ADMIN: promo code management ──────────────────────────
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

// ── CHAT (streaming, SSE over POST) — no RAG ──────────────
app.post('/api/chat/stream', requireAuth, rateLimit(20, 60000), async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  if (!messages || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Invalid request.' });

  const user = await enforcePlanExpiry(req.user);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const recent = messages.slice(-20);

    // Hybrid router: Pro + Deep => reasoning lane; else fast lane.
    const deep = !!(user.isPro && user.responseSpeed === 'deep');
    const prompt = buildSystemPrompt(user, deep);

    // Emit which "engine" is running so the UI can label the thinking steps.
    send('meta', { engine: deep ? 'deep' : 'fast', deepseek: !!DEEPSEEK_KEY });

    let full = '';
    const reply = await getReplyStream(
      recent, prompt,
      chunk => { full += chunk; send('chunk', { text: chunk }); },
      abortController.signal, imageBase64 || null, deep
    );
    const finalReply = reply || full;

    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        const userMsg = messages[messages.length - 1];
        const existing = await ChatSession.findOne({ _id: sessionId, userId: user._id }).select('messages').lean();
        const title = existing && existing.messages.length === 0 ? (userMsg.content || 'Image question').slice(0, 50) : undefined;
        await ChatSession.updateOne(
          {
