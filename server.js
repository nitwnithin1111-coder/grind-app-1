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
  createdAt:       { type: Date, default: Date.now },
  // NEW: Token usage tracking for Perplexity logic
  tokenUsage:      { type: Number, default: 0 }
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
//  SESSION + PASSPORT
// ══════════════════════════════════════════════════════════
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️ SESSION_SECRET not set. Using insecure default.');
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

// ══════════════════════════════════════════════════════════
//  KNOWLEDGE BASE & RAG UTILS
// ══════════════════════════════════════════════════════════
const KNOWLEDGE_BASE = [
    { id: 'phy-rot-1', subject: 'Physics', topic: 'Rotational Dynamics', tags: ['rotation','torque','moment of inertia','angular','kinetic energy','rolling'],
      text: 'Moment of inertia I = Σ m_i r_i². Rotational KE = ½ I ω². Torque τ = I α = r × F. For rolling without slipping v = ωR, and total KE = ½ m v² + ½ I ω². For a solid sphere I = (2/5) m R², solid cylinder (1/2) m R², hollow shell (2/3) m R², ring m R².',
      source: 'NCERT Physics Class 11, Ch. 7 — Systems of Particles & Rotational Motion' },
    { id: 'phy-kin-1', subject: 'Physics', topic: 'Kinematics', tags: ['velocity','acceleration','motion','projectile','equations of motion'],
      text: 'Equations of uniformly accelerated motion: v = u + at; s = ut + ½at²; v² = u² + 2as. Projectile: range R = u²sin2θ/g, max height H = u²sin²θ/2g, time of flight T = 2u sinθ/g.',
      source: 'NCERT Physics Class 11, Ch. 3 — Motion in a Straight Line' },
    { id: 'phy-thermo-1', subject: 'Physics', topic: 'Thermodynamics', tags: ['thermodynamics','heat','entropy','carnot','first law','internal energy'],
      text: 'First law: ΔU = Q − W. For isothermal: ΔU = 0, W = nRT ln(V₂/V₁). For adiabatic: Q = 0, PV^γ = const. Carnot efficiency η = 1 − T_cold/T_hot.',
      source: 'NCERT Physics Class 11, Ch. 12 — Thermodynamics' },
    { id: 'chem-org-1', subject: 'Chemistry', topic: 'Organic Reaction Mechanisms', tags: ['organic','mechanism','sn1','sn2','nucleophile','electrophile','carbocation'],
      text: 'SN1: two-step, rate = k[substrate], via carbocation, favoured by 3° carbon and polar protic solvents, racemisation. SN2: one-step, rate = k[substrate][Nu], backside attack, inversion (Walden), favoured by 1° carbon and polar aprotic solvents. Carbocation stability: 3° > 2° > 1° > methyl.',
      source: 'NCERT Chemistry Class 12, Ch. 10 — Haloalkanes & Haloarenes' },
    { id: 'bio-cell-1', subject: 'Biology', topic: 'Cell — The Unit of Life', tags: ['cell','organelle','mitochondria','ribosome','nucleus','prokaryote','eukaryote'],
      text: 'Prokaryotic cells lack a membrane-bound nucleus and organelles. Mitochondria are the site of aerobic respiration (powerhouse of the cell). Ribosomes (70S in prokaryotes, 80S in eukaryotes) are the site of protein synthesis.',
      source: 'NCERT Biology Class 11, Ch. 8 — Cell: The Unit of Life' }
];

const STOP_WORDS = new Set(['the','a','an','is','are','of','to','in','and','or','for','on','how','what','why','do','does','i','my','me','can','with','this','that','explain','solve','question','doubt']);

function retrieveContext(query, { userExam = '', k = 4 } = {}) {
  if (!query) return [];
  const words = String(query).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const scored = KNOWLEDGE_BASE.map(doc => {
    const haystack = (doc.topic + ' ' + doc.tags.join(' ') + ' ' + doc.text).toLowerCase();
    let score = 0;
    for (const w of words) {
      if (doc.tags.some(t => t.includes(w) || w.includes(t))) score += 3;
      else if (haystack.includes(w)) score += 1;
    }
    if (/neet/i.test(userExam) && doc.subject === 'Biology') score += 1;
    if (/jee/i.test(userExam) && doc.subject !== 'Biology') score += 1;
    return { doc, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  return scored.map(s => ({ topic: s.doc.topic, subject: s.doc.subject, text: s.doc.text, sourceRef: s.doc.source }));
}

function formatContextForPrompt(chunks) {
  if (!chunks || !chunks.length) return '';
  const body = chunks.map((c, i) => `[${i + 1}] (${c.subject} · ${c.topic}) — ${c.text}\n    ↳ Source: ${c.sourceRef}`).join('\n');
  return ['========================================================', 'RETRIEVED KNOWLEDGE (internal NCERT index — cite when used)', '========================================================', body, ''].join('\n');
}

// ══════════════════════════════════════════════════════════
//  AI PROVIDERS + PERPLEXITY LOGIC
// ══════════════════════════════════════════════════════════
const PERPLEXITY_KEY  = process.env.PERPLEXITY_API_KEY || '';
const GROQ_KEYS       = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS     = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const DEEPSEEK_KEY    = process.env.DEEPSEEK_API_KEY || '';
const TOKEN_LIMIT_PERPLEXITY = 50000;

let gIdx = 0, grIdx = 0, orIdx = 0;

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
      } catch (e) {}
    }
  }
  if (fullText) onLine(fullText);
}

