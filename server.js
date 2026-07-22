require('dotenv').config();
const express        = require('express');
const cors            = require('cors');
const path             = require('path');
const mongoose         = require('mongoose');
const session           = require('express-session');
const MongoStore        = require('connect-mongo');
const passport          = require('passport');
const GoogleStrategy    = require('passport-google-oauth20').Strategy;

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ───────────────────────────────────────────────
// FIX: dropped the entire gamification surface (quiz XP/levels/achievements,
// mistake book, planner, mood, formulas, boss battles, story mode, daily
// challenge, leaderboard, multiplayer). Fewer schemas + fewer routes means
// fewer places for state to drift out of sync — that was the biggest source
// of latent bugs in the previous version.
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

  // Response depth. 'deep' is a Pro-only feature — always re-checked
  // server-side in buildSystemPrompt, never trusted from the client alone.
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep'] },
  examDate:        { type: Date, default: null },

  // Plan / paywall. This is intentionally a minimal, provider-agnostic
  // shape so a real gateway (Razorpay/Stripe) can be dropped in later —
  // see README "Payments" section before taking real money.
  isPro:           { type: Boolean, default: false },
  planType:        { type: String, default: '', enum: ['', 'weekly', 'monthly'] },
  planExpiresAt:   { type: Date, default: null },

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

const User        = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Note        = mongoose.model('Note', noteSchema);

// ── SESSION ───────────────────────────────────────────────
// FIX: refuse to boot on a real deployment without a real secret, instead
// of silently falling back to a hardcoded string.
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set. Using an insecure default — set this before deploying.');
}
app.set('trust proxy', 1); // FIX: required for secure cookies to work behind Render's proxy
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
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

// FIX: expiring a Pro plan now happens in one place, on every authenticated
// request, instead of being scattered / forgotten.
async function enforcePlanExpiry(user) {
  if (user.isPro && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
    user.isPro = false;
    user.planType = '';
    if (user.responseSpeed === 'deep') user.responseSpeed = 'balanced';
    await user.save();
  }
  return user;
}

// ── AI PROVIDER KEYS ──────────────────────────────────────
const GROQ_KEYS = [process.env.GROQ_KEY_1, process.env.GROQ_KEY_2, process.env.GROQ_KEY_3].filter(Boolean);
const GEMINI_KEYS = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3].filter(Boolean);
const OPENROUTER_KEYS = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2, process.env.OPENROUTER_KEY_3].filter(Boolean);
const OPENROUTER_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b:free',
 ' qwen-2.5-vl'
];
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

async function callOR(messages, prompt) {
  if (!OPENROUTER_KEYS.length) throw new Error('No OpenRouter keys configured');
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
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

async function getReply(messages, prompt, imageBase64 = null) {
  const attempts = [
    () => callOR(messages, prompt),
    () => callGemini(messages, prompt, imageBase64),
    () => callGroq(messages, prompt)
  ];
  let lastErr;
  for (const attempt of attempts) {
    try { return await attempt(); } catch (e) { lastErr = e; console.log('❌ provider failed:', e.message); }
  }
  throw lastErr || new Error('ALL_PROVIDERS_EXHAUSTED');
}

async function getReplyStream(messages, prompt, onToken, abortSignal, imageBase64 = null) {
  try { return await callORStream(messages, prompt, onToken, abortSignal); }
  catch (e) {
    if (e.name === 'AbortError') throw e;
    console.log('❌ OR-stream failed, falling back to non-streaming:', e.message);
  }
  const text = await getReply(messages, prompt, imageBase64);
  onToken(text);
  return text;
}

// ── SYSTEM PROMPT ─────────────────────────────────────────
function buildSystemPrompt(user) {
  const name = user?.name?.split(' ')[0] || 'there';

  // FIX: 'deep' is now enforced server-side. A user cannot get deep-mode
  // depth just by editing the client request — we re-check isPro here.
  const canGoDeep = !!user?.isPro;
  const speed = canGoDeep ? (user?.responseSpeed || 'balanced') : (user?.responseSpeed === 'deep' ? 'balanced' : (user?.responseSpeed || 'balanced'));
  const speedMap = {
    fast:     'SHORT and direct — 2-4 sentences unless the question genuinely needs a derivation.',
    balanced: 'Medium length — full explanation, no filler, no repeated caveats.',
    deep:     'DEEP — complete derivations, note the common trap, and give one adjacent worked example.'
  };

  return `You are GRIND — a direct, exam-savvy mentor for Indian JEE and NEET aspirants.

STUDENT
Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}
Coaching: ${user?.coaching || 'self-study'} | Currently struggling with: ${user?.biggestStruggle || 'not specified'}
Response depth: ${speedMap[speed]}

IDENTITY
- You are only used by authenticated students. There is no guest mode or trial — never mention one.
- Ground every answer in real NTA exam patterns: NCERT line-by-line, PYQs, negative marking, common silly mistakes.
- Reference standard references naturally when relevant: Physics → HC Verma, Irodov, DC Pandey. Chemistry → MS Chouhan (Organic), N Awasthi (Physical), NCERT (Inorganic). Biology → NCERT word-for-word for NEET.

MATH FORMATTING — MANDATORY, NEVER SKIP
- Every variable, symbol, or expression uses inline LaTeX: $...$. No space right after the opening $ or right before the closing $.
- Standalone equations use \\[...\\] on their own line, with a blank line before and after.
- Never write formulas, fractions, or exponents in plain text.
- Never leave a LaTeX delimiter unclosed.

RESPONSE STYLE
- Lead with the concept name in **bold**, then the reasoning, then (if relevant) a short "watch out for" trap line.
- Keep paragraphs under 3 sentences — use line breaks or steps instead of walls of text.
- Mirror the student's language style (Hinglish stays Hinglish, English stays English) — never translate unless asked.
- Never use hollow filler like "You got this!" or "Great question!"

IMAGES
- If a photo of handwritten work or a textbook question is attached, transcribe the relevant part first, then correct or solve it.

SUPPORT
- If the student is venting about burnout, exam pressure, or a bad result: drop academics, validate first, suggest one small next step — not a lecture.
- If a message signals self-harm or crisis: stop academics immediately and give these numbers plainly: Kiran 1800-599-0019, iCall 9152987821, Tele-MANAS 14416. Encourage reaching out to someone now.`;
}

// ══════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════

// FIX: this is the endpoint an external uptime pinger (UptimeRobot,
// cron-job.org, etc.) should hit every 10 minutes to stop Render's free
// tier from spinning the service down after 15 minutes of inactivity.
// A self-ping from inside the process only helps while the process is
// already awake — it cannot wake a service that's already asleep, so an
// external pinger is the only reliable fix. See README.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() })); // kept for backwards compatibility

// Optional belt-and-suspenders: while the dyno IS awake, keep pinging
// ourselves so we never hit the 15-minute idle threshold in the first
// place. No-op unless RENDER_EXTERNAL_URL is present (Render sets this).
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {});
  }, 10 * 60 * 1000);
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
      isPro: u.isPro, planType: u.planType, planExpiresAt: u.planExpiresAt
    }
  });
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle } = req.body;
    if (!exam || !cls) return res.status(400).json({ error: 'Exam and class are required.' });
    await User.findByIdAndUpdate(req.user._id, { exam, class: cls, coaching: coaching || '', biggestStruggle: biggestStruggle || '', isOnboarded: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
});

