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
  quizXP:           { type: Number, default: 0 },
  quizLevel:        { type: Number, default: 1 },
  totalQSolved:     { type: Number, default: 0 },
  totalQCorrect:    { type: Number, default: 0 },
  quizStreak:       { type: Number, default: 0 },
  maxQuizStreak:    { type: Number, default: 0 },
  achievements:     [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP:         { type: Number, default: 0 },
  weeklyXPReset:    { type: Date, default: Date.now },
  // Adaptive quiz state persisted per user
  weakTopics:       { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
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
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  questionId:    { type: String, default: '' },
  question:      String,
  subject:       String,
  chapter:       String,
  topic:         String,
  explanation:   String,
  cheatSheet:    { type: String, default: '' },
  trapAlert:     { type: String, default: '' },
  userAnswer:    String,
  correctAnswer: String,
  note:          { type: String, default: '' },
  isPYQ:         { type: Boolean, default: false },
  pyqYear:       { type: String, default: '' },
  pyqExam:       { type: String, default: '' },
  pyqShift:      { type: String, default: '' },
  weekKey:       { type: String, default: '' },
  createdAt:     { type: Date, default: Date.now }
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

// PYQ bank — stores verified questions so we never repeat & can cache
const pyqSchema = new mongoose.Schema({
  subject:      String,
  chapter:      String,
  exam:         String,  // JEE Main | JEE Advanced | NEET
  year:         String,
  shift:        String,
  question:     String,
  options:      [String],
  answer:       String,
  explanation:  String,
  cheatSheet:   String,
  trapAlert:    String,
  wrongPercent: Number,
  verified:     { type: Boolean, default: false },
  createdAt:    { type: Date, default: Date.now }
});

const User        = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake     = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const Feedback    = mongoose.model('Feedback', feedbackSchema);
const PYQ         = mongoose.model('PYQ', pyqSchema);

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
    const now  = new Date();
    const diff = Math.floor((now - new Date(user.lastActive)) / 86400000);
    if      (diff === 1) user.streak += 1;
    else if (diff > 1)  user.streak = 1;
    user.lastActive = now;
    const weekAgo = new Date(now - 7 * 86400000);
    if (new Date(user.weeklyXPReset) < weekAgo) { user.weeklyXP = 0; user.weeklyXPReset = now; }
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

// ── AUTH GUARD — no guest mode ────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required', loginUrl: '/auth/google' });
};

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

// ── SYSTEM PROMPT ─────────────────────────────────────────
function buildSystemPrompt(user, plannerCtx = '') {
  const name   = user?.name?.split(' ')[0] || 'there';
  const gender = user?.gender || '';
  const slang  = gender === 'female' ? 'bestie' : gender === 'male' ? 'bro' : 'yaar';
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

INFINITE INTERROGATION (academic topics only):
- Never give passive answers to concept/formula questions
- After explaining, ALWAYS end with ONE sharp JEE/NEET-level follow-up question labeled "**YOUR NEXT CHALLENGE:**"
- Keep the learning loop going until student says "stop", "enough", "break", "bas", "ruk"

EMOTIONAL MODES:
1. Burnout/anxiety → listen first, validate, then ONE micro-step
2. Procrastination → direct, urgent, no lecture
3. Depression/despair → gentle ONLY, never tough-love
4. Crisis (self-harm/suicide) → STOP academics: Kiran: 1800-599-0019, iCall: 9152987821, Tele-MANAS: 14416
5. If the student is numb or crying, STUDYING IS CANCELLED TONIGHT.
6. Force them to focus only on: unlock the door, wash face, drink water, eat dinner.

RULES:
- Address ${name} by name occasionally, use ${slang} naturally
- No hollow phrases: "You got this!" "Believe in yourself!"
- Bold key terms, use LaTeX for all formulas`;
}

// ── ACHIEVEMENTS ENGINE ───────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_blood',   name: 'First Blood',       icon: '🎯', condition: 'first_correct'       },
  { id: 'hot_streak_5',  name: 'On Fire!',           icon: '🔥', condition: 'streak_5'            },
  { id: 'hot_streak_10', name: 'Unstoppable',        icon: '⚡', condition: 'streak_10'           },
  { id: 'centurion',     name: 'Centurion',          icon: '💯', condition: 'solved_100'          },
  { id: 'solver_500',    name: 'Problem Destroyer',  icon: '🏆', condition: 'solved_500'          },
  { id: 'level_5',       name: 'Rising Star',        icon: '⭐', condition: 'level_5'             },
  { id: 'level_10',      name: 'JEE Warrior',        icon: '⚔️', condition: 'level_10'           },
  { id: 'level_20',      name: 'IIT Bound',          icon: '🚀', condition: 'level_20'            },
  { id: 'accuracy_90',   name: 'Sniper',             icon: '🎖️', condition: 'accuracy_90'        },
];

function calcLevel(xp) { return Math.floor(Math.sqrt(xp / 100)) + 1; }

async function awardXP(userId, xp, correct, newStreak, totalSolved, totalCorrect) {
  const user = await User.findById(userId);
  if (!user) return { newAchievements: [], levelUp: false };
  const oldLevel = calcLevel(user.quizXP);
  user.quizXP      += xp;
  user.weeklyXP    += xp;
  user.totalQSolved  = totalSolved;
  user.totalQCorrect = totalCorrect;
  user.quizStreak    = newStreak;
  if (newStreak > user.maxQuizStreak) user.maxQuizStreak = newStreak;
  const newLevel = calcLevel(user.quizXP);
  user.quizLevel = newLevel;

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
    { id: 'accuracy_90',   condition: totalSolved >= 20 && (totalCorrect / totalSolved) >= 0.9 },
  ];
  for (const check of checks) {
    if (check.condition && !existingIds.includes(check.id)) {
      const ach = ACHIEVEMENTS.find(a => a.id === check.id);
      if (ach) { user.achievements.push({ ...ach, unlockedAt: new Date() }); newAchievements.push(ach); }
    }
  }
  await user.save();
  return { newAchievements, levelUp: newLevel > oldLevel, newLevel, totalXP: user.quizXP };
}

// ── API HELPERS ───────────────────────────────────────────
async function fetchWithTimeout(url, options, ms = 30000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { const res = await fetch(url, { ...options, signal: ctrl.signal }); clearTimeout(timer); return res; }
  catch (err) { clearTimeout(timer); throw err; }
}

async function callGroq(messages, prompt) {
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 2000, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const d = await res.json();
  if (d.error) throw new Error('GROQ: ' + d.error.message);
  return d.choices[0].message.content;
}

async function callGemini(messages, prompt, imageBase64 = null) {
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') last.parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } });
  }
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents, generationConfig: { maxOutputTokens: 2000, temperature: 0.85 } }) }
  );
  const d = await res.json();
  if (d.error) throw new Error('GEMINI: ' + d.error.message);
  return d.candidates[0].content.parts[0].text;
}

async function callOR(messages, prompt) {
  const key   = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const res   = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'HTTP-Referer': 'https://grind-ai.onrender.com', 'X-Title': 'GRIND AI' },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'system', content: prompt }, ...messages] })
  });
  const d = await res.json();
  if (d.error) throw new Error('OR: ' + d.error.message);
  return d.choices[0].message.content;
}

async function getReply(messages, prompt, imageBase64 = null) {
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, prompt); } catch (e) { console.log(`❌ GR${i + 1}:`, e.message); }
  }
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, prompt, imageBase64); } catch (e) { console.log(`❌ G${i + 1}:`, e.message); }
  }
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOR(messages, prompt); } catch (e) { console.log(`❌ OR${i + 1}:`, e.message); }
  }
  throw new Error('ALL_EXHAUSTED');
}

// ── SAFE JSON PARSE ───────────────────────────────────────
function safeParseJSON(raw) {
  let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  // Find first { and last }
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);
  return JSON.parse(clean);
}

// ── PLANNER CONTEXT ───────────────────────────────────────
async function buildPlannerContext(userId) {
  try {
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const tasks    = await PlannerTask.find({ userId, scheduledDate: { $gte: today, $lt: tomorrow } }).lean();
    if (!tasks.length) return '';
    const done    = tasks.filter(t => t.status === 'completed').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    return `Today's Plan: ${done} done, ${pending} pending out of ${tasks.length} tasks.\n${tasks.map(t => `- ${t.title} (${t.subject}, ${t.status})`).join('\n')}`;
  } catch { return ''; }
}