async function callPerplexityStreamLines(messages, prompt, onLine, abortSignal) {
  if (!PERPLEXITY_KEY) throw new Error('Perplexity Key missing');
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PERPLEXITY_KEY}` },
    signal: abortSignal,
    body: JSON.stringify({
      model: 'sonar', // Using latest Sonar as requested
      messages: [{ role: 'system', content: prompt }, ...messages],
      stream: true
    })
  });
  if (!response.ok) throw new Error(`${response.status} - ${await response.text()}`);
  await consumeOpenAIStreamLines(response, onLine);
}

async function callORStreamLines(messages, prompt, onLine, abortSignal, reasoning = false) {
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = reasoning ? 'deepseek/deepseek-r1:free' : 'meta-llama/llama-3.3-70b-instruct:free';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: abortSignal,
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  await consumeOpenAIStreamLines(response, onLine);
}

async function callGemini(messages, prompt) {
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) })
  });
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// ── HYBRID ROUTER WITH TOKEN LOGIC ────────────────────────
async function routeReplyStream({ user, messages, prompt, onLine, abortSignal, deep }) {
  // RULE: Every user gets Perplexity first until 50k tokens
  if (PERPLEXITY_KEY && user.tokenUsage < TOKEN_LIMIT_PERPLEXITY) {
    try {
      console.log(`[ROUTER] Using Perplexity (Usage: ${user.tokenUsage} tokens)`);
      await callPerplexityStreamLines(messages, prompt, onLine, abortSignal);
      return { model: 'perplexity-sonar' };
    } catch (e) {
      console.error('Perplexity failed, falling back...', e.message);
    }
  }

  // FALLBACK: Existing Logic
  if (deep && DEEPSEEK_KEY) {
    try {
      await callORStreamLines(messages, prompt, onLine, abortSignal, true);
      return { model: 'deepseek-r1' };
    } catch (e) { console.error('DeepSeek failed'); }
  }

  try {
    await callORStreamLines(messages, prompt, onLine, abortSignal, false);
    return { model: 'openrouter-fast' };
  } catch (e) {
    const text = await callGemini(messages, prompt);
    const lines = text.split('\n');
    for (const l of lines) { onLine(l + '\n'); await new Promise(r => setTimeout(r, 20)); }
    return { model: 'gemini-fallback' };
  }
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPT BUILDER
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, ragBlock = '', isDeep = false) {
  const name = user.name.split(' ')[0];
  const depth = isDeep ? 'DEEP — unskipped derivations and edge cases.' : 'Balanced — concise but conceptually complete.';
  
  return `You are GRIND (AIR-1 Ranker AI), an elite IIT/NEET mentor.
User: ${name} | Exam: ${user.exam} | Struggle: ${user.biggestStruggle}
Mode: ${depth}

CONSTRAINTS:
1. BIOLOGY: Strictly NCERT terminology.
2. PHYSICS/MATH: Dimensional analysis check on every final answer.
3. SOCRATIC: Don't give full answers immediately. Lead the student to the first logical step.
4. TONE: Elder brotherly ("Bhaiya"), warm, using Hinglish phrases (e.g. "Suno", "Samjhe?").

MATH: Use $inline$ and \\[ block \\] for LaTeX.

${ragBlock}
End of context. Answer appropriately.`;
}

// ══════════════════════════════════════════════════════════
//  CHAT STREAM ROUTE
// ══════════════════════════════════════════════════════════
app.post('/api/chat/stream', requireAuth, rateLimit(20, 60000), async (req, res) => {
  const { messages, sessionId } = req.body;
  const user = await enforcePlanExpiry(req.user);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const q = lastUserMsg?.content || '';
    
    send('thinking', { step: 'Retrieving NCERT references...' });
    const chunks = q ? retrieveContext(q, { userExam: user.exam }) : [];
    const useDeep = user.isPro && user.responseSpeed === 'deep';
    
    const ragBlock = formatContextForPrompt(chunks);
    const prompt = buildSystemPrompt(user, ragBlock, useDeep);

    let fullReply = '';
    const onLine = (line) => {
      if (!fullReply) send('answer_start', {});
      fullReply += line;
      send('chunk', { text: line });
    };

    const { model } = await routeReplyStream({
      user, messages: messages.slice(-10), prompt, onLine, 
      abortSignal: abortController.signal, deep: useDeep
    });

    // ── TOKEN CALCULATION & UPDATE ──
    // Heuristic: 1 token ≈ 4 characters
    const estimatedTokens = Math.ceil((prompt.length + fullReply.length + JSON.stringify(messages).length) / 4);
    await User.findByIdAndUpdate(user._id, { $inc: { tokenUsage: estimatedTokens } });

    // Persist session
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      await ChatSession.updateOne(
        { _id: sessionId, userId: user._id },
        { 
          $push: { messages: { $each: [
            { role: 'user', content: q },
            { role: 'assistant', content: fullReply, model, grounded: chunks.map(c => c.sourceRef) }
          ]}},
          $set: { updatedAt: new Date() }
        }
      );
    }

    send('done', { model, tokensUsed: estimatedTokens });
    res.end();
  } catch (err) {
    console.error('Stream Error:', err.message);
    send('error', { error: 'GRIND encountered a glitch. Please retry.' });
    res.end();
  }
});

// ══════════════════════════════════════════════════════════
//  ADDITIONAL ROUTES (Summarized)
// ══════════════════════════════════════════════════════════

app.get('/api/me', requireAuth, async (req, res) => {
  const u = await enforcePlanExpiry(req.user);
  res.json({ user: u });
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  const s = await ChatSession.create({ userId: req.user._id, title: 'New chat' });
  res.json({ sessionId: s._id });
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  const list = await ChatSession.find({ userId: req.user._id }).sort({ updatedAt: -1 }).limit(20);
  res.json({ sessions: list });
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
  res.json({ session: s });
});

// SPA Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND AI v2 running on port ${PORT}`);
  console.log(`🚀 Perplexity: ${PERPLEXITY_KEY ? 'Active' : 'Missing'}`);
});
