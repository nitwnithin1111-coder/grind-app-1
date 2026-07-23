'use strict';
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
const Anthropic      = require('@anthropic-ai/sdk');

const app = express();

/* ────────────────────────────────────────────────────────────
   SECURITY + MIDDLEWARE
──────────────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: false,        // we serve an inline SPA + CDN assets
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname, { maxAge: '1h' }));

/* ────────────────────────────────────────────────────────────
   DATABASE
──────────────────────────────────────────────────────────── */
mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB:', err.message));

/* ── SCHEMAS ── */
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
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep'] },
  examDate:        { type: Date, default: null },
  isPro:           { type: Boolean, default: false },
  planType:        { type: String, default: '', enum: ['', 'weekly', 'monthly', 'promo'] },
  planExpiresAt:   { type: Date, default: null },
  promoRedeemed:   { type: [String], default: [] },
  lastActive:      { type: Date, default: Date.now },
  createdAt:       { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:    { type: String, default: 'New chat' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'], required: true },
    content:   { type: String, default: '' },
    model:     { type: String, default: '' },
    grounding: { type: [String], default: [] },
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
  code:           { type: String, required: true, unique: true, uppercase: true, trim: true },
  bonusDays:      { type: Number, required: true, min: 1 },
  maxRedemptions: { type: Number, default: 0 },
  redeemedCount:  { type: Number, default: 0 },
  expiresAt:      { type: Date, default: null },
  active:         { type: Boolean, default: true },
  note:           { type: String, default: '' },
  createdAt:      { type: Date, default: Date.now }
});

// knowledge_chunks — matches your Atlas collection + vector_index
const knowledgeChunkSchema = new mongoose.Schema({
  text:       { type: String, required: true },
  subject:    { type: String, default: '' },     // Physics | Chemistry | Biology
  examTag:    { type: String, default: '' },      // JEE | NEET | Both
  sourceType: { type: String, default: '' },      // NCERT | HCVerma | ...
  sourceRef:  { type: String, default: '' },      // e.g. "NCERT Physics XI Ch.7"
  embedding:  { type: [Number], default: undefined }
}, { collection: 'knowledge_chunks' });

const User          = mongoose.model('User', userSchema);
const ChatSession   = mongoose.model('ChatSession', sessionSchema);
const Note          = mongoose.model('Note', noteSchema);
const PromoCode     = mongoose.model('PromoCode', promoCodeSchema);
const KnowledgeChunk= mongoose.model('KnowledgeChunk', knowledgeChunkSchema);

/* ────────────────────────────────────────────────────────────
   SESSION + PASSPORT
──────────────────────────────────────────────────────────── */
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET not set — using an insecure default. Set it before deploying.');
}
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'grind-pro-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
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
        name:     profile.displayName || 'Student',
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

/* ────────────────────────────────────────────────────────────
   RATE LIMITING
──────────────────────────────────────────────────────────── */
const rateBuckets = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.user?._id?.toString() || req.ip;
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (bucket.length >= maxRequests) {
      return res.status(429).json({ error: 'You are sending messages faster than GRIND can keep up — wait a few seconds.' });
    }
    bucket.push(now);
    rateBuckets.set(key, bucket);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (!v.some(t => now - t < 5 * 60000)) rateBuckets.delete(k);
}, 5 * 60000);

/* ────────────────────��───────────────────────────────────────
   AI: ANTHROPIC HYBRID ROUTER
   - claude-opus-4-8  → Deep dives / derivations
   - claude-sonnet-5  → fast conceptual doubts
──────────────────────────────────────────────────────────── */
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL_DEEP = process.env.MODEL_DEEP || 'claude-opus-4-8';
const MODEL_FAST = process.env.MODEL_FAST || 'claude-sonnet-5';