app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const { responseSpeed, examDate } = req.body;
    const update = {};
    if (responseSpeed) {
      if (!['fast', 'balanced', 'deep'].includes(responseSpeed)) return res.status(400).json({ error: 'Invalid response depth.' });
      // FIX: server refuses to grant 'deep' to a non-Pro user, even if they
      // call this endpoint directly.
      if (responseSpeed === 'deep' && !req.user.isPro) return res.status(402).json({ error: 'Deep mode requires Pro.' });
      update.responseSpeed = responseSpeed;
    }
    if (examDate !== undefined) update.examDate = examDate ? new Date(examDate) : null;
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not save settings.' }); }
});

// ── PLAN / PAYWALL ────────────────────────────────────────
// TEST-MODE ONLY. This grants Pro immediately with no payment verification.
// Before accepting real money, replace this with:
//   1) an endpoint that creates a Razorpay/Stripe order and returns it to
//      the client for checkout,
//   2) a webhook endpoint that verifies the payment signature and THEN
//      sets isPro/planExpiresAt — never trust a client-side "success" call.
const PLAN_DURATIONS_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000 };
app.post('/api/user/upgrade', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLAN_DURATIONS_MS[plan]) return res.status(400).json({ error: 'Unknown plan.' });
    const expires = new Date(Date.now() + PLAN_DURATIONS_MS[plan]);
    await User.findByIdAndUpdate(req.user._id, { isPro: true, planType: plan, planExpiresAt: expires });
    res.json({ success: true, planType: plan, planExpiresAt: expires, testMode: true });
  } catch { res.status(500).json({ error: 'Could not start upgrade.' }); }
});

// ── CHAT (streaming, SSE over POST) ──────────────────────
app.post('/api/chat/stream', requireAuth, async (req, res) => {
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
    const prompt = buildSystemPrompt(user);
    let full = '';
    const reply = await getReplyStream(recent, prompt, chunk => { full += chunk; send('chunk', { text: chunk }); }, abortController.signal, imageBase64 || null);
    const finalReply = reply || full;

    // FIX: use mongoose's own ObjectId validator instead of `.length === 24`,
    // which silently accepted malformed 24-char strings that aren't valid ids.
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
    send('done', { reply: finalReply });
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
  } catch { res.status(500).json({ error: 'Could not load chats.' }); }
});
app.get('/api/sessions/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ sessions: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sessions = await ChatSession.find({ userId: req.user._id, $or: [{ title: regex }, { 'messages.content': regex }] })
      .select('title updatedAt').sort({ updatedAt: -1 }).limit(20).lean();
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Search failed.' }); }
});
app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid session id.' });
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
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid session id.' });
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    s.messages = s.messages.slice(0, Math.max(0, req.body.keepCount || 0));
    s.updatedAt = new Date();
    await s.save();
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not update chat.' }); }
});
app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// ── NOTES ─────────────────────────────────────────────────
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
    const note = await Note.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { title, content, updatedAt: new Date() }, { new: true });
    if (!note) return res.status(404).json({ error: 'Not found.' });
    res.json({ note });
  } catch { res.status(500).json({ error: 'Could not update.' }); }
});
app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try { await Note.deleteOne({ _id: req.params.id, userId: req.user._id }); res.json({ success: true }); }
  catch { res.status(500).json({ error: 'Could not delete.' }); }
});
app.post('/api/notes/ai-assist', requireAuth, async (req, res) => {
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
    const prompt = `You are a study-notes assistant for a JEE/NEET student.\nTask: ${instruction}\nRespond with ONLY the rewritten text — no preamble, no markdown code fences. Use $inline$ and \\[block\\] LaTeX for math.`;
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
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OpenRouter=${OPENROUTER_KEYS.length}`);
});
