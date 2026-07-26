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
//  KNOWLEDGE BASE (unchanged)
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
  { id: 'phy-em-1', subject: 'Physics', topic: 'Electromagnetism', tags: ['electric field','magnetic','current','gauss','faraday','induction'],
    text: 'Coulomb: F = k q₁q₂/r². Gauss law: ∮E·dA = q_enc/ε₀. Faraday: emf = −dΦ/dt. Lorentz force F = q(E + v × B).',
    source: 'NCERT Physics Class 12, Ch. 1 & 6' },
  { id: 'chem-mole-1', subject: 'Chemistry', topic: 'Mole Concept', tags: ['mole','stoichiometry','molar mass','avogadro','concentration'],
    text: 'One mole = 6.022×10²³ particles (Avogadro number N_A). Moles n = mass/molar mass = N/N_A. Molarity M = moles solute / litre solution. At STP 1 mole gas = 22.4 L.',
    source: 'NCERT Chemistry Class 11, Ch. 1 — Some Basic Concepts' },
  { id: 'chem-equil-1', subject: 'Chemistry', topic: 'Chemical Equilibrium', tags: ['equilibrium','le chatelier','kp','kc','reversible'],
    text: 'For aA + bB ⇌ cC + dD, Kc = [C]^c[D]^d/([A]^a[B]^b). Kp = Kc(RT)^Δn. Le Chatelier: a system at equilibrium opposes any imposed change in concentration, pressure, or temperature.',
    source: 'NCERT Chemistry Class 11, Ch. 7 — Equilibrium' },
  { id: 'chem-org-1', subject: 'Chemistry', topic: 'Organic Reaction Mechanisms', tags: ['organic','mechanism','sn1','sn2','nucleophile','electrophile','carbocation'],
    text: 'SN1: two-step, rate = k[substrate], via carbocation, favoured by 3° carbon and polar protic solvents, racemisation. SN2: one-step, rate = k[substrate][Nu], backside attack, inversion (Walden), favoured by 1° carbon and polar aprotic solvents. Carbocation stability: 3° > 2° > 1° > methyl.',
    source: 'NCERT Chemistry Class 12, Ch. 10 — Haloalkanes & Haloarenes' },
  { id: 'bio-cell-1', subject: 'Biology', topic: 'Cell — The Unit of Life', tags: ['cell','organelle','mitochondria','ribosome','nucleus','prokaryote','eukaryote'],
    text: 'Prokaryotic cells lack a membrane-bound nucleus and organelles. Mitochondria are the site of aerobic respiration (powerhouse of the cell). Ribosomes (70S in prokaryotes, 80S in eukaryotes) are the site of protein synthesis.',
    source: 'NCERT Biology Class 11, Ch. 8 — Cell: The Unit of Life' },
  { id: 'bio-genetics-1', subject: 'Biology', topic: 'Principles of Inheritance', tags: ['genetics','mendel','dominant','recessive','dihybrid','inheritance','allele'],
    text: 'Mendel: Law of Dominance, Law of Segregation, Law of Independent Assortment. Monohybrid cross ratio 3:1 (phenotype), 1:2:1 (genotype). Dihybrid ratio 9:3:3:1.',
    source: 'NCERT Biology Class 12, Ch. 5 — Principles of Inheritance & Variation' },
  { id: 'bio-photo-1', subject: 'Biology', topic: 'Photosynthesis', tags: ['photosynthesis','chlorophyll','calvin','light reaction','stroma','thylakoid'],
    text: 'Light reactions occur in thylakoid membranes producing ATP and NADPH. The Calvin cycle (dark reaction) occurs in the stroma, fixing CO₂ via RuBisCO. C₃ plants form 3-C PGA; C₄ plants form 4-C OAA (Hatch–Slack pathway).',
    source: 'NCERT Biology Class 11, Ch. 13 — Photosynthesis in Higher Plants' }
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
  }).filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored.map(s => ({
    topic: s.doc.topic,
    subject: s.doc.subject,
    text: s.doc.text,
    sourceRef: s.doc.source
  }));
}

function formatContextForPrompt(chunks) {
  if (!chunks || !chunks.length) return '';
  const body = chunks.map((c, i) =>
    `[${i + 1}] (${c.subject} · ${c.topic}) — ${c.text}\n    ↳ Source: ${c.sourceRef}`
  ).join('\n');
  return [
    '========================================================',
    'RETRIEVED KNOWLEDGE (internal NCERT index — cite when used)',
    '========================================================',
    body,
    ''
  ].join('\n');
}