// Route: which model + token budget for a given user/depth.
function routeModel(user) {
  const speed = user.isPro ? (user.responseSpeed || 'balanced')
                           : (user.responseSpeed === 'deep' ? 'balanced' : (user.responseSpeed || 'balanced'));
  if (speed === 'deep')     return { model: MODEL_DEEP, maxTokens: 8000, speed };
  if (speed === 'fast')     return { model: MODEL_FAST, maxTokens: 1500, speed };
  return { model: MODEL_FAST, maxTokens: 4000, speed: 'balanced' };
}

/* ── RAG: Voyage embeddings + Atlas $vectorSearch (with keyword fallback) ── */
const VOYAGE_KEY = process.env.VOYAGE_API_KEY || '';
const EMBED_MODEL = process.env.VOYAGE_MODEL || 'voyage-3-large';

async function embedQuery(text) {
  if (!VOYAGE_KEY) return null;
  try {
    const r = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: text, input_type: 'query' })
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const d = await r.json();
    return d.data?.[0]?.embedding || null;
  } catch (e) {
    console.log('❌ embedQuery failed:', e.message);
    return null;
  }
}

// Returns { chunks:[{text,sourceRef,subject}], mode:'vector'|'keyword'|'none' }
async function retrieveContext(query, { userExam = '', k = 5 } = {}) {
  if (!query) return { chunks: [], mode: 'none' };

  const examFilter = userExam && /JEE|NEET/i.test(userExam)
    ? { examTag: { $in: [userExam.includes('NEET') ? 'NEET' : 'JEE', 'Both'] } }
    : {};

  // 1) Semantic vector search
  const vec = await embedQuery(query);
  if (vec) {
    try {
      const pipeline = [{
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: vec,
          numCandidates: 100,
          limit: k,
          ...(Object.keys(examFilter).length ? { filter: examFilter } : {})
        }
      }, {
        $project: { _id: 0, text: 1, sourceRef: 1, subject: 1, score: { $meta: 'vectorSearchScore' } }
      }];
      const chunks = await KnowledgeChunk.aggregate(pipeline);
      if (chunks.length) return { chunks, mode: 'vector' };
    } catch (e) {
      console.log('⚠️  vectorSearch unavailable, falling back to keyword:', e.message);
    }
  }

  // 2) Keyword fallback ($search text index if present, else regex)
  try {
    const chunks = await KnowledgeChunk.aggregate([
      { $search: { index: 'default', text: { query, path: ['text', 'sourceRef'] } } },
      { $limit: k },
      { $project: { _id: 0, text: 1, sourceRef: 1, subject: 1 } }
    ]);
    if (chunks.length) return { chunks, mode: 'keyword' };
  } catch (_) { /* no text index — try regex */ }

  try {
    const rx = new RegExp(query.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const chunks = await KnowledgeChunk.find({ ...examFilter, text: rx })
      .limit(k).select('text sourceRef subject -_id').lean();
    if (chunks.length) return { chunks, mode: 'keyword' };
  } catch (_) {}

  return { chunks: [], mode: 'none' };
}

function formatContextForPrompt(chunks) {
  if (!chunks || !chunks.length) return '';
  const body = chunks.map((c, i) =>
    `[${i + 1}] (${c.sourceRef || c.subject || 'source'})\n${c.text}`).join('\n\n');
  return [
    '========================================================',
    'RETRIEVED KNOWLEDGE (ground your answer in this; cite as [n])',
    '========================================================',
    body,
    ''
  ].join('\n');
}

