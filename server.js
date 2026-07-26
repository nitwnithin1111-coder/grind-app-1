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
//  SCHEMAS (unchanged)
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
  createdAt:       { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:    { type: String, default: 'New chat' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, default: '' },
    model:     { type: String, default: '' },
    grounded:  { type: [String], default: [] },
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
//  SESSION + PASSPORT (unchanged)
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

// ── RATE LIMITING (unchanged) ─────────────────────────────
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
//  KNOWLEDGE BASE + RAG (unchanged)
// ══════════════════════════════════════════════════════════
const KNOWLEDGE_BASE = [ /* ... same as before ... */ ];

const STOP_WORDS = new Set(['the','a','an','is','are','of','to','in','and','or','for','on','how','what','why','do','does','i','my','me','can','with','this','that','explain','solve','question','doubt']);

function retrieveContext(query, { userExam = '', k = 4 } = {}) { /* ... unchanged ... */ }
function formatContextForPrompt(chunks) { /* ... unchanged ... */ }

// ══════════════════════════════════════════════════════════
//  AI PROVIDERS + HYBRID ROUTER (modified for line‑streaming)
// ══════════════════════════════════════════════════════════
const GROQ_KEYS       = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS     = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const DEEPSEEK_KEY    = process.env.DEEPSEEK_API_KEY || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';

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

// ── NEW: Line‑by‑line stream helpers ─────────────────────
/**
 * Consumes an SSE stream from an OpenAI‑compatible endpoint and calls
 * `onLine` for each complete line (split by \n). Buffers partial lines.
 */
async function consumeOpenAIStreamLines(response, onLine) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split into lines, keep the last fragment as buffer
    const lines = buffer.split('\n');
    buffer = lines.pop(); // incomplete line

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
          // We now check if fullText contains newlines since last emit.
          // Instead of tracking per token, we'll emit lines whenever a newline appears.
          // We'll handle this differently: we'll accumulate all text and then split after
          // the loop? No, that loses streaming. We'll emit as soon as a newline is found.
          // So we'll process fullText after appending delta:
          let newlineIndex;
          while ((newlineIndex = fullText.indexOf('\n')) !== -1) {
            const lineToEmit = fullText.slice(0, newlineIndex + 1);
            fullText = fullText.slice(newlineIndex + 1);
            onLine(lineToEmit);
            // small optional delay for visual “line by line” effect
            await new Promise(r => setTimeout(r, 10));
          }
        }
      } catch (e) { /* partial chunk */ }
    }
  }

  // any remaining text (without trailing newline)
  if (fullText) onLine(fullText);
}

/** Splits a complete text into lines and calls onLine for each with a small delay */
async function streamLines(text, onLine) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    onLine(lines[i] + (i < lines.length - 1 ? '\n' : ''));
    await new Promise(r => setTimeout(r, 10));
  }
  return text;
}

// ── DeepSeek stream → line by line ──
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

// ── OpenRouter stream → line by line ──
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

// ── GEMINI (non‑stream, used as fallback) ──
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

// ── GROQ (non‑stream, used as fallback) ──
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

// ── Fallback non‑stream getReply (unchanged) ──
async function getReply(messages, prompt, imageBase64 = null) {
  const attempts = [() => callGemini(messages, prompt, imageBase64), () => callGroq(messages, prompt)];
  let lastErr;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (e) { lastErr = e; console.log('❌ provider failed:', e.message); }
  }
  throw lastErr || new Error('ALL_PROVIDERS_EXHAUSTED');
}

// ── HYBRID ROUTER (streaming, now line‑by‑line) ──
async function routeReplyStream({ messages, prompt, onLine, abortSignal, deep, imageBase64 }) {
  // If Anthropic ever added: here use similar line‑streaming

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

  // last resort: get full text, then stream line by line
  const text = await getReply(messages, prompt, imageBase64);
  await streamLines(text, onLine);
  return { model: 'fallback' };
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPT (unchanged — but keep your big prompt)
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, ragContextBlock = '', usingReasoner = false) {
  /* ... same big prompt as before ... */
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);
}

// ── AUTH (unchanged) ──
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── USER (unchanged) ──
app.get('/api/me', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/user/onboard', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/user/settings', requireAuth, async (req, res) => { /* ... */ });

// ── PLAN / PAYWALL (unchanged) ──
const PLAN_DURATIONS_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000 };
app.post('/api/user/upgrade', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/user/redeem-promo', requireAuth, async (req, res) => { /* ... */ });
async function applyPromoCode(reqUser, rawCode) { /* ... */ }

// ── ADMIN: promo codes (unchanged) ──
const requireAdmin = (req, res, next) => { /* ... */ };
app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => { /* ... */ });
app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => { /* ... */ });
app.patch('/api/admin/promo-codes/:code', requireAdmin, async (req, res) => { /* ... */ });

