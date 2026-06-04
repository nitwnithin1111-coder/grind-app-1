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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ── MONGODB ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ── SCHEMAS ──────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  email:           { type: String },
  name:            { type: String, required: true },
  photo:           { type: String, default: '' },
  gender:          { type: String, default: '' },
  exam:            { type: String, default: '' },
  class:           { type: String, default: '' },
  coaching:        { type: String, default: '' },
  biggestStruggle: { type: String, default: '' },
  hoursPerDay:     { type: String, default: '' },
  isOnboarded:     { type: Boolean, default: false },
  streak:          { type: Number, default: 0 },
  lastActive:      { type: Date, default: Date.now },
  createdAt:       { type: Date, default: Date.now },
  // Settings
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep'] },
  preferredLang:   { type: String, default: 'auto' },
  // Exam countdown
  examDate:        { type: Date, default: null },
  // Burnout tracking
  burnoutScore:    { type: Number, default: 0 },
  lastBurnoutCheck:{ type: Date, default: null }
});

const sessionSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:     { type: String, default: 'New Conversation' },
  messages:  [{
    role:      { type: String, enum: ['user', 'assistant'] },
    content:   { type: String },
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const mistakeSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question:    { type: String, required: true },
  subject:     { type: String, default: '' },
  topic:       { type: String, default: '' },
  note:        { type: String, default: '' },
  explanation: { type: String, default: '' },
  userAnswer:  { type: String, default: '' },
  correctAnswer:{ type: String, default: '' },
  createdAt:   { type: Date, default: Date.now }
});

// ── PLANNER SCHEMAS ──────────────────────────────────────
const plannerTaskSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:         { type: String, required: true },
  subject:       { type: String, default: '' },
  priority:      { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
  estimatedMins: { type: Number, default: 60 },
  status:        { type: String, enum: ['pending', 'completed', 'missed', 'archived'], default: 'pending' },
  scheduledDate: { type: Date, required: true },
  completedAt:   { type: Date, default: null },
  notes:         { type: String, default: '' },
  aiGenerated:   { type: Boolean, default: false },
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now }
});

const plannerStatsSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  totalTasksDone: { type: Number, default: 0 },
  totalTasksMissed:{ type: Number, default: 0 },
  weeklyDone:     { type: [Number], default: [0,0,0,0,0,0,0] }, // Sun-Sat
  subjectHours:   { type: Map, of: Number, default: {} },
  weeklyReport:   { type: String, default: '' },
  lastReportDate: { type: Date, default: null },
  updatedAt:      { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const PlannerStats = mongoose.model('PlannerStats', plannerStatsSchema);

// ── SESSION ──────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ── PASSPORT ─────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email:    profile.emails[0].value,
        name:     profile.displayName,
        photo:    profile.photos[0]?.value || ''
      });
    }
    const now = new Date();
    const last = new Date(user.lastActive);
    const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) user.streak += 1;
    else if (diffDays > 1) user.streak = 1;
    user.lastActive = now;
    await user.save();
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); }
  catch (err) { done(err, null); }
});

app.use(passport.initialize());
app.use(passport.session());

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required' });
}

// ── API KEYS ─────────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5
].filter(Boolean);

const GROQ_KEYS = [
  process.env.GROQ_KEY_1, process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3, process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5
].filter(Boolean);

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2,
  process.env.OPENROUTER_KEY_3, process.env.OPENROUTER_KEY_4,
  process.env.OPENROUTER_KEY_5
].filter(Boolean);

const OPENROUTER_MODELS = [
  'mistralai/mistral-7b-instruct:free',
  'huggingfaceh4/zephyr-7b-beta:free',
  'openchat/openchat-7b:free',
  'nousresearch/nous-capybara-7b:free'
];

let gIdx = 0, grIdx = 0, orIdx = 0, orMIdx = 0;