/* ── SYSTEM PROMPT ── */
function buildSystemPrompt(user, ragBlock = '', model = MODEL_FAST) {
  const name = user?.name?.split(' ')[0] || 'there';
  const isDeep = model === MODEL_DEEP;
  const lines = [
    "You are GRIND — internally codenamed \"AIR-1 Ranker AI\" — an elite AI mentor for Indian JEE and NEET aspirants. You teach concepts well enough to top the exam, and you are a steady, caring presence during one of the most stressful stretches of a student's life.",
    "",
    "STUDENT",
    `Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}`,
    `Coaching: ${user?.coaching || 'self-study'} | Struggling with: ${user?.biggestStruggle || 'not specified'}`,
    "",
    "========================================================",
    "SUBJECT CONSTRAINTS — NON-NEGOTIABLE",
    "========================================================",
    "- BIOLOGY: Use NCERT terminology word-for-word. NEET rewards exact NCERT phrasing; never paraphrase a defined term.",
    "- PHYSICS & MATH: Before stating any final numerical/symbolic answer, perform an explicit DIMENSIONAL ANALYSIS check and show it. If units don't resolve, say so and re-derive.",
    "- CHEMISTRY: Physical → show the working with units; Organic → show the mechanism with arrow-pushing described in words; Inorganic → follow NCERT.",
    "",
    "========================================================",
    "TEACHING SHAPE (for any concept/question)",
    "========================================================",
    "1. Name the concept plainly in one line.",
    "2. Build intuition first — explain like to a smart friend seeing it fresh, before any formula.",
    "3. Walk ONE worked example step-by-step; skip nothing.",
    "4. Flag the trap — the exact way NTA tests this / the reliable student mistake.",
    "5. End with ONE self-try question just above their level, then STOP and let them attempt it. When they answer, check their reasoning (not just the number), correct the actual misstep, then offer the next.",
    "For 'solve this for me' requests: solve fully, but narrate your reasoning like a teacher thinking out loud.",
    "",
    "========================================================",
    "EMOTIONAL SUPPORT",
    "========================================================",
    "- Validate before you fix. Name what they seem to feel in one honest sentence; never diagnose.",
    "- No hollow filler: no \"you got this!\", no \"great question!\".",
    "- Offer one small next step, not a lecture.",
    "- CRISIS: if a message signals self-harm or suicidal thinking, stop all academic talk. Say you're concerned and give: Kiran 1800-599-0019, iCall 9152987821, Tele-MANAS 14416. Encourage reaching out to a real person now.",
    "",
    "========================================================",
    "OFF-TOPIC",
    "========================================================",
    "- If asked a non-academic, non-wellbeing question, answer very briefly and gently steer back to studying.",
    "",
    "========================================================",
    "MATH FORMATTING — MANDATORY",
    "========================================================",
    "- Inline math in $...$ (no space after opening / before closing $).",
    "- Standalone equations in \\[...\\] on their own line, blank line before and after.",
    "- Never write formulas/fractions/exponents in plain text. Never leave a delimiter unclosed.",
    "",
    "========================================================",
    "GROUNDING & STEP TOGGLE",
    "========================================================",
    "- When RETRIEVED KNOWLEDGE is provided, ground your answer in it and cite as [n]. If it doesn't cover the question, rely on standard texts (HC Verma, Irodov, DC Pandey; MS Chouhan, N Awasthi; NCERT for Bio) and say so.",
    "- Wrap detailed derivation steps between the markers <details> and </details> so the UI can make them collapsible. Put the intuition/answer OUTSIDE the details block.",
    isDeep
      ? "- You are running as GRIND Deep Reasoning (flagship). Take the space to reason through edge cases, alternate methods, and one adjacent worked example."
      : "- Keep it tight and correct; expand only where the concept genuinely needs it.",
    "",
    "HARD RULES",
    "- Only authenticated students use you; never mention a guest/trial mode.",
    "- Mirror the student's language (Hinglish stays Hinglish). Never translate unless asked.",
    "- Paragraphs under 3 sentences; use steps/line breaks over walls of text.",
    ragBlock
  ];
  return lines.join('\n');
}

// Convert chat history (+ optional image) into Anthropic message format
function toAnthropicMessages(messages, imageBase64) {
  const msgs = messages.slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: m.content || '' }]
  }));
  if (imageBase64 && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user') {
      last.content.unshift({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
      });
    }
  }
  return msgs;
}

/* ────────────────────────────────────────────────────────────
   HEALTH / KEEPALIVE
──────────────────────────────────────────────────────────── */
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
}

/* ────────────────────────────────────────────────────────────
   AUTH ROUTES
──────────────────────────────────────────────────────────── */
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

