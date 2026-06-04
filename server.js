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
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ── MONGODB ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ──────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:         { type: String, unique: true, sparse: true },
  email:            String,
  name:             { type: String, required: true },
  photo:            { type: String, default: '' },
  gender:           { type: String, default: '' },
  exam:             { type: String, default: '' },
  class:            { type: String, default: '' },
  coaching:         { type: String, default: '' },
  biggestStruggle:  { type: String, default: '' },
  hoursPerDay:      { type: String, default: '' },
  isOnboarded:      { type: Boolean, default: false },
  streak:           { type: Number, default: 0 },
  lastActive:       { type: Date, default: Date.now },
  responseSpeed:    { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep', 'ultra'] },
  examDate:         { type: Date, default: null },
  // Quiz achievements
  quizXP:           { type: Number, default: 0 },
  quizLevel:        { type: Number, default: 1 },
  totalQSolved:     { type: Number, default: 0 },
  totalQCorrect:    { type: Number, default: 0 },
  quizStreak:       { type: Number, default: 0 },
  maxQuizStreak:    { type: Number, default: 0 },
  achievements:     [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP:         { type: Number, default: 0 },
  weeklyXPReset:    { type: Date, default: Date.now },
  createdAt:        { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:    { type: String, default: 'New Conversation' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'] },
    content:   String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const mistakeSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question:     String,
  subject:      String,
  chapter:      String,
  topic:        String,
  explanation:  String,
  userAnswer:   String,
  correctAnswer:String,
  note:         String,
  createdAt:    { type: Date, default: Date.now }
});

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

const feedbackSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true },
  name:     String,
  rating:   Number,
  message:  String,
  type:     { type: String, default: 'exit' },
  createdAt:{ type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const Feedback = mongoose.model('Feedback', feedbackSchema);

// ── SESSION ──────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ── PASSPORT ─────────────────────────────────────────────
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
        email:    profile.emails[0].value,
        name:     profile.displayName,
        photo:    profile.photos[0]?.value || ''
      });
    }
    const now = new Date();
    const diff = Math.floor((now - new Date(user.lastActive)) / 86400000);
    if (diff === 1) user.streak += 1;
    else if (diff > 1) user.streak = 1;
    user.lastActive = now;
    // Reset weekly XP if needed
    const weekAgo = new Date(now - 7 * 86400000);
    if (new Date(user.weeklyXPReset) < weekAgo) {
      user.weeklyXP = 0;
      user.weeklyXPReset = now;
    }
    await user.save();
    return done(null, user);
  } catch (err) { return done(err, null); }
}));

passport.serializeUser((u, done) => done(null, u._id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id)); }
  catch (e) { done(e, null); }
});

app.use(passport.initialize());
app.use(passport.session());

const requireAuth = (req, res, next) => req.isAuthenticated() ? next() : res.status(401).json({ error: 'Login required' });

// ── API KEYS ─────────────────────────────────────────────
const GROQ_KEYS = [
  process.env.GROQ_KEY_1, process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3, process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5
].filter(Boolean);