// ── SYSTEM PROMPT ────────────────────────────────────────
function buildSystemPrompt(user, plannerContext = '') {
  const name = user?.name?.split(' ')[0] || 'there';
  const gender = user?.gender || '';
  const slang = gender === 'female' ? 'bestie' : gender === 'male' ? 'bro' : 'yaar';

  const speedInstructions = {
    fast: 'Keep responses SHORT and PUNCHY — max 3-4 sentences. Speed over depth.',
    balanced: 'Keep responses focused — medium length, warm, precise.',
    deep: 'Give DEEP, thorough responses with full explanations, multiple examples, and rich reasoning. Take your time.'
  };
  const speed = user?.responseSpeed || 'balanced';

  return `You are GRIND — an elite AI cognitive coach and JEE/NEET tutor for Indian aspirants. You combine deep academic expertise with emotional intelligence.

STUDENT PROFILE:
- Name: ${name}
- Gender: ${gender || 'not specified'} → use "${slang}" naturally
- Exam: ${user?.exam || 'JEE/NEET'}
- Class: ${user?.class || 'not specified'}
- Coaching: ${user?.coaching || 'self-study'}
- Biggest struggle: ${user?.biggestStruggle || 'not specified'}
- Study hours/day: ${user?.hoursPerDay || 'not specified'}

RESPONSE SPEED: ${speedInstructions[speed]}

LANGUAGE RULES:
- Automatically detect the user's language from their message.
- Reply in the SAME language/mix the user uses — Hinglish, Telugu-English, Tamil-English, pure Hindi, pure English — whatever they write in.
- Mirror regional slang and cultural expressions naturally.
- Never translate unless asked.
- If they write in Hindi, reply in Hindi. If Hinglish, reply Hinglish. Be a native speaker.

${plannerContext ? `PLANNER CONTEXT (reference this in replies):
${plannerContext}` : ''}

ACADEMIC EXPERTISE:
- You know every JEE/NEET topic deeply: Rotational Motion, Electrostatics, Organic GOC, Integration, Genetics, etc.
- For academic questions, use: Concept → Step-by-Step → Shortcut Trick
- For numerical problems, show clear steps with units. Use LaTeX math notation: $formula$ for inline, $$formula$$ for block.
- For conceptual: give the intuition FIRST then the formula
- 15-16 lakh students appear for JEE every year. Only 16,000 IIT seats.
- Books: HC Verma, DC Pandey, MS Chouhan, VK Jaiswal, Cengage, NCERT

EMOTIONAL INTELLIGENCE — 3 MODES:
1. COMPASSIONATE MODE (burnout/anxiety/failure): Drop everything. Listen first. Validate. Then ONE micro-step.
2. ACCOUNTABILITY MODE (lazy/procrastinating): Direct, urgent, sharp. No lecture. Just action.
3. MEMORY MODE: Reference past patterns gently.

DEPRESSION/CRISIS PROTOCOL:
- If student shows deep despair, worthlessness, crying → NEVER use tough-love. Be gentle and protective.
- If student mentions self-harm or suicide → Stop all academics. Provide: Kiran Helpline: 1800-599-0019, iCall: 9152987821, Tele-MANAS: 14416. Their life > any exam.

🚨 INFINITE INTERROGATION RULE (for academic topics):
- NEVER give a passive answer to any concept/formula/topic question.
- After explaining, ALWAYS end with ONE sharp, specific, JEE Advanced/NEET-level concept-testing question.
- Keep throwing the next logical question, pattern, or numerical — trap them in a productive learning loop.
- Do NOT stop the questioning loop unless the student explicitly says "stop", "enough", "break", "bas", "ruk", or "dont ask".
- This rule does NOT apply when the student is venting, asking for plans, or in emotional distress.

DAY PLANNER MODE:
- When asked about today's plan or study schedule, FIRST ask: "Before I plan your day — how are you feeling right now? Rate yourself: 😴 exhausted / 😐 okay / ⚡ energized"
- Based on their energy, adjust the plan intensity accordingly.
- Never give 8+ hour plans to someone who's tired. Give 2-3 realistic targets.
- Use 45-min sprints + 10-min breaks format.
- End with 3 quick clickable options for them to confirm/adjust.

RESPONSE RULES:
- Address ${name} by name occasionally, use ${slang} naturally
- No hollow phrases like "You got this!" or "Believe in yourself!"
- No [WIN:], [FOCUS:], [RESTART:] tags
- For academic questions: use **bold** for key terms, use $math$ for formulas
- Always end academic answers with a follow-up question (the interrogation rule above)`;
}