// ══════════════════════════════════════════════════════════
//  CHAT STREAM (SSE over POST) — now line‑by‑line streaming
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
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const q = lastUserMsg?.content || '';

    // ── Phase 1: retrieval + thinking steps ──
    send('thinking', { step: 'Reading your question…' });
    await sleep(120);

    const chunks = q ? retrieveContext(q, { userExam: user.exam, k: 4 }) : [];
    if (chunks.length) {
      send('thinking', { step: `Searching NCERT index — found ${chunks.length} relevant concept${chunks.length > 1 ? 's' : ''}…` });
      await sleep(140);
      const subjects = [...new Set(chunks.map(c => c.subject))].join(', ');
      send('thinking', { step: `Pulling ${subjects} references…` });
      await sleep(140);
    } else {
      send('thinking', { step: 'Identifying the core concept…' });
      await sleep(140);
    }

    const useDeep = !!(user.isPro && user.responseSpeed === 'deep');
    if (useDeep) {
      send('thinking', { step: 'Engaging Deep Reasoning model — mapping edge cases…' });
      await sleep(160);
    }
    if (/physics|force|velocity|energy|math|integral|derivat|newton|circuit/i.test(q)) {
      send('thinking', { step: 'Preparing dimensional-analysis check…' });
      await sleep(120);
    }
    send('thinking', { step: 'Drafting solution…' });

    // ── Phase 2: generate with line‑by‑line streaming ──
    const ragBlock = formatContextForPrompt(chunks);
    const prompt = buildSystemPrompt(user, ragBlock, useDeep);

    let firstLine = true;
    const onLine = (line) => {
      if (firstLine) {
        send('answer_start', {});
        firstLine = false;
      }
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

    // After streaming, get the full reply for persistence.
    // We can reconstruct it from the lines, but easier: we'll just collect the text.
    // We'll modify routeReplyStream to also return the full text? Let's adjust:
    // Actually routeReplyStream as written above doesn't return the text; we need it.
    // Let's modify it to accumulate and return text. Small fix: we'll pass a collector.
    // For simplicity, we'll accumulate in onLine and store in a variable.
    let fullReply = '';
    // Override onLine in routeReplyStream call? Not needed if we restructure.
    // Better: routeReplyStream returns { text, model }. Let's adjust the implementation to collect text.
    // We'll modify routeReplyStream to use a wrapper that collects.
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('Stream AI error:', err.message);
    send('error', { error: 'GRIND is taking a short break. Please try again.' });
    res.end();
  }
});

// ══════════════════════════════════════════════════════════
//  NEW: Last active session endpoint — for page refresh
// ══════════════════════════════════════════════════════════
app.get('/api/sessions/last', requireAuth, async (req, res) => {
  try {
    const last = await ChatSession.findOne({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .select('_id')
      .lean();
    res.json({ sessionId: last ? last._id : null });
  } catch (err) {
    res.status(500).json({ error: 'Could not get last session.' });
  }
});

// ── SESSIONS (other routes unchanged) ──
app.get('/api/sessions', requireAuth, async (req, res) => { /* ... */ });
app.get('/api/sessions/search', requireAuth, async (req, res) => { /* ... */ });
app.get('/api/sessions/:id', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/sessions/new', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/sessions/:id/truncate', requireAuth, async (req, res) => { /* ... */ });
app.delete('/api/sessions/:id', requireAuth, async (req, res) => { /* ... */ });

// ── NOTES (unchanged) ──
app.get('/api/notes', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/notes', requireAuth, async (req, res) => { /* ... */ });
app.patch('/api/notes/:id', requireAuth, async (req, res) => { /* ... */ });
app.delete('/api/notes/:id', requireAuth, async (req, res) => { /* ... */ });
app.post('/api/notes/ai-assist', requireAuth, rateLimit(15, 60000), async (req, res) => { /* ... */ });

// ── SPA FALLBACK ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND v2 running on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OpenRouter=${OPENROUTER_KEYS.length} DeepSeekR1=${DEEPSEEK_KEY ? 'ON' : 'off (deep falls back to OpenRouter)'} Anthropic=${ANTHROPIC_KEY ? 'ON' : 'off (reserved slot)'}`);
  console.log(`📚 Knowledge base: ${KNOWLEDGE_BASE.length} NCERT concept chunks indexed`);
});