const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5
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
function buildSystemPrompt(user, plannerCtx = '') {
  const name = user?.name?.split(' ')[0] || 'there';
  const gender = user?.gender || '';
  const slang = gender === 'female' ? 'bestie' : gender === 'male' ? 'bro' : 'yaar';

  const speedMap = {
    fast:     'SHORT and PUNCHY — max 3 sentences. Direct. No fluff.',
    balanced: 'Medium length — warm, focused, precise.',
    deep:     'DEEP and thorough — full explanations, multiple examples, rich reasoning.',
    ultra:    'ULTRA DEEP — treat this like a research paper. Maximum detail, every edge case, full derivations.'
  };
  const speed = user?.responseSpeed || 'balanced';

  return `You are GRIND — elite AI cognitive coach and JEE/NEET tutor for Indian aspirants.

STUDENT: Name=${name} | Gender=${gender}(use "${slang}") | Exam=${user?.exam||'JEE/NEET'} | Class=${user?.class||'?'} | Coaching=${user?.coaching||'self-study'} | Struggle=${user?.biggestStruggle||'?'}

RESPONSE SPEED MODE: ${speedMap[speed]}

LANGUAGE: Auto-detect and mirror user's language. Hinglish→Hinglish. Telugu-English→Telugu-English. Tamil-English→Tamil-English. Pure Hindi→Pure Hindi. Never translate unless asked. Be a native speaker.

${plannerCtx ? `PLANNER CONTEXT:\n${plannerCtx}\n` : ''}

ACADEMIC MODE:
- Format: **Concept** → Step-by-Step → ⚡ Shortcut
- Use LaTeX: $inline$ and $$block$$ for all math/physics formulas
- 15-16 lakh students appear for JEE. Only 16,000 IIT seats.
- Books: HC Verma, DC Pandey, MS Chouhan, VK Jaiswal, Cengage, NCERT

INTERACTIVE CONVERSATION STYLE:
- During normal chat, naturally inject MCQ-style questions to reduce typing fatigue
- Format inline options as: (A) option1  (B) option2  (C) option3  (D) type your own
- Always include "D) Type your own answer" as last option
- Student can reply with just "A", "B", "C" or type their own answer
- Keep conversation flowing naturally — don't make it feel like a test

INFINITE INTERROGATION (academic topics only):
- Never give passive answers to concept/formula questions
- After explaining, ALWAYS end with ONE sharp JEE/NEET-level follow-up question labeled "**YOUR NEXT CHALLENGE:**"
- Keep the learning loop going until student says "stop", "enough", "break", "bas", "ruk"
- Do NOT apply this to emotional/personal conversations

EMOTIONAL MODES:
1. Burnout/anxiety → listen first, validate, then ONE micro-step
2. Procrastination → direct, urgent, no lecture
3. Depression/despair → gentle ONLY, never tough-love
4. Crisis (self-harm/suicide) → STOP academics: Kiran: 1800-599-0019, iCall: 9152987821, Tele-MANAS: 14416

DAY PLANNER:
- Ask energy level first: 😴 exhausted / 😐 okay / ⚡ energized
- Adjust plan intensity based on energy
- 45-min sprints + 10-min breaks
- Never give 8hr plans to tired students

RULES:
- Address ${name} by name occasionally, use ${slang} naturally
- No hollow phrases: "You got this!" "Believe in yourself!"
- No [WIN:] [FOCUS:] [RESTART:] forced tags
- Bold key terms, use LaTeX for all formulas`;
}

// ── ACHIEVEMENTS ENGINE ──────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_blood',   name: 'First Blood',     icon: '🎯', xpRequired: 0,    condition: 'first_correct' },
  { id: 'hot_streak_5',  name: 'On Fire!',         icon: '🔥', xpRequired: 0,    condition: 'streak_5' },
  { id: 'hot_streak_10', name: 'Unstoppable',      icon: '⚡', xpRequired: 0,    condition: 'streak_10' },
  { id: 'centurion',     name: 'Centurion',         icon: '💯', xpRequired: 0,    condition: 'solved_100' },
  { id: 'solver_500',    name: 'Problem Destroyer', icon: '🏆', xpRequired: 0,    condition: 'solved_500' },
  { id: 'level_5',       name: 'Rising Star',       icon: '⭐', xpRequired: 500,  condition: 'level_5' },
  { id: 'level_10',      name: 'JEE Warrior',       icon: '⚔️', xpRequired: 1500, condition: 'level_10' },
  { id: 'level_20',      name: 'IIT Bound',         icon: '🚀', xpRequired: 5000, condition: 'level_20' },
  { id: 'daily_30',      name: 'Grind Mode',        icon: '💪', xpRequired: 0,    condition: 'daily_30_questions' },
  { id: 'accuracy_90',   name: 'Sniper',            icon: '🎖️', xpRequired: 0,    condition: 'accuracy_90' },
  { id: 'week_streak_7', name: 'Week Warrior',      icon: '📅', xpRequired: 0,    condition: 'streak_7_days' },
];