// ── API HELPERS ──────────────────────────────────────────
async function fetchWithTimeout(url, options, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer); return res;
  } catch (err) { clearTimeout(timer); throw err; }
}

async function callGemini(messages, systemPrompt, speed = 'balanced') {
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const tokenMap = { fast: 400, balanced: 700, deep: 1200 };
  const tempMap  = { fast: 0.7, balanced: 0.85, deep: 0.9 };
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: {
          maxOutputTokens: tokenMap[speed] || 700,
          temperature: tempMap[speed] || 0.85
        }
      })
    }, speed === 'deep' ? 20000 : 12000
  );
  const data = await res.json();
  if (data.error) throw new Error('GEMINI: ' + data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(messages, systemPrompt, speed = 'balanced') {
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  const tokenMap = { fast: 400, balanced: 700, deep: 1200 };
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: tokenMap[speed] || 700,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  }, speed === 'deep' ? 20000 : 12000);
  const data = await res.json();
  if (data.error) throw new Error('GROQ: ' + data.error.message);
  return data.choices[0].message.content;
}

async function callOpenRouter(messages, systemPrompt) {
  const key = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI'
    },
    body: JSON.stringify({
      model, max_tokens: 700,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('OPENROUTER: ' + data.error.message);
  return data.choices[0].message.content;
}

async function getAIReply(messages, systemPrompt, speed = 'balanced') {
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, systemPrompt, speed); }
    catch (err) { console.log(`❌ Gemini ${i+1}:`, err.message); }
  }
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, systemPrompt, speed); }
    catch (err) { console.log(`❌ Groq ${i+1}:`, err.message); }
  }
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOpenRouter(messages, systemPrompt); }
    catch (err) { console.log(`❌ OpenRouter ${i+1}:`, err.message); }
  }
  throw new Error('ALL_KEYS_EXHAUSTED');
}

// ── PLANNER CONTEXT BUILDER ──────────────────────────────
async function buildPlannerContext(userId) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayTasks = await PlannerTask.find({
      userId,
      scheduledDate: { $gte: today, $lt: tomorrow }
    }).lean();

    const completedToday = todayTasks.filter(t => t.status === 'completed').length;
    const pendingToday = todayTasks.filter(t => t.status === 'pending').length;
    const missedToday = todayTasks.filter(t => t.status === 'missed').length;

    if (todayTasks.length === 0) return '';

    const taskList = todayTasks.map(t =>
      `- ${t.title} (${t.subject}, ${t.status})`
    ).join('\n');

    return `Today's Planner (${today.toDateString()}):
${taskList}
Summary: ${completedToday} done, ${pendingToday} pending, ${missedToday} missed out of ${todayTasks.length} tasks.`;
  } catch { return ''; }
}

// ── AUTH ROUTES ──────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive' }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    // Always redirect properly — never fall into guest mode
    if (req.user.isOnboarded) {
      res.redirect('/?loggedin=true');
    } else {
      res.redirect('/?onboarding=true');
    }
  }
);

app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: {
    id:            req.user._id,
    name:          req.user.name,
    email:         req.user.email,
    photo:         req.user.photo,
    isOnboarded:   req.user.isOnboarded,
    exam:          req.user.exam,
    class:         req.user.class,
    coaching:      req.user.coaching,
    gender:        req.user.gender,
    streak:        req.user.streak,
    responseSpeed: req.user.responseSpeed || 'balanced',
    examDate:      req.user.examDate,
    hoursPerDay:   req.user.hoursPerDay,
    biggestStruggle: req.user.biggestStruggle
  }});
});

// ── SETTINGS ─────────────────────────────────────────────
app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const { responseSpeed, examDate } = req.body;
    const update = {};
    if (responseSpeed) update.responseSpeed = responseSpeed;
    if (examDate !== undefined) update.examDate = examDate ? new Date(examDate) : null;
    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not save settings.' }); }
});

// ── ONBOARDING ───────────────────────────────────────────
app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;
    await User.findByIdAndUpdate(req.user._id, {
      exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender, isOnboarded: true
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── CHAT SESSIONS ────────────────────────────────────────
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(30);
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Could not load history.' }); }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    res.json({ session });
  } catch { res.status(500).json({ error: 'Could not load session.' }); }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete session.' }); }
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.create({
      userId: req.user._id, title: 'New Conversation', messages: []
    });
    res.json({ sessionId: session._id });
  } catch { res.status(500).json({ error: 'Could not create session.' }); }
});