/* ────────────────────────────────────────────────────────────
   USER ROUTES
──────────────────────────────────────────────────────────── */
app.get('/api/me', requireAuth, async (req, res) => {
  const u = await enforcePlanExpiry(req.user);
  res.json({ user: {
    id: u._id, name: u.name, email: u.email, photo: u.photo,
    isOnboarded: u.isOnboarded, exam: u.exam, class: u.class,
    coaching: u.coaching, biggestStruggle: u.biggestStruggle,
    responseSpeed: u.responseSpeed || 'balanced', examDate: u.examDate,
    isPro: u.isPro, planType: u.planType, planExpiresAt: u.planExpiresAt,
    aiConfigured: !!anthropic, ragConfigured: !!VOYAGE_KEY
  }});
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle } = req.body;
    if (!exam || !cls) return res.status(400).json({ error: 'Exam and class are required.' });
    await User.findByIdAndUpdate(req.user._id, {
      exam, class: cls, coaching: coaching || '', biggestStruggle: biggestStruggle || '', isOnboarded: true
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
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
  } catch { res.status(500).json({ error: 'Could not save settings.' }); }
});

/* ── PLAN / PAYWALL ── */
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
  } catch { res.status(500).json({ error: 'Could not start upgrade.' }); }
});

app.post('/api/user/redeem-promo', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'Enter a code.' });
    const applied = await applyPromoCode(req.user, code);
    if (!applied.ok) return res.status(400).json({ error: applied.error });
    const user = await User.findById(req.user._id);
    const base = user.isPro && user.planExpiresAt && new Date(user.planExpiresAt) > new Date()
      ? new Date(user.planExpiresAt) : new Date();
    user.isPro = true;
    user.planType = user.planType || 'promo';
    user.planExpiresAt = new Date(base.getTime() + applied.bonusDays * 86400000);
    await user.save();
    res.json({ success: true, bonusDays: applied.bonusDays, planExpiresAt: user.planExpiresAt });
  } catch { res.status(500).json({ error: 'Could not redeem code.' }); }
});

async function applyPromoCode(reqUser, rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (reqUser.promoRedeemed?.includes(code)) return { ok: false, error: 'You have already used this code.' };
  const promo = await PromoCode.findOne({ code });
  if (!promo || !promo.active) return { ok: false, error: 'Invalid or inactive promo code.' };
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return { ok: false, error: 'This promo code has expired.' };
  if (promo.maxRedemptions > 0 && promo.redeemedCount >= promo.maxRedemptions) return { ok: false, error: 'This promo code has been fully redeemed.' };
  const filter = { code, active: true, ...(promo.maxRedemptions > 0 ? { redeemedCount: { $lt: promo.maxRedemptions } } : {}) };
  const updated = await PromoCode.findOneAndUpdate(filter, { $inc: { redeemedCount: 1 } }, { new: true });
  if (!updated) return { ok: false, error: 'This promo code just ran out.' };
  await User.findByIdAndUpdate(reqUser._id, { $addToSet: { promoRedeemed: code } });
  return { ok: true, bonusDays: promo.bonusDays, code };
}

/* ── ADMIN: promo + knowledge ingestion ── */
const requireAdmin = (req, res, next) => {
  if (process.env.ADMIN_KEY && req.query.key === process.env.ADMIN_KEY) return next();
  res.status(403).json({ error: 'Forbidden' });
};
app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try {
    const { code, bonusDays, maxRedemptions, expiresAt, note } = req.body;
    if (!code || !bonusDays) return res.status(400).json({ error: 'code and bonusDays are required.' });
    const promo = await PromoCode.create({
      code: code.trim().toUpperCase(), bonusDays,
      maxRedemptions: maxRedemptions || 0,
      expiresAt: expiresAt ? new Date(expiresAt) : null, note: note || ''
    });
    res.json({ promo });
  } catch (e) { res.status(500).json({ error: e.code === 11000 ? 'That code already exists.' : 'Could not create.' }); }
});
app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try { res.json({ promoCodes: await PromoCode.find().sort({ createdAt: -1 }) }); }
  catch { res.status(500).json({ error: 'Could not load.' }); }
});