function calcLevel(xp) {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function xpForNextLevel(level) {
  return Math.pow(level, 2) * 100;
}

async function awardXP(userId, xp, correct, newStreak, totalSolved, totalCorrect) {
  const user = await User.findById(userId);
  if (!user) return { newAchievements: [], levelUp: false };

  const oldLevel = calcLevel(user.quizXP);
  user.quizXP += xp;
  user.weeklyXP += xp;
  user.totalQSolved = totalSolved;
  user.totalQCorrect = totalCorrect;
  user.quizStreak = newStreak;
  if (newStreak > user.maxQuizStreak) user.maxQuizStreak = newStreak;
  const newLevel = calcLevel(user.quizXP);
  user.quizLevel = newLevel;

  // Check achievements
  const newAchievements = [];
  const existingIds = user.achievements.map(a => a.id);

  const checks = [
    { id: 'first_blood',   condition: totalCorrect >= 1 },
    { id: 'hot_streak_5',  condition: newStreak >= 5 },
    { id: 'hot_streak_10', condition: newStreak >= 10 },
    { id: 'centurion',     condition: totalSolved >= 100 },
    { id: 'solver_500',    condition: totalSolved >= 500 },
    { id: 'level_5',       condition: newLevel >= 5 },
    { id: 'level_10',      condition: newLevel >= 10 },
    { id: 'level_20',      condition: newLevel >= 20 },
    { id: 'accuracy_90',   condition: totalSolved >= 20 && (totalCorrect/totalSolved) >= 0.9 },
  ];

  for (const check of checks) {
    if (check.condition && !existingIds.includes(check.id)) {
      const ach = ACHIEVEMENTS.find(a => a.id === check.id);
      if (ach) {
        user.achievements.push({ id: ach.id, name: ach.name, icon: ach.icon, unlockedAt: new Date() });
        newAchievements.push(ach);
      }
    }
  }

  await user.save();
  return { newAchievements, levelUp: newLevel > oldLevel, newLevel, totalXP: user.quizXP };
}

// ── API HELPERS ──────────────────────────────────────────
async function fetchWithTimeout(url, options, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function callGroq(messages, prompt) {
  const key = GROQ_KEYS[grIdx % GROQ_KEYS.length];
  grIdx++;
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const d = await res.json();
  if (d.error) throw new Error('GROQ: ' + d.error.message);
  return d.choices[0].message.content;
}

async function callGemini(messages, prompt, imageBase64 = null) {
  const key = GEMINI_KEYS[gIdx % GEMINI_KEYS.length];
  gIdx++;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') last.parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  }
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: prompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1500, temperature: 0.85 }
      })
    }
  );
  const d = await res.json();
  if (d.error) throw new Error('GEMINI: ' + d.error.message);
  return d.candidates[0].content.parts[0].text;
}

async function callOR(messages, prompt) {
  const key = OPENROUTER_KEYS[orIdx % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx % OPENROUTER_MODELS.length];
  orIdx++; orMIdx++;
  const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://grind-ai.onrender.com',
      'X-Title': 'GRIND AI'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const d = await res.json();
  if (d.error) throw new Error('OR: ' + d.error.message);
  return d.choices[0].message.content;
}

async function getReply(messages, prompt, imageBase64 = null) {
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, prompt); }
    catch (e) { console.log(`❌ GR${i + 1}:`, e.message); }
  }
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, prompt, imageBase64); }
    catch (e) { console.log(`❌ G${i + 1}:`, e.message); }
  }
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOR(messages, prompt); }
    catch (e) { console.log(`❌ OR${i + 1}:`, e.message); }
  }
  throw new Error('ALL_EXHAUSTED');
}