// ── MAIN CHAT ROUTE ──────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId, isGuest } = req.body;
  const user = req.user;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const recentMessages = messages.slice(-20);
  const speed = user?.responseSpeed || 'balanced';

  // Build planner context for logged-in users
  let plannerContext = '';
  if (user) {
    plannerContext = await buildPlannerContext(user._id);
  }

  const systemPrompt = buildSystemPrompt(user, plannerContext);

  try {
    const reply = await getAIReply(recentMessages, systemPrompt, speed);

    if (user && sessionId && sessionId !== 'guest') {
      try {
        const userMsg = messages[messages.length - 1];
        let title = 'Conversation';
        if (messages.length <= 2) {
          title = userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '');
        }
        await ChatSession.findByIdAndUpdate(
          sessionId,
          {
            $push: {
              messages: [
                { role: 'user', content: userMsg.content },
                { role: 'assistant', content: reply }
              ]
            },
            $set: { title, updatedAt: new Date() }
          },
          { upsert: true, new: true }
        );
      } catch (err) { console.error('Session save error:', err.message); }
    }

    res.json({ reply });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Our AI is taking a short break. Please try again.' });
  }
});

// ── MISTAKE BOOK ─────────────────────────────────────────
app.get('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const mistakes = await Mistake.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ mistakes });
  } catch { res.status(500).json({ error: 'Could not load mistake book.' }); }
});

app.post('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const { question, subject, topic, note, explanation, userAnswer, correctAnswer } = req.body;
    const mistake = await Mistake.create({
      userId: req.user._id, question, subject, topic, note,
      explanation: explanation || '', userAnswer: userAnswer || '', correctAnswer: correctAnswer || ''
    });
    res.json({ mistake });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

app.delete('/api/mistakes/:id', requireAuth, async (req, res) => {
  try {
    await Mistake.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// ── PLANNER ROUTES ────────────────────────────────────────
app.get('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const { view } = req.query; // today, tomorrow, week, month, completed, archived
    const now = new Date();
    const today = new Date(now); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    const dayAfter = new Date(tomorrow); dayAfter.setDate(dayAfter.getDate()+1);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate()+7);
    const monthEnd = new Date(today); monthEnd.setDate(monthEnd.getDate()+30);

    let filter = { userId: req.user._id };

    if (view === 'today') {
      filter.scheduledDate = { $gte: today, $lt: tomorrow };
      filter.status = { $in: ['pending', 'completed', 'missed'] };
    } else if (view === 'tomorrow') {
      filter.scheduledDate = { $gte: tomorrow, $lt: dayAfter };
      filter.status = { $in: ['pending', 'completed', 'missed'] };
    } else if (view === 'week') {
      filter.scheduledDate = { $gte: today, $lt: weekEnd };
      filter.status = { $in: ['pending', 'completed', 'missed'] };
    } else if (view === 'month') {
      filter.scheduledDate = { $gte: today, $lt: monthEnd };
      filter.status = { $in: ['pending', 'completed', 'missed'] };
    } else if (view === 'completed') {
      filter.status = 'completed';
    } else if (view === 'archived') {
      filter.status = 'archived';
    } else {
      // default today
      filter.scheduledDate = { $gte: today, $lt: tomorrow };
    }

    const tasks = await PlannerTask.find(filter).sort({ priority: 1, scheduledDate: 1 });
    res.json({ tasks });
  } catch { res.status(500).json({ error: 'Could not load tasks.' }); }
});

app.post('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const { title, subject, priority, estimatedMins, scheduledDate, notes, aiGenerated } = req.body;
    const task = await PlannerTask.create({
      userId: req.user._id, title, subject, priority: priority || 'medium',
      estimatedMins: estimatedMins || 60, scheduledDate: new Date(scheduledDate),
      notes: notes || '', aiGenerated: aiGenerated || false
    });
    res.json({ task });
  } catch { res.status(500).json({ error: 'Could not create task.' }); }
});