// ── WEEK KEY HELPER ───────────────────────────────────────
function getWeekKey() {
  const d    = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// ── PYQ GENERATION PROMPT ─────────────────────────────────
// Very strict — must cite real exam, real year, real shift.
function buildPYQPrompt(subject, chapter, exam, difficulty) {
  const chapterLine = chapter ? `Chapter/Topic: ${chapter}.` : '';
  const examLine    = exam    ? `Exam: ${exam}.`            : 'Exam: JEE Main or JEE Advanced or NEET (pick whichever has the best real PYQ for this topic).';
  return `You are a verified JEE/NEET question bank with access to all past papers from 2000–2024.

Task: Retrieve ONE real Previous Year Question (PYQ).
Subject: ${subject}. ${chapterLine} ${examLine} Difficulty: ${difficulty || 'medium'}.

STRICT RULES — DO NOT VIOLATE:
1. The question MUST have appeared in an actual exam. Do NOT fabricate.
2. You MUST provide the exact year, exact exam name, and exact shift/date it appeared.
3. If you are not at least 90% confident the question is real, generate a NEW question that matches the style and difficulty of a ${exam || 'JEE Main'} PYQ but mark "verified": false.
4. The answer MUST be the exact answer from the official answer key.
5. explanation must include: concept name, formula, complete step-by-step working.
6. wrongPercent is the estimated % of students who got it wrong historically.

Return ONLY this exact JSON (no markdown, no text outside JSON):
{
  "question": "full question text with all given data",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "answer": "A",
  "explanation": "Step 1: ... Step 2: ... Final answer: ...",
  "cheatSheet": "one powerful shortcut or formula trick",
  "trapAlert": "specific trap NTA/board sets in this type or empty string",
  "wrongPercent": 72,
  "year": "2023",
  "exam": "${exam || 'JEE Main'}",
  "shift": "January 24, Shift 2",
  "chapter": "${chapter || subject}",
  "topic": "${chapter || subject}",
  "verified": true
}`;
}

// ── PRACTICE Q GENERATION PROMPT ─────────────────────────
function buildPracticePrompt(subject, chapter, topic, difficulty, adaptiveFocus) {
  const topicLine   = topic   ? `Topic: ${topic}.`   : '';
  const chapterLine = chapter ? `Chapter: ${chapter}.` : '';
  const adaptLine   = adaptiveFocus
    ? `ADAPTIVE MODE: Student previously got this concept wrong. Generate a fresh question on the SAME concept from a different angle to build true mastery. Focus on: ${adaptiveFocus.join(', ')}.`
    : '';
  return `You are a JEE/NEET expert question generator.
Subject: ${subject}. ${chapterLine} ${topicLine} Difficulty: ${difficulty || 'medium'}.
${adaptLine}

Generate ONE high-quality practice MCQ.
- Must require at least 3 logical/mathematical steps.
- Include a deceptive trap option.
- Explanation must include concept name, formula, and full working.

Return ONLY this exact JSON (no markdown, no text outside JSON):
{
  "question": "full question text",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "answer": "A",
  "explanation": "Step 1: ... Step 2: ... Step 3: ... Final answer: ...",
  "cheatSheet": "one powerful shortcut trick",
  "trapAlert": "common mistake students make or empty string",
  "wrongPercent": 65,
  "year": "",
  "exam": "",
  "shift": "",
  "chapter": "${chapter || subject}",
  "topic": "${topic || chapter || subject}",
  "verified": false
}`;
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);

app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

// Check auth status — frontend uses this to redirect to login instead of showing guest UI
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: req.isAuthenticated(), user: req.user ? { id: req.user._id, name: req.user.name } : null });
});