const getAIReply = getReply;

// ── PLANNER CONTEXT ──────────────────────────────────────
async function buildPlannerContext(userId) {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const tasks = await PlannerTask.find({ userId, scheduledDate: { $gte: today, $lt: tomorrow } }).lean();
    if (!tasks.length) return '';
    const done = tasks.filter(t => t.status === 'completed').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    return `Today's Plan: ${done} done, ${pending} pending out of ${tasks.length} tasks.\n${tasks.map(t => `- ${t.title} (${t.subject}, ${t.status})`).join('\n')}`;
  } catch { return ''; }
}

// ── ROUTES ───────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);

app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
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
      weeklyXP: u.weeklyXP
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
  } catch { res.status(500).json({ error: 'Could not save settings.' }); }
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;
    await User.findByIdAndUpdate(req.user._id, {
      exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender, isOnboarded: true
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── LEADERBOARD ──────────────────────────────────────────
app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const { type } = req.query; // weekly, alltime
    const sortField = type === 'weekly' ? 'weeklyXP' : 'quizXP';
    const users = await User.find({ isOnboarded: true })
      .select('name photo quizXP weeklyXP quizLevel totalQSolved maxQuizStreak achievements')
      .sort({ [sortField]: -1 })
      .limit(50)
      .lean();

    const board = users.map((u, i) => ({
      rank: i + 1,
      name: u.name?.split(' ')[0] || 'Student',
      photo: u.photo,
      xp: type === 'weekly' ? u.weeklyXP : u.quizXP,
      level: u.quizLevel || 1,
      solved: u.totalQSolved || 0,
      maxStreak: u.maxQuizStreak || 0,
      badges: (u.achievements || []).length,
      isMe: u._id?.toString() === req.user._id?.toString()
    }));

    res.json({ board });
  } catch { res.status(500).json({ error: 'Could not load leaderboard.' }); }
});

// ── QUIZ XP AWARD ─────────────────────────────────────────
app.post('/api/quiz/question', async (req, res) => {
  const { subject, chapter, difficulty, pyqMode, exam } = req.body;

  const qPrompt = `You are a JEE/NEET question bank expert.
Subject: ${subject || 'Physics'}. ${chapter ? 'Chapter: ' + chapter : ''} Difficulty: ${difficulty || 'medium'}.
${pyqMode ? `This MUST be a real verified Previous Year Question from ${exam || 'JEE Main'}.
Include actual exam year, date and shift. Include real % of students who got it wrong.` : 'Generate a fresh high quality practice question.'}

Return ONLY this JSON, nothing else, no markdown:
{"question":"full question text","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"step by step solution with concept and formula","cheatSheet":"one powerful shortcut trick","trapAlert":"common mistake or empty string","wrongPercent":68,"year":"${pyqMode ? '2023' : ''}","exam":"${pyqMode ? exam || 'JEE Main' : ''}","shift":"${pyqMode ? 'Jan 24 Shift 1' : ''}","chapter":"${chapter || subject || ''}"}`;

  try {
    const reply = await getReply(
      [{ role: 'user', content: qPrompt }],
      'You are a JEE/NEET question generator. Return ONLY valid compact JSON. No markdown. No extra text. No explanation outside JSON.'
    );

    let clean = reply.replace(/```json/g, '').replace(/```/g, '').trim();
    
    // Fix incomplete JSON
    if (!clean.endsWith('}')) {
      const lastBrace = clean.lastIndexOf('}');
      if (lastBrace > 0) clean = clean.substring(0, lastBrace + 1);
    }

    const q = JSON.parse(clean);
    res.json({ question: q });
  } catch (err) {
    console.error('Solo quiz error:', err.message);
    res.status(500).json({ error: 'Could not generate question. Try again.' });
  }
});
  try {
    const { correct, streak, totalSolved, totalCorrect, xpEarned } = req.body;
    const result = await awardXP(req.user._id, xpEarned || (correct ? 10 : 2), correct, streak, totalSolved, totalCorrect);
    res.json(result);
  } catch { res.status(500).json({ error: 'Could not award XP.' }); }
});