app.patch('/api/planner/tasks/:id', requireAuth, async (req, res) => {
  try {
    const update = { ...req.body, updatedAt: new Date() };
    if (req.body.status === 'completed') {
      update.completedAt = new Date();
      // Update stats
      await PlannerStats.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { totalTasksDone: 1 }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
    }
    if (req.body.status === 'missed') {
      await PlannerStats.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { totalTasksMissed: 1 }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
    }
    const task = await PlannerTask.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      update, { new: true }
    );
    res.json({ task });
  } catch { res.status(500).json({ error: 'Could not update task.' }); }
});

app.delete('/api/planner/tasks/:id', requireAuth, async (req, res) => {
  try {
    await PlannerTask.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete task.' }); }
});

// ── AI PLANNER GENERATION ─────────────────────────────────
app.post('/api/planner/generate', requireAuth, async (req, res) => {
  try {
    const { period, energyLevel, targetDate, customNote } = req.body;
    const user = req.user;

    // Get past performance stats
    const stats = await PlannerStats.findOne({ userId: user._id }).lean();
    const completionRate = stats
      ? Math.round((stats.totalTasksDone / Math.max(1, stats.totalTasksDone + stats.totalTasksMissed)) * 100)
      : 75;

    const prompt = `Generate a ${period || 'daily'} study plan for a student with this profile:
- Exam: ${user.exam || 'JEE'}
- Class: ${user.class || '12th'}
- Study hours available: ${user.hoursPerDay || '6'} hours/day
- Coaching: ${user.coaching || 'self-study'}
- Biggest struggle: ${user.biggestStruggle || 'concepts'}
- Energy level right now: ${energyLevel || 'medium'} (adjust intensity accordingly)
- Past task completion rate: ${completionRate}% (${completionRate < 60 ? 'reduce workload, they struggle to complete tasks' : completionRate > 85 ? 'can handle slightly more tasks' : 'keep workload realistic'})
- Additional note: ${customNote || 'none'}
- Target date: ${targetDate || new Date().toDateString()}

Return ONLY valid JSON array (no markdown):
[{"title":"Task name","subject":"Physics","priority":"high","estimatedMins":45,"notes":"What to cover"}]

Rules:
- Max 6 tasks for 'tired/low' energy, 8 for 'medium', 10 for 'high'
- Include breaks as tasks (title: "Break", subject: "Rest", estimatedMins: 10)
- Prioritize weak subjects
- Be realistic — better to finish 6 tasks than miss 10`;

    const reply = await getAIReply([{ role: 'user', content: prompt }],
      'You are a JEE/NEET study planner. Return only valid JSON arrays, no markdown, no explanation.');

    const clean = reply.replace(/```json|```/g, '').trim();
    const tasks = JSON.parse(clean);

    const targetDateObj = new Date(targetDate || new Date());
    targetDateObj.setHours(6, 0, 0, 0);

    const savedTasks = [];
    for (const t of tasks) {
      const task = await PlannerTask.create({
        userId: user._id,
        title: t.title,
        subject: t.subject || '',
        priority: t.priority || 'medium',
        estimatedMins: t.estimatedMins || 45,
        scheduledDate: targetDateObj,
        notes: t.notes || '',
        aiGenerated: true
      });
      savedTasks.push(task);
    }

    res.json({ tasks: savedTasks });
  } catch (err) {
    console.error('Planner gen error:', err.message);
    res.status(500).json({ error: 'Could not generate plan. Try again.' });
  }
});

// ── PLANNER STATS ─────────────────────────────────────────
app.get('/api/planner/stats', requireAuth, async (req, res) => {
  try {
    const stats = await PlannerStats.findOne({ userId: req.user._id }).lean();

    // Calculate week completion
    const weekStart = new Date(); weekStart.setHours(0,0,0,0);
    weekStart.setDate(weekStart.getDate() - 7);
    const weekTasks = await PlannerTask.find({
      userId: req.user._id,
      scheduledDate: { $gte: weekStart },
      status: { $in: ['completed', 'missed', 'pending'] }
    }).lean();

    const weekDone = weekTasks.filter(t => t.status === 'completed').length;
    const weekTotal = weekTasks.length;
    const weekRate = weekTotal > 0 ? Math.round((weekDone / weekTotal) * 100) : 0;

    // Subject hours
    const subjectMap = {};
    weekTasks.filter(t => t.status === 'completed').forEach(t => {
      if (t.subject && t.subject !== 'Rest') {
        subjectMap[t.subject] = (subjectMap[t.subject] || 0) + (t.estimatedMins / 60);
      }
    });

    res.json({
      totalDone: stats?.totalTasksDone || 0,
      totalMissed: stats?.totalTasksMissed || 0,
      weekRate,
      weekDone,
      weekTotal,
      subjectHours: subjectMap
    });
  } catch { res.status(500).json({ error: 'Could not load stats.' }); }
});

// ── MIDNIGHT TASK ROLLOVER (called by client or cron) ────
app.post('/api/planner/rollover', requireAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    // Mark all pending tasks from yesterday as missed
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate()-1);
    await PlannerTask.updateMany(
      { userId: req.user._id, scheduledDate: { $lt: today }, status: 'pending' },
      { $set: { status: 'missed', updatedAt: new Date() } }
    );
    // Count newly missed
    const missed = await PlannerTask.countDocuments({
      userId: req.user._id, scheduledDate: { $gte: yesterday, $lt: today }, status: 'missed'
    });
    if (missed > 0) {
      await PlannerStats.findOneAndUpdate(
        { userId: req.user._id },
        { $inc: { totalTasksMissed: missed } },
        { upsert: true }
      );
    }
    res.json({ success: true, missedCount: missed });
  } catch { res.status(500).json({ error: 'Rollover failed.' }); }
});

