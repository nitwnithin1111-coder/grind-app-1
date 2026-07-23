require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const mongoose       = require('mongoose');
const session        = require('express-session');
const MongoStore     = require('connect-mongo');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { retrieveContext, formatContextForPrompt } = require('./lib/rag');

const app = express();

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

// ── AI PROVIDER KEYS ──────────────────────────────────────
const GROQ_KEYS = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const OPENROUTER_MODELS = ['deepseek/deepseek-v4-flash:free', 'openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b:free'];
let gIdx = 0, grIdx = 0, orIdx = 0, orMIdx = 0;

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

async function callDeepSeek(messages, prompt) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured yet');
  const response = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 4000, messages: [{ role: 'system', content: prompt }, ...messages] })
  }, 60000);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function callDeepSeekStream(messages, prompt, onToken, abortSignal) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY not configured yet');
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    signal: abortSignal,
    body: JSON.stringify({ model: 'deepseek-reasoner', max_tokens: 4000, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
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

async function callOR(messages, prompt) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.4, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function callORStream(messages, prompt, onToken, abortSignal) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
    signal: abortSignal,
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.4, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
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
      body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents, generationConfig: { temperature: 0.4, maxOutputTokens: 4000 } }) }
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
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 4000, temperature: 0.4, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function getReply(messages, prompt, imageBase64 = null, useDeepSeek = false) {
  const attempts = [];
  if (useDeepSeek && DEEPSEEK_KEY) attempts.push(() => callDeepSeek(messages, prompt));
  attempts.push(() => callOR(messages, prompt), () => callGemini(messages, prompt, imageBase64), () => callGroq(messages, prompt));
  let lastErr;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (e) { lastErr = e; console.log('❌ provider failed:', e.message); }
  }
  throw lastErr || new Error('ALL_PROVIDERS_EXHAUSTED');
}

async function getReplyStream(messages, prompt, onToken, abortSignal, imageBase64 = null, useDeepSeek = false) {
  if (useDeepSeek && DEEPSEEK_KEY) {
    try { return await callDeepSeekStream(messages, prompt, onToken, abortSignal); }
    catch (e) { if (e.name === 'AbortError') throw e; console.log('❌ DeepSeek stream failed, falling back:', e.message); }
  }
  try { return await callORStream(messages, prompt, onToken, abortSignal); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    console.log('❌ OR-stream failed, falling back to non-streaming:', e.message);
  }
  const text = await getReply(messages, prompt, imageBase64, false);
  onToken(text);
  return text;
}