// ── SESSIONS ─────────────────────────────────────────────
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

// ── MAIN CHAT ────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  const user = req.user;

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request.' });

  const recent = messages.slice(-20);
  const plannerCtx = await buildPlannerContext(user._id);
  const prompt = buildSystemPrompt(user, plannerCtx);

  try {
    const reply = await getReply(recent, prompt, imageBase64 || null);

    if (sessionId && sessionId !== 'new' && sessionId !== 'quiz' && sessionId !== 'guest' && sessionId.length === 24) {
      try {
        const userMsg = messages[messages.length - 1];
        const title = messages.length <= 2 ? userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '') : undefined;
        await ChatSession.findByIdAndUpdate(sessionId, {
          $push: { messages: [{ role: 'user', content: userMsg.content }, { role: 'assistant', content: reply }] },
          $set: { updatedAt: new Date(), ...(title ? { title } : {}) }
        }, { upsert: true });
      } catch (e) { console.error('Session save:', e.message); }
    }

    res.json({ reply });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Our AI is taking a short break. Please try again.' });
  }
});

// ── QUIZ QUESTION GENERATION ──────────────────────────────
app.post('/api/quiz/question', requireAuth, async (req, res) => {
  const { subject, chapter, topic, difficulty, pyqMode, exam } = req.body;
  const chapterInfo = chapter ? ` from chapter "${chapter}"` : '';
  const topicInfo = topic ? `, specifically about "${topic}"` : '';
  const diffInfo = difficulty || 'mixed';

  const prompt = pyqMode
    ? `Generate a real Previous Year Question for ${exam || 'JEE Main'} from ${subject}${chapterInfo}${topicInfo}. Difficulty: ${diffInfo}.
Return ONLY valid JSON (no markdown):
{"question":"full question text","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"Complete step-by-step solution with concept name, formula used, and full working","cheatSheet":"One powerful shortcut or memory trick","trapAlert":"Specific NTA trap or common mistake students make, or empty string","wrongPercent":68,"year":"2024","exam":"JEE Main","shift":"January 24, Shift 1","chapter":"${chapter || subject}"}`
    : `Generate a high-quality JEE/NEET MCQ for ${subject}${chapterInfo}${topicInfo}. Difficulty: ${diffInfo}.
Return ONLY valid JSON (no markdown):
{"question":"full question text","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"Complete step-by-step solution with concept name, formula used, and full working","cheatSheet":"One powerful shortcut or memory trick","trapAlert":"Specific common mistake or empty string","wrongPercent":65,"year":"","exam":"","shift":"","chapter":"${chapter || subject}"}`;

  try {
    const reply = await getReply(
      [{ role: 'user', content: prompt }],
      'You are an expert JEE/NEET question generator. Return ONLY valid compact JSON, no markdown, no extra text, no explanation outside JSON.'
    );
    const clean = reply.replace(/```json|```/g, '').trim();
    const q = JSON.parse(clean);
    res.json({ question: q });
  } catch (err) {
    console.error('Quiz gen error:', err.message);
    res.status(500).json({ error: 'Could not generate question. Try again.' });
  }
});