// ── WEEKLY REPORT ─────────────────────────────────────────
app.post('/api/planner/weekly-report', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const weekStart = new Date(); weekStart.setHours(0,0,0,0);
    weekStart.setDate(weekStart.getDate()-7);

    const tasks = await PlannerTask.find({
      userId: user._id, scheduledDate: { $gte: weekStart }
    }).lean();

    const done = tasks.filter(t => t.status === 'completed');
    const missed = tasks.filter(t => t.status === 'missed');

    const prompt = `Generate a short weekly study report for a JEE/NEET student:
- Tasks completed: ${done.length}
- Tasks missed: ${missed.length}
- Completion rate: ${Math.round(done.length / Math.max(1, tasks.length) * 100)}%
- Subjects covered: ${[...new Set(done.map(t=>t.subject).filter(Boolean))].join(', ') || 'none'}
- Subjects missed: ${[...new Set(missed.map(t=>t.subject).filter(Boolean))].join(', ') || 'none'}

Write a 3-4 sentence warm, honest weekly report. Be specific. End with one actionable suggestion for next week. Keep it under 80 words.`;

    const report = await getAIReply([{ role: 'user', content: prompt }],
      'You are a supportive JEE/NEET coach writing a short weekly report. Be honest, warm, specific.');

    await PlannerStats.findOneAndUpdate(
      { userId: user._id },
      { $set: { weeklyReport: report, lastReportDate: new Date() } },
      { upsert: true }
    );

    res.json({ report });
  } catch { res.status(500).json({ error: 'Could not generate report.' }); }
});

// ── SOCKET.IO QUIZ ROOMS ─────────────────────────────────
const quizRooms = {};