app.get('/api/me', requireAuth, (req, res) => {
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
      weeklyXP: u.weeklyXP,
      weakTopics: Object.fromEntries(u.weakTopics || new Map())
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
    await User.findByIdAndUpdate(req.user._id, { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender, isOnboarded: true });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong.' }); }
});

// ── LEADERBOARD ───────────────────────────────────────────
app.get('/api/leaderboard', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const sortField = type === 'weekly' ? 'weeklyXP' : 'quizXP';
    const users = await User.find({ isOnboarded: true })
      .select('name photo quizXP weeklyXP quizLevel totalQSolved maxQuizStreak achievements')
      .sort({ [sortField]: -1 }).limit(50).lean();
    const board = users.map((u, i) => ({
      rank: i + 1,
      name: u.name?.split(' ')[0] || 'Student',
      photo: u.photo,
      xp:   type === 'weekly' ? u.weeklyXP : u.quizXP,
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
app.post('/api/quiz/award-xp', requireAuth, async (req, res) => {
  try {
    const { correct, streak, totalSolved, totalCorrect, xpEarned } = req.body;
    const result = await awardXP(req.user._id, xpEarned || (correct ? 10 : 2), correct, streak, totalSolved, totalCorrect);
    res.json(result);
  } catch { res.status(500).json({ error: 'Could not award XP.' }); }
});

// ── QUIZ: WEAK TOPICS SYNC ────────────────────────────────
// Frontend sends updated weakTopics map, server persists it
app.post('/api/quiz/sync-weak-topics', requireAuth, async (req, res) => {
  try {
    const { weakTopics } = req.body;
    await User.findByIdAndUpdate(req.user._id, { weakTopics: new Map(Object.entries(weakTopics || {})) });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not sync weak topics.' }); }
});

// ── QUIZ: SOLO QUESTION (PRACTICE) ───────────────────────
app.post('/api/quiz/question', requireAuth, async (req, res) => {
  const { subject, chapter, topic, difficulty, pyqMode, exam } = req.body;

  // Build adaptive context from user's persisted weak topics
  const user         = req.user;
  const wk           = getWeekKey();
  const weakMap      = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
  const adaptTopics  = [];
  for (const [t, v] of weakMap.entries()) {
    if (v?.weeks?.includes(wk)) adaptTopics.push(t);
  }

  const prompt = pyqMode
    ? buildPYQPrompt(subject || 'Physics', chapter, exam, difficulty)
    : buildPracticePrompt(subject || 'Physics', chapter, topic, difficulty, adaptTopics.length ? adaptTopics : null);

  try {
    const reply = await getReply([{ role: 'user', content: prompt }],
      'You are an expert JEE/NEET question generator. Return ONLY valid compact JSON, no markdown, no extra text.');
    const q = safeParseJSON(reply);
    // Validate minimal structure before sending
    if (!q.question || !q.options || !q.answer) throw new Error('Incomplete question structure');
    res.json({ question: q, adaptive: adaptTopics.length > 0, adaptiveTopics: adaptTopics });
  } catch (err) {
    console.error('Quiz gen error:', err.message);
    res.status(500).json({ error: 'Could not generate question. Please try again.' });
  }
});

// ── QUIZ: LOG WRONG ANSWER (ADAPTIVE ENGINE) ─────────────
// Called by frontend when student answers wrong, updates DB weakness map
app.post('/api/quiz/log-wrong', requireAuth, async (req, res) => {
  try {
    const { topic, subject, chapter } = req.body;
    const user  = req.user;
    const wk    = getWeekKey();
    const wMap  = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
    const entry = wMap.get(topic) || { count: 0, weeks: [], subject, chapter };
    entry.count += 1;
    if (!entry.weeks.includes(wk)) entry.weeks.push(wk);
    wMap.set(topic, entry);
    await User.findByIdAndUpdate(req.user._id, { weakTopics: wMap });
    res.json({ success: true, weeklyWeakTopics: [...wMap.entries()].filter(([, v]) => v.weeks?.includes(wk)).map(([t]) => t) });
  } catch { res.status(500).json({ error: 'Could not log wrong answer.' }); }
});

// ── SESSIONS ──────────────────────────────────────────────
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

// ── MAIN CHAT ─────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  const user = req.user;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request.' });
  const recent     = messages.slice(-20);
  const plannerCtx = await buildPlannerContext(user._id);
  const prompt     = buildSystemPrompt(user, plannerCtx);
  try {
    const reply = await getReply(recent, prompt, imageBase64 || null);
    if (sessionId && sessionId !== 'new' && sessionId !== 'quiz' && sessionId.length === 24) {
      try {
        const userMsg = messages[messages.length - 1];
        const title   = messages.length <= 2 ? userMsg.content.slice(0, 50) + (userMsg.content.length > 50 ? '...' : '') : undefined;
        await ChatSession.findByIdAndUpdate(sessionId, {
          $push: { messages: [{ role: 'user', content: userMsg.content }, { role: 'assistant', content: reply }] },
          $set:  { updatedAt: new Date(), ...(title ? { title } : {}) }
        }, { upsert: true });
      } catch (e) { console.error('Session save:', e.message); }
    }
    res.json({ reply });
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Our AI is taking a short break. Please try again.' });
  }
});

// ── MISTAKES ──────────────────────────────────────────────
app.get('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const { subject, weekKey } = req.query;
    const filter = { userId: req.user._id };
    if (subject) filter.subject = subject;
    if (weekKey) filter.weekKey = weekKey;
    res.json({ mistakes: await Mistake.find(filter).sort({ createdAt: -1 }) });
  } catch { res.status(500).json({ error: 'Could not load.' }); }
});

app.post('/api/mistakes', requireAuth, async (req, res) => {
  try {
    const wk = getWeekKey();
    const m  = await Mistake.create({ userId: req.user._id, weekKey: wk, ...req.body });
    res.json({ mistake: m });
  } catch { res.status(500).json({ error: 'Could not save.' }); }
});

app.delete('/api/mistakes/:id', requireAuth, async (req, res) => {
  try {
    await Mistake.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});

// ── PLANNER ───────────────────────────────────────────────
app.get('/api/planner/tasks', requireAuth, async (req, res) => {
  try {
    const { view } = req.query;
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd  = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
    let filter     = { userId: req.user._id };
    if (view === 'today')     { filter.scheduledDate = { $gte: today, $lt: tomorrow }; filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'week') { filter.scheduledDate = { $gte: today, $lt: weekEnd };  filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'completed') { filter.status = 'completed'; }
    else { filter.scheduledDate = { $gte: today, $lt: tomorrow }; }
    res.json({ tasks: await PlannerTask.find(filter).sort({ priority: 1, scheduledDate: 1 }) });
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
    const user   = req.user;
    const prompt = `Generate a ${period || 'daily'} study plan:
- Exam: ${user.exam || 'JEE'} | Class: ${user.class || '12th'} | Hours: ${user.hoursPerDay || '6'}/day
- Energy: ${energyLevel || 'medium'} | Struggle: ${user.biggestStruggle || 'concepts'}
- Note: ${customNote || 'none'}
Return ONLY JSON array (no markdown): [{"title":"...","subject":"...","priority":"high/medium/low","estimatedMins":45,"notes":"..."}]
Rules: Max 6 tasks if tired, 8 medium, 10 energized. Include short breaks. Be realistic.`;
    const reply = await getReply([{ role: 'user', content: prompt }], 'Return only valid JSON array, no markdown.');
    const tasks = JSON.parse(reply.replace(/```json|```/g, '').trim());
    const date  = new Date(targetDate || new Date()); date.setHours(6, 0, 0, 0);
    const saved = [];
    for (const t of tasks) saved.push(await PlannerTask.create({ userId: user._id, ...t, scheduledDate: date, aiGenerated: true }));
    res.json({ tasks: saved });
  } catch (err) { console.error('Planner gen:', err.message); res.status(500).json({ error: 'Could not generate plan.' }); }
});

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

// ── FEEDBACK ──────────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  try {
    await Feedback.create({ userId: req.user?._id, name: req.user?.name || 'User', ...req.body });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not save feedback.' }); }
});