// ── MISTAKES ─────────────────────────────────────────────
app.get('/api/mistakes', requireAuth, async (req, res) => {
  try {
    res.json({ mistakes: await Mistake.find({ userId: req.user._id }).sort({ createdAt: -1 }) });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});

app.post('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const m = await Mistake.create({ userId: req.user._id, ...req.body });
    res.json({ mistake: m });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

app.delete('/api/mistakes/:id', requireAuth, async (req, res) => {
  try {
    await Mistake.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// ── PLANNER ──────────────────────────────────────────────
app.get('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const { view } = req.query;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);

    let filter = { userId: req.user._id };
    if (view === 'today') { filter.scheduledDate = { $gte: today, $lt: tomorrow }; filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'week') { filter.scheduledDate = { $gte: today, $lt: weekEnd }; filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'completed') { filter.status = 'completed'; }
    else { filter.scheduledDate = { $gte: today, $lt: tomorrow }; }

    const tasks = await PlannerTask.find(filter).sort({ priority: 1, scheduledDate: 1 });
    res.json({ tasks });
  } catch { res.status(500).json({ error: 'Could not load tasks.' }); }
});

app.post('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const task = await PlannerTask.create({ userId: req.user._id, ...req.body, scheduledDate: new Date(req.body.scheduledDate) });
    res.json({ task });
  } catch { res.status(500).json({ error: 'Could not create.' }); }
});

app.patch('/api/planner/tasks/:id', requireAuth, async (req, res) => {
  try {
    const update = { ...req.body, updatedAt: new Date() };
    if (req.body.status === 'completed') update.completedAt = new Date();
    const task = await PlannerTask.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, update, { new: true });
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
    const { period, energyLevel, targetDate, customNote } = req.body;
    const user = req.user;
    const prompt = `Generate a ${period || 'daily'} study plan:
- Exam: ${user.exam || 'JEE'} | Class: ${user.class || '12th'} | Hours: ${user.hoursPerDay || '6'}/day
- Energy: ${energyLevel || 'medium'} | Struggle: ${user.biggestStruggle || 'concepts'}
- Note: ${customNote || 'none'}
Return ONLY JSON array (no markdown): [{"title":"...","subject":"...","priority":"high/medium/low","estimatedMins":45,"notes":"..."}]
Rules: Max 6 tasks if tired, 8 medium, 10 energized. Include short breaks. Be realistic.`;

    const reply = await getAIReply([{ role: 'user', content: prompt }], 'Return only valid JSON array, no markdown.');
    const tasks = JSON.parse(reply.replace(/```json|```/g, '').trim());
    const date = new Date(targetDate || new Date()); date.setHours(6, 0, 0, 0);
    const saved = [];
    for (const t of tasks) {
      saved.push(await PlannerTask.create({ userId: user._id, ...t, scheduledDate: date, aiGenerated: true }));
    }
    res.json({ tasks: saved });
  } catch (err) {
    console.error('Planner gen:', err.message);
    res.status(500).json({ error: 'Could not generate plan.' });
  }
});

// ── FEEDBACK ─────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    await Feedback.create({ userId: req.user?._id, name: req.user?.name || 'User', ...req.body });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not save feedback.' }); }
});

app.get('/api/admin/feedback', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try {
    const feedback = await Feedback.find().sort({ createdAt: -1 }).limit(200);
    res.json({ feedback });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});