io.on('connection', (socket) => {
  socket.on('create-room', ({ name, subject, config }) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    quizRooms[code] = {
      host: socket.id, subject,
      config: config || { questionCount: 10, difficulty: 'mixed', pyqMode: false, subjects: [subject], chapters: [] },
      players: [{ id: socket.id, name, score: 0, streak: 0 }],
      started: false, currentQ: 0, sabotages: {}
    };
    socket.join(code);
    socket.emit('room-created', { code, config: quizRooms[code].config });
    io.to(code).emit('players-update', quizRooms[code].players);
  });

  socket.on('join-room', ({ code, name }) => {
    const room = quizRooms[code];
    if (!room) return socket.emit('room-error', 'Room not found.');
    if (room.started) return socket.emit('room-error', 'Game already started.');
    room.players.push({ id: socket.id, name, score: 0, streak: 0 });
    socket.join(code);
    socket.emit('room-joined', { code, subject: room.subject, config: room.config });
    io.to(code).emit('players-update', room.players);
  });

  socket.on('start-game', ({ code }) => {
    const room = quizRooms[code];
    if (!room || room.host !== socket.id) return;
    room.started = true;
    io.to(code).emit('game-started', { totalQuestions: room.config?.questionCount || 10 });
    startQuestion(code);
  });

  socket.on('submit-answer', ({ code, answer, timeLeft }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const isCorrect = answer === room.currentAnswer;
    if (isCorrect) {
      player.score += 10 + Math.floor(timeLeft / 3);
      player.streak = (player.streak || 0) + 1;
    } else {
      player.streak = 0;
    }
    socket.emit('answer-result', { correct: isCorrect, correctAnswer: room.currentAnswer });
    io.to(code).emit('players-update', room.players);
  });

  socket.on('use-sabotage', ({ code, type }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.streak < 3) return;
    player.streak = 0;
    socket.to(code).emit('sabotage-activated', { type, by: player.name });
  });

  socket.on('send-emoji', ({ code, emoji }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(code).emit('emoji-broadcast', { emoji, name: player?.name || 'Someone' });
  });

  socket.on('add-time', ({ code }) => {
    // +10 seconds for solo is handled client-side
    const room = quizRooms[code];
    if (room) io.to(code).emit('time-added', { seconds: 10 });
  });

  socket.on('disconnect', () => {
    Object.keys(quizRooms).forEach(code => {
      const room = quizRooms[code];
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(code).emit('players-update', room.players);
        if (room.players.length === 0) delete quizRooms[code];
      }
    });
  });
});

async function startQuestion(code) {
  const room = quizRooms[code];
  if (!room) return;

  const totalQ = room.config?.questionCount || 10;
  if (room.currentQ >= totalQ) {
    io.to(code).emit('game-over', { players: room.players });
    return;
  }

  const subjects = room.config?.subjects?.length ? room.config.subjects : [room.subject || 'Physics'];
  const subject = subjects[room.currentQ % subjects.length];
  const difficulty = room.config?.difficulty || 'mixed';
  const pyqMode = room.config?.pyqMode || false;
  const chapters = room.config?.chapters?.length ? `from chapters: ${room.config.chapters.join(', ')}` : '';

  const prompt = pyqMode
    ? `Generate a real PYQ (Previous Year Question) for JEE/NEET from subject: ${subject} ${chapters}.
Difficulty: ${difficulty}. Return ONLY valid JSON:
{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"Full detailed solution with concept, formula and step-by-step working","cheatSheet":"One-line shortcut trick","trapAlert":"Common NTA trap or empty string","wrongPercent":65,"year":"2023","exam":"JEE Main","shift":"Morning Shift"}`
    : `Generate a JEE/NEET MCQ for subject: ${subject} ${chapters}. Difficulty: ${difficulty}.
Return ONLY valid JSON:
{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"Full detailed solution with concept, formula and step-by-step working","cheatSheet":"One-line shortcut trick","trapAlert":"Common NTA trap or empty string","wrongPercent":65,"year":"","exam":"","shift":""}`;

  try {
    const reply = await getAIReply(
      [{ role: 'user', content: prompt }],
      'You are a JEE/NEET question generator. Return only valid JSON, no markdown.'
    );
    const clean = reply.replace(/```json|```/g, '').trim();
    const qData = JSON.parse(clean);
    room.currentAnswer = qData.answer;
    io.to(code).emit('new-question', {
      ...qData,
      timeLimit: 45,
      questionNumber: room.currentQ + 1,
      totalQuestions: totalQ
    });
    setTimeout(() => {
      io.to(code).emit('question-ended', {
        correctAnswer: qData.answer,
        explanation: qData.explanation,
        cheatSheet: qData.cheatSheet
      });
      setTimeout(() => {
        room.currentQ++;
        startQuestion(code);
      }, 8000);
    }, 45000);
  } catch (err) {
    console.error('Quiz question error:', err.message);
    io.to(code).emit('quiz-error', 'Question generation failed.');
  }
}

// ── SERVE ────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v5 running on port ${PORT}`);
  console.log(`🔑 Keys: Gemini=${GEMINI_KEYS.length} Groq=${GROQ_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
});