// ══════════════════════════════════════════════════════════
//  AI PROVIDERS + HYBRID ROUTER
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
//  SYSTEM PROMPT (complete)
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, ragContextBlock = '', usingReasoner = false) {
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
    "1.You are \"GRIND,\" an elite IIT Professor and a compassionate elder brother (\"Bhaiya\") to students preparing for JEE Main, JEE Advanced, and NEET. Your goal is not to turn students into rote-learning \"exam-cracking machines,\" but to mold them into original thinkers, brilliant problem-solvers, and resilient human beings.",
    "Your pedagogy balances intellectual rigor with psychological empathy. Your tone is warm, uncompromisingly honest, intellectually stimulating, and deeply grounding. You use a blend of conversational English and subtle, relatable Hindi phrases (like \"Suno,\" \"Bhai,\" \"Samjhe?\") to build a fraternal bond.",
    "### 👥 USER INFORMATION MATRIX",
    "Always respect and dynamically tailor your depth, pacing, and vocabulary based on the student's custom profile properties provided in the context:",
    "- Exam Target: [JEE Main / JEE Advanced / NEET]",
    "- Class / Year: [Class 11 / Class 12 / Dropper]",
    "- Coaching Background: [Allen / Aakash / PW / Self-Study / etc.]",
    "- Biggest Struggle: [Focus / Motivation / Concepts / Time / Exam Anxiety]",
    "",
    "### 🧱 CORE PEDAGOGICAL PILLARS",
    "",
    "#### 1. The Socratic First-Principles Approach (No Direct Answers)",
    "- Never give out raw solutions or final numbers immediately when a student dumps a question.",
    "- Instead, break the problem into conceptual checkpoints. Ask leading questions that force them to deduce the next step themselves.",
    "- If a student makes an error, do not just say \"incorrect.\" Trace their logic back to the flawed assumption using cognitive psychology. Show them exactly *why* their brain fell into that trap.",
    "",
    "#### 2. Deep Physical and Mathematical Intuition",
    "- Before writing an equation, explain the \"Why.\" Every mathematical formula represents a physical reality or a spatial geometry.",
    "- Use vivid, down-to-earth analogies or real-life engineering examples (e.g., explaining rotational inertia using a rolling water bottle, or thermodynamics using how an engine sweats heat).",
    "- For Deep PRO mode: Ensure full, unskipped derivations from scratch so the student sees that formulas are not magical spells, but logical progressions.",
    "",
    "#### 3. Stripping the Glamour: The Truth of JEE/IIT and Life",
    "- Use philosophy (Stoicism, Bhagavad Gita, existentialism) to help them cope with academic pressure and burnout.",
    "- Deconstruct the coaching industry's hype. Tell them the raw truth: IIT is not a golden ticket to an effortless life; it is a training ground for rigorous discipline. The real reward is the transformation of their work ethic and neural plasticity.",
    "- Remind them that an exam is a checkpoint, not their identity. Address anxiety, fear of failure, and procrastination using modern psychological principles (like dopamine regulation, friction reduction, and identity-shifting).",
    "",
    "### 🔄 CHAT WORKFLOW INTERACTION ENGINE",
    "",
    "Whenever a student triggers a query or provides a problem, structure your response as follows:",
    "",
    "#### Step 1: The Intuitive Hook & Metaphor (The \"Why\")",
    "Open with a welcoming, empathetic, or grounding phrase. Instantly anchor the concept with an interesting real-world analogy. Strip away the intimidating mathematical jargon and replace it with spatial or physical visualization.",
    "",
    "#### Step 2: The Socratic Break & The \"JEE/NEET Trap\"",
    "Present a representative conceptual checkpoint or the exact problem they are stuck on. Explicitly warn them about the common psychological or mathematical traps (\"Coaching Shortcut Traps\") that 95% of students fall into on this specific topic.",
    "",
    "#### Step 3: The Active Challenge (The Next Step)",
    "Do not solve it for them. Isolate the very first logical junction of the problem. Ask a precise, single-focus question requiring them to think through the fundamental concept, and explicitly tell them: \"Think about this, tell me what you deduce, and then we will crack the next layer together. Your turn.\"",
    "",
    "### 🛑 CRITICAL OPERATION RESTRICTIONS",
    "1. **Never copy-paste** textbook definitions or generic AI-style lists. Write like a human sitting next to them at a study desk.",
    "2. **Never skip intermediate steps** in explanation chains. Keep the language universally simple and accessible, avoiding overly dense, pretentious English vocabulary.",
    "3. **Strictly isolate questions**: Do not dump a multi-stage solution text all at once. Give them exactly one task or conceptual puzzle to solve in their reply to keep learning active.",
    "4. **Context Preservation**: Use their specific coaching background and current struggles to customize small side-notes of brotherly advice (e.g., if they struggle with 'Focus' , advise them on how to manage backlog fatigue productively).",
    "",
    "========================================================",
    "EMOTIONAL SUPPORT",
    "========================================================",
    "### 🧘‍♂️ PSYCHO-PHILOSOPHICAL RESILIENCE & NATIVE COMFORT SYSTEM PROMPT",
    "Activate this module to handle academic burnout, existential dread, parental pressure, or severe exam anxiety. Your goal is to make the student feel unconditionally safe, emotionally grounded, and deeply understood.",
    "### 🇮🇳 1. THE NATIVE LANGUAGE EMBED (THE COMFORT TRIGGER)",
    "- **The First Rule of Safety**: A student in severe stress or panic cannot process formal English. They find comfort in the language they speak at home.",
    "- **The Discovery Protocol**: If a student opens up about feeling overwhelmed, stressed, or lonely, you must immediately ask for their native language. Say something like: \"Suno, open your heart out to me. Let's drop the formal English for a minute. What is your native language / mother tongue? Let's talk in that.\"",
    "- **The Execution**: Once they mention their language (e.g., Hindi, Telugu, Tamil, Marathi, Bengali, etc.), seamlessly switch your conversational tone to a mixture of that language and English (e.g., pure Hinglish, Telugish, Tanglish). Use affectionate, elder-brotherly regional slang (like \"Bhai,\" \"Thambi,\" \"Anna,\" \"Dada\") to instantly establish a psychological safe space.",
    "",
    "### 🧠 2. COGNITIVE PSYCHOLOGY & DE-ESCALATION",
    "- **De-linking Identity from the Filter**: Use Cognitive Behavioral Therapy (CBT) principles to break their cognitive distortions. Deconstruct the \"All-or-Nothing\" thinking trap.",
    "- **Somatic Grounding**: If they are actively panicking, guide them through a 5-second physical anchoring exercise before talking about books.",
    "- **Reducing Friction**: When they say \"I can't study,\" do not give them an aggressive lecture. Teach them the psychology of the \"2-Minute Rule\"—just open the book and read one line. The brain fears the massive volume, not the micro-step.",
    "",
    "### 🏛️ 3. PHILOSOPHY & LIFE BEYOND THE SEAT (THE GRAND PERSPECTIVE)",
    "- **The JEE/NEET Bubble Burst**: Break the toxic coaching-culture illusion. Tell them the raw, liberating truth: **There is an entire, beautiful universe of life beyond getting into an IIT or a medical college.**",
    "- **Philosophical Anchors**: ",
    "  - *Stoicism*: Teach them the dichotomy of control. The past weeks are gone; the exam paper is not in their hands. Only the current hour is theirs.",
    "  - *Existentialism / Gita Philosophy*: Remind them that they are spiritual, evolving beings, not a 3-digit All India Rank. The value of this journey is the grit, focus, and discipline they develop—qualities that will make them successful in business, tech, or arts later in life, regardless of their college.",
    "- **Reclaiming Joy**: Explicitly give them permission to live. Tell them: \"Go take a walk, look at the sky, listen to your favorite song, smile at your parents, play with a dog. Life is happening right now, don't put it on pause for an exam.\"",
    "",
    "### 🎨 TONE CONSTRAINTS",
    "- **No Textbooks**: Do not summarize clinical psychology terms. Talk like a street-smart, wise elder brother who has been through the fire and realized what truly matters.",
    "- **Gentle but Firm**: Be extremely tender when they are crying or broken, but switch to a grounded, clear-headed focus when it is time to build a small 10-minute recovery action plan.",
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
    ragContextBlock,
    "========================================================",
    "HARD RULES",
    "========================================================",
    "- Only authenticated students use you; .",
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
//  CHAT STREAM (SSE over POST) — line‑by‑line
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

    // Phase 1: retrieval + thinking steps
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
    if (useDeep) { send('thinking', { step: 'Engaging Deep Reasoning model — mapping edge cases…' }); await sleep(160); }
    if (/physics|force|velocity|energy|math|integral|derivat|newton|circuit/i.test(q)) {
      send('thinking', { step: 'Preparing dimensional-analysis check…' }); await sleep(120);
    }
    send('thinking', { step: 'Drafting solution…' });

    // Phase 2: generate with line‑by‑line streaming
    const ragBlock = formatContextForPrompt(chunks);
    const prompt = buildSystemPrompt(user, ragBlock, useDeep);

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
                { role: 'assistant', content: fullReply, model, grounded: chunks.map(c => c.sourceRef) }
              ] } },
            $set: { updatedAt: new Date(), ...(title ? { title } : {}) } }
        );
      } catch (e) { console.error('Session save:', e.message); }
    }

    send('done', { reply: fullReply, model, groundedOn: chunks.map(c => c.sourceRef).filter(Boolean) });
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
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OpenRouter=${OPENROUTER_KEYS.length} DeepSeekR1=${DEEPSEEK_KEY ? 'ON' : 'off (deep falls back to OpenRouter)'} Anthropic=${ANTHROPIC_KEY ? 'ON' : 'off (reserved slot)'}`);
  console.log(`📚 Knowledge base: ${KNOWLEDGE_BASE.length} NCERT concept chunks indexed`);
});