// Ingest a knowledge chunk WITH its embedding (call this to populate your RAG store)
app.post('/api/admin/knowledge', requireAdmin, async (req, res) => {
  try {
    const { text, subject, examTag, sourceType, sourceRef } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required.' });
    const embedding = await embedDocument(text);
    const doc = await KnowledgeChunk.create({ text, subject, examTag, sourceType, sourceRef, embedding: embedding || undefined });
    res.json({ ok: true, id: doc._id, embedded: !!embedding });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function embedDocument(text) {
  if (!VOYAGE_KEY) return null;
  try {
    const r = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VOYAGE_KEY}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: text, input_type: 'document' })
    });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()).data?.[0]?.embedding || null;
  } catch (e) { console.log('❌ embedDocument:', e.message); return null; }
}

/* ────────────────────────────────────────────────────────────
   CHAT — SSE STREAMING with live "thinking steps" + RAG
──────────────────────────────────────────────────────────── */
app.post('/api/chat/stream', requireAuth, rateLimit(20, 60000), async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Invalid request.' });

  const user = await enforcePlanExpiry(req.user);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);

  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const { model, maxTokens, speed } = routeModel(user);

    // ── Live reasoning steps (real pipeline milestones) ──
    send('step', { text: 'Reading your question…' });
    send('step', { text: speed === 'deep'
      ? `Routing to GRIND Deep Reasoning (${model})…`
      : `Routing to GRIND (${model})…` });

    send('step', { text: 'Searching the JEE/NEET knowledge base…' });
    const { chunks, mode } = lastUser
      ? await retrieveContext(lastUser.content, { userExam: user.exam, k: 5 })
      : { chunks: [], mode: 'none' };

    if (chunks.length) {
      send('step', { text: `Retrieved ${chunks.length} source${chunks.length > 1 ? 's' : ''} (${mode})…` });
    } else {
      send('step', { text: 'No indexed match — using standard texts…' });
    }
    send('step', { text: 'Verifying units & drafting the solution…' });

    const ragBlock = formatContextForPrompt(chunks);
    const systemPrompt = buildSystemPrompt(user, ragBlock, model);
    const aMessages = toAnthropicMessages(messages, imageBase64);

    let full = '';

    if (!anthropic) {
      // No API key configured — fail gracefully but visibly.
      send('error', { error: 'AI is not configured yet (missing ANTHROPIC_API_KEY).' });
      return res.end();
    }

    const stream = anthropic.messages.stream({
      model, max_tokens: maxTokens, temperature: 0.4,
      system: systemPrompt, messages: aMessages
    }, { signal: abort.signal });

    stream.on('text', (delta) => { full += delta; send('chunk', { text: delta }); });

    await stream.finalMessage();

    // Persist
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        const userMsg = messages[messages.length - 1];
        const existing = await ChatSession.findOne({ _id: sessionId, userId: user._id }).select('messages').lean();
        const title = existing && existing.messages.length === 0
          ? (userMsg.content || 'Image question').slice(0, 50) : undefined;
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          { $push: { messages: { $each: [
              { role: 'user', content: userMsg.content },
              { role: 'assistant', content: full, model, grounding: chunks.map(c => c.sourceRef).filter(Boolean) }
            ] } },
            $set: { updatedAt: new Date(), ...(title ? { title } : {}) } }
        );
      } catch (e) { console.error('Session save:', e.message); }
    }

    send('done', {
      reply: full,
      model,
      groundedOn: chunks.map(c => c.sourceRef).filter(Boolean)
    });
    res.end();
  } catch (err) {
    if (err.name === 'AbortError') return res.end();
    console.error('Stream error:', err.message);
    send('error', { error: 'GRIND is taking a short break. Please try again.' });
    res.end();
  }
});