app.get('/api/admin/feedback', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try { res.json({ feedback: await Feedback.find().sort({ createdAt: -1 }).limit(200) }); }
  catch { res.status(500).json({ error: 'Could not load.' }); }
});

// ── SOCKET.IO QUIZ ROOMS ──────────────────────────────────
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
      player.score  += 10 + Math.floor((timeLeft || 0) / 3);
      player.streak  = (player.streak || 0) + 1;
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
  const subjects  = room.config?.subjects?.length ? room.config.subjects : ['Physics'];
  const subject   = subjects[room.currentQ % subjects.length];
  const chapters  = room.config?.chapters?.length ? room.config.chapters.join(', ') : '';
  const difficulty= room.config?.difficulty || 'mixed';
  const pyqMode   = room.config?.pyqMode || false;

  const qPrompt = pyqMode
    ? buildPYQPrompt(subject, chapters, room.config?.exam || 'JEE Main', difficulty)
    : buildPracticePrompt(subject, chapters, null, difficulty, null);

  try {
    const reply = await getReply([{ role: 'user', content: qPrompt }], 'Return ONLY valid JSON, no markdown.');
    const q     = safeParseJSON(reply);
    if (!q.question || !q.options || !q.answer) throw new Error('Bad structure');
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

// ── SERVE ─────────────────────────────────────────────────
// All non-API routes → index.html (SPA). If not authenticated, index.html
// must handle redirect to /auth/google for protected pages.
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v7 on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
});