// ── PLANNER ROLLOVER ──────────────────────────────────────
app.post('/api/planner/rollover', requireAuth, async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    await PlannerTask.updateMany(
      { userId: req.user._id, scheduledDate: { $lt: today }, status: 'pending' },
      { $set: { status: 'missed', updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Rollover failed.' }); }
});

// ── SOCKET.IO QUIZ ROOMS ─────────────────────────────────
const quizRooms = {};

io.on('connection', socket => {
  socket.on('create-room', ({ name, config }) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    quizRooms[code] = {
      host: socket.id,
      config: config || { questionCount: 10, difficulty: 'mixed', pyqMode: false, subjects: ['Physics'], chapters: [] },
      players: [{ id: socket.id, name, score: 0, streak: 0, correct: 0, total: 0 }],
      started: false, currentQ: 0, currentAnswer: ''
    };
    socket.join(code);
    socket.emit('room-created', { code });
    io.to(code).emit('players-update', quizRooms[code].players);
  });

  socket.on('join-room', ({ code, name }) => {
    const room = quizRooms[code];
    if (!room) return socket.emit('room-error', 'Room not found. Check the code.');
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
    io.to(code).emit('game-started', { totalQ: room.config?.questionCount || 10 });
    startMultiQuestion(code);
  });

  socket.on('submit-answer', ({ code, answer, timeLeft }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.total = (player.total || 0) + 1;
    const correct = answer === room.currentAnswer;
    if (correct) {
      player.score += 10 + Math.floor((timeLeft || 0) / 3);
      player.streak = (player.streak || 0) + 1;
      player.correct = (player.correct || 0) + 1;
    } else {
      player.streak = 0;
    }
    socket.emit('answer-result', { correct, correctAnswer: room.currentAnswer });
    io.to(code).emit('players-update', room.players);
  });

  socket.on('use-sabotage', ({ code, type }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || (player.streak || 0) < 3) return;
    player.streak = 0;
    socket.to(code).emit('sabotage-activated', { type, by: player.name });
  });

  socket.on('send-emoji', ({ code, emoji }) => {
    const room = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    io.to(code).emit('emoji-broadcast', { emoji, name: player?.name || 'Someone' });
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

async function startMultiQuestion(code) {
  const room = quizRooms[code];
  if (!room) return;

  const totalQ = room.config?.questionCount || 10;
  if (room.currentQ >= totalQ) {
    io.to(code).emit('game-over', { players: room.players });
    delete quizRooms[code];
    return;
  }

  const subjects = room.config?.subjects?.length ? room.config.subjects : ['Physics'];
  const subject = subjects[room.currentQ % subjects.length];
  const chapters = room.config?.chapters?.length ? `from chapters: ${room.config.chapters.join(', ')}` : '';
  const difficulty = room.config?.difficulty || 'mixed';
  const pyqMode = room.config?.pyqMode || false;
const qPrompt = `You are a JEE/NEET question bank. Generate question #${room.currentQ + 1}.
Subject: ${subject}. ${chapters ? 'Chapter: ' + chapters : ''} Difficulty: ${difficulty}.
${pyqMode ? `This MUST be a real verified Previous Year Question from JEE Main/Advanced or NEET.
Include the actual exam year, date and shift it appeared in.
Include the real approximate percentage of students who got it wrong based on historical data.` : 'Generate a fresh practice question.'}

Return ONLY this exact JSON structure, nothing else:
{
  "question": "complete question text here",
  "options": ["A) option1", "B) option2", "C) option3", "D) option4"],
  "answer": "A",
  "explanation": "step by step solution with formula and concept name",
  "cheatSheet": "one powerful shortcut trick",
  "trapAlert": "common mistake students make or leave empty",
  "wrongPercent": 72,
  "year": "${pyqMode ? 'actual year like 2023' : ''}",
  "exam": "${pyqMode ? 'JEE Main or JEE Advanced or NEET' : ''}",
  "shift": "${pyqMode ? 'actual shift like January 24 Shift 2' : ''}"
}`;

  try {
    const reply = await getReply([{ role: 'user', content: qPrompt }], 'Return ONLY valid JSON, no markdown.');
    const q = JSON.parse(reply.replace(/```json|```/g, '').trim());
    room.currentAnswer = q.answer;
    io.to(code).emit('new-question', { ...q, timeLimit: 45, questionNumber: room.currentQ + 1, totalQuestions: totalQ });

    setTimeout(() => {
      io.to(code).emit('question-ended', { correctAnswer: q.answer, explanation: q.explanation, cheatSheet: q.cheatSheet });
      setTimeout(() => { room.currentQ++; startMultiQuestion(code); }, 8000);
    }, 45000);
  } catch (err) {
    console.error('Multi quiz error:', err.message);
    io.to(code).emit('quiz-error', 'Question failed. Skipping...');
    setTimeout(() => { room.currentQ++; startMultiQuestion(code); }, 3000);
  }
}

// ── SERVE ────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v6 on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
});