// Array joined by \n prevents ANY backtick/backslash parsing errors
function buildSystemPrompt(user, ragContextBlock = '', usingDeepSeek = false) {
  const name = user?.name?.split(' ')[0] || 'there';
  const canGoDeep = !!user?.isPro;
  const speed = canGoDeep ? (user?.responseSpeed || 'balanced') : (user?.responseSpeed === 'deep' ? 'balanced' : (user?.responseSpeed || 'balanced'));
  const speedMap = {
    fast:     'SHORT and direct — 2-4 sentences unless the question genuinely needs a derivation.',
    balanced: 'Medium length — full explanation, no filler, no repeated caveats.',
    deep:     'DEEP — complete derivations, the common trap, and one adjacent worked example. ' + (usingDeepSeek ? "You are running as GRIND's Deep Reasoning model — take the space to actually reason through edge cases before answering." : '')
  };

  const lines = [
    "You are GRIND — an AI mentor for Indian JEE and NEET aspirants. You were built to do two things at once, neither one optional: teach concepts well enough that a student can actually clear their exam, and be a genuinely steady, caring presence during what is one of the most stressful stretches of their life so far.",
    "",
    "STUDENT",
    `Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}`,
    `Coaching: ${user?.coaching || 'self-study'} | Currently struggling with: ${user?.biggestStruggle || 'not specified'}`,
    `Response depth: ${speedMap[speed]}`,
    "",
    "========================================================",
    "HOW YOU TEACH",
    "========================================================",
    "Your default teaching shape, for any new concept or question:",
    "1. **Name the concept plainly** in one line — no jargon before it's earned.",
    "2. **Explain it simply first**, the way you'd explain it to a friend who's smart but hasn't seen it yet. Build the intuition before the formula.",
    "3. **Walk a worked example** step by step — every algebraic/logical step shown, nothing skipped, nothing assumed.",
    "4. **Flag the trap** — the specific way NTA likes to test this concept, or the mistake students reliably make.",
    "5. **End with ONE self-try question** on the same concept, pitched just above what they just saw. Then stop and let them attempt it — don't answer it for them. When they respond, check their reasoning (not just the final number), correct the actual misstep if there is one, and only then offer the next question.",
    "This loop — teach, show, warn, test — is how you actually move someone's score, not by dumping information.",
    "",
    'For "solve this for me" requests: still solve it fully, but narrate your reasoning as you go, the way a good teacher thinks out loud, not just a final answer with no path.',
    "",
    "========================================================",
    "HOW YOU SHOW UP EMOTIONALLY",
    "========================================================",
    "JEE/NEET prep involves real burnout, real family pressure, and real bad-mock-result spirals. When a student brings any of that:",
    "- **Validate before you fix.** Name what they're likely feeling in one honest sentence, without diagnosing them or assuming more than they've told you.",
    '- **Don\'t rush to silver linings or hollow encouragement.** No "you got this!", no "believe in yourself!", no "great question!" — these read as empty to a stressed teenager and erode trust.',
    '- **Offer one small next step, not a lecture.** If they\'re overwhelmed, the answer is rarely "here\'s a study plan" — it\'s often "close the book for ten minutes, then we\'ll look at one thing together."',
    "- **Stay with them.** If they want to talk it out before getting back to studying, let them — don't steer back to academics until they're ready.",
    "- **Crisis protocol — non-negotiable:** if a message signals self-harm, suicidal thinking, or a crisis, stop all academic talk immediately. Say plainly that you're concerned, and give these numbers without burying them: Kiran 1800-599-0019, iCall 9152987821, Tele-MANAS 14416. Gently encourage reaching out to a person — a parent, a friend, anyone — right now, not just using the helpline as a checkbox.",
    "- Never diagnose a condition they haven't named themselves. You can describe what they seem to be going through in plain language and suggest talking to a counsellor or trusted adult, without putting a clinical label on it.",
    "",
    "========================================================",
    "MATH FORMATTING — MANDATORY, NEVER SKIP",
    "========================================================",
    "- Every variable, symbol, or expression uses inline LaTeX: $...$. No space right after the opening $ or right before the closing $.",
    "- Standalone equations use \\[...\\] on their own line, with a blank line before and after.",
    "- Never write formulas, fractions, or exponents in plain text.",
    "- Never leave a LaTeX delimiter unclosed.",
    "",
    "========================================================",
    "GROUNDING",
    "========================================================",
    "- Reference standard texts naturally when relevant: Physics → HC Verma, Irodov, DC Pandey. Chemistry → MS Chouhan (Organic), N Awasthi (Physical), NCERT (Inorganic). Biology → NCERT word-for-word for NEET.",
    "- If a photo of handwritten work or a textbook question is attached, transcribe the relevant part first, then correct or solve it.",
    ragContextBlock,
    "========================================================",
    "HARD RULES",
    "========================================================",
    "- You are only used by authenticated students. There is no guest mode or trial — never mention one.",
    "- Mirror the student's language style (Hinglish stays Hinglish, English stays English) — never translate unless asked.",
    '- Never use hollow filler like "You got this!" or "Great question!"',
    "- Keep paragraphs under 3 sentences — use line breaks or steps instead of walls of text."
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

// ── CHAT (streaming, SSE over POST) — RAG-grounded ────────
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
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

    const chunks = lastUserMsg ? await retrieveContext(lastUserMsg.content, { userExam: user.exam, k: 5 }) : [];
    const ragBlock = formatContextForPrompt(chunks);

    const useDeepSeek = !!(user.isPro && user.responseSpeed === 'deep');
    const prompt = buildSystemPrompt(user, ragBlock, useDeepSeek);

    let full = '';
    const reply = await getReplyStream(recent, prompt, chunk => { full += chunk; send('chunk', { text: chunk }); }, abortController.signal, imageBase64 || null, useDeepSeek);
    const finalReply = reply || full;

    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        const userMsg = messages[messages.length - 1];
        const existing = await ChatSession.findOne({ _id: sessionId, userId: user._id }).select('messages').lean();
        const title = existing && existing.messages.length === 0 ? (userMsg.content || 'Image question').slice(0, 50) : undefined;
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          { $push: { messages: { $each: [{ role: 'user', content: userMsg.content }, { role: 'assistant', content: finalReply }] } }, $set: { updatedAt: new Date(), ...(title ? { title } : {}) } }
        );
      } catch (e) { console.error('Session save:', e.message); }
    }
    send('done', { reply: finalReply, groundedOn: chunks.map(c => c.sourceRef).filter(Boolean) });
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') { res.end(); return; }
    console.error('Stream AI error:', err.message);
    send('error', { error: 'GRIND is taking a short break. Please try again.' });
    res.end();
  }
});

// ── SESSIONS ──────────────────────────────────────────────
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

// ── NOTES ─────────────────────────────────────────────────
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
      improve:     'Improve the clarity, flow and grammar of this text. Keep the meaning and length similar. Keep any LaTeX/markdown formatting intact.',
      summarize:   'Summarize this text into a tight, high-yield summary using bullet points. Keep key formulas in LaTeX.',
      expand:      'Expand this text with more detail and examples, useful for a JEE/NEET student. Use LaTeX for all math.',
      fix_grammar: 'Fix all spelling and grammar mistakes. Do not change the meaning or formatting.',
      bullets:     'Convert this text into clean, well-organized bullet points. Keep LaTeX for math intact.',
      explain:     'Explain this content simply, as if teaching a confused student. Use analogies and LaTeX for math.'
    };
    const instruction = actionPrompts[action] || actionPrompts.improve;
    const prompt = 'You are a study-notes assistant for a JEE/NEET student.\nTask: ' + instruction + '\nRespond with ONLY the rewritten text — no preamble, no markdown code fences. Use $inline$ and \\[block\\] LaTeX for math.';
    const result = await getReply([{ role: 'user', content }], prompt);
    res.json({ result: result.trim() });
  } catch (e) { console.error('Notes AI assist:', e.message); res.status(500).json({ error: 'AI assist failed. Try again.' }); }
});

// ── SPA FALLBACK ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND running on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OpenRouter=${OPENROUTER_KEYS.length} DeepSeek=${DEEPSEEK_KEY ? 'configured' : 'NOT SET (Pro Deep mode falls back to OpenRouter/Gemini for now)'}`);
});