/* ────────────────────────────────────────────────────────────
   SESSIONS
──────────────────────────────────────────────────────────── */
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt').sort({ updatedAt: -1 }).limit(50);
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Could not load chats.' }); }
});
app.get('/api/sessions/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ sessions: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sessions = await ChatSession.find({ userId: req.user._id, $or: [{ title: rx }, { 'messages.content': rx }] })
      .select('title updatedAt').sort({ updatedAt: -1 }).limit(20).lean();
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Search failed.' }); }
});
app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    res.json({ session: s });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});
app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.create({ userId: req.user._id, title: 'New chat', messages: [] });
    res.json({ sessionId: s._id });
  } catch { res.status(500).json({ error: 'Could not create chat.' }); }
});
app.post('/api/sessions/:id/truncate', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id.' });
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    s.messages = s.messages.slice(0, Math.max(0, req.body.keepCount || 0));
    s.updatedAt = new Date();
    await s.save();
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not update chat.' }); }
});
app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try { await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Could not delete.' }); }
});

/* ────────────────────────────────────────────────────────────
   NOTES
──────────────────────────────────────────────────────────── */
app.get('/api/notes', requireAuth, async (req, res) => {
  try { res.json({ notes: await Note.find({ userId: req.user._id }).sort({ updatedAt: -1 }).lean() }); }
  catch { res.status(500).json({ error: 'Could not load notes.' }); }
});
app.post('/api/notes', requireAuth, async (req, res) => {
  try {
    const note = await Note.create({ userId: req.user._id, title: req.body.title || 'Untitled', content: req.body.content || '' });
    res.json({ note });
  } catch { res.status(500).json({ error: 'Could not create note.' }); }
});
app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    const note = await Note.findOneAndUpdate({ _id: req.params.id, userId: req.user._id },
      { title, content, updatedAt: new Date() }, { new: true });
    if (!note) return res.status(404).json({ error: 'Not found.' });
    res.json({ note });
  } catch { res.status(500).json({ error: 'Could not update.' }); }
});
app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try { await Note.deleteOne({ _id: req.params.id, userId: req.user._id }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Could not delete.' }); }
});
app.post('/api/notes/ai-assist', requireAuth, rateLimit(15, 60000), async (req, res) => {
  try {
    if (!anthropic) return res.status(503).json({ error: 'AI not configured.' });
    const { content, action } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'No content provided.' });
    const map = {
      improve:     'Improve clarity, flow and grammar. Keep meaning and length similar. Keep LaTeX/markdown intact.',
      summarize:   'Summarize into a tight, high-yield bullet summary. Keep key formulas in LaTeX.',
      expand:      'Expand with more detail and JEE/NEET-useful examples. Use LaTeX for all math.',
      fix_grammar: 'Fix spelling and grammar only. Do not change meaning or formatting.',
      bullets:     'Convert into clean, organized bullet points. Keep LaTeX intact.',
      explain:     'Explain simply as if teaching a confused student. Use analogies and LaTeX.'
    };
    const instruction = map[action] || map.improve;
    const system = `You are a study-notes assistant for a JEE/NEET student.\nTask: ${instruction}\nRespond with ONLY the rewritten text — no preamble, no code fences. Use $inline$ and \\[block\\] LaTeX.`;
    const msg = await anthropic.messages.create({
      model: MODEL_FAST, max_tokens: 3000, temperature: 0.4,
      system, messages: [{ role: 'user', content }]
    });
    res.json({ result: (msg.content?.[0]?.text || '').trim() });
  } catch (e) { console.error('Notes AI:', e.message); res.status(500).json({ error: 'AI assist failed.' }); }
});

/* ── SPA FALLBACK ── */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ── START ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND Pro on port ${PORT}`);
  console.log(`🤖 Anthropic=${anthropic ? 'ON' : 'OFF'} | Deep=${MODEL_DEEP} | Fast=${MODEL_FAST} | RAG(Voyage)=${VOYAGE_KEY ? 'ON' : 'OFF'}`);
});
