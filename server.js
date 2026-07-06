require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const mongoose   = require('mongoose');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const http       = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ──────────────────────────────────────────
// MONGODB ENHANCED
// ──────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ──────────────────────────────────────────
// ENHANCED SCHEMAS
// ──────────────────────────────────────────

const userSchema = new mongoose.Schema({
  googleId:             { type: String, unique: true, sparse: true },
  email:                String,
  name:                 { type: String, required: true },
  photo:                { type: String, default: '' },
  gender:               { type: String, default: '' },
  exam:                 { type: String, default: '' },
  class:                { type: String, default: '' },
  coaching:             { type: String, default: '' },
  biggestStruggle:      { type: String, default: '' },
  hoursPerDay:          { type: String, default: '' },
  isOnboarded:          { type: Boolean, default: false },
  streak:               { type: Number, default: 0 },
  lastActive:           { type: Date, default: Date.now },
  responseSpeed:        { type: String, default: 'balanced' },
  examDate:             { type: Date, default: null },
  quizXP:               { type: Number, default: 0 },
  quizLevel:            { type: Number, default: 1 },
  totalQSolved:         { type: Number, default: 0 },
  totalQCorrect:        { type: Number, default: 0 },
  quizStreak:           { type: Number, default: 0 },
  maxQuizStreak:        { type: Number, default: 0 },
  achievements:         [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP:             { type: Number, default: 0 },
  weeklyXPReset:        { type: Date, default: Date.now },
  weakTopics:           { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  strongTopics:         { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  feedbackFlags:        { type: Map, of: String, default: {} },
  shieldsUsedThisMonth: { type: Number, default: 0 },
  shieldResetDate:      { type: Date, default: null },
  lastMoodDate:         { type: String, default: '' },
  dailyChallengeDate:   { type: String, default: '' },
  dailyChallengeXP:     { type: Number, default: 0 },
  comboMultiplier:      { type: Number, default: 1 },
  
  // PRO FEATURES
  studyStartTime:       { type: String, default: '06:00' },
  studyEndTime:         { type: String, default: '22:00' },
  preferredSubjects:    [String],
  learningStyle:        { type: String, enum: ['visual', 'auditory', 'kinesthetic', 'mixed'], default: 'mixed' },
  targetScore:          { type: Number, default: 120 },
  mockTestScore:        { type: Number, default: 0 },
  analyticsView:        { type: String, default: 'dashboard' },
  notificationPrefs:    { dailyGoal: Boolean, mockAlert: Boolean, weakTopicAlert: Boolean },
  studyStreak:          { type: Number, default: 0 },
  totalStudyHours:      { type: Number, default: 0 },
  avgSessionLength:     { type: Number, default: 0 },
  performanceTrend:     [{ date: Date, accuracy: Number, xp: Number }],
  subjectMastery:       { type: Map, of: Number, default: {} },
  chapterMastery:       { type: Map, of: Number, default: {} },
  mockTestAttempts:     { type: Number, default: 0 },
  averageMockScore:     { type: Number, default: 0 },
  powerHours:           [{ dayOfWeek: Number, startTime: String, endTime: String }],
  aiRecommendations:    { type: Map, of: String, default: {} },
  lastAnalyticsUpdate:  { type: Date, default: Date.now },
  premiumActive:        { type: Boolean, default: false },
  premiumExpiresAt:     { type: Date, default: null },
  
  createdAt:            { type: Date, default: Date.now }
});

// Enhanced session schema
const sessionSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:    { type: String, default: 'New Conversation' },
  messages: [{
    role:      { type: String, enum: ['user', 'assistant'] },
    content:   String,
    image:     { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
  }],
  sessionDuration:  { type: Number, default: 0 },
  sessionType:      { type: String, enum: ['doubt', 'concept', 'pnc', 'general'], default: 'general' },
  subjectsDiscussed: [String],
  messagesCount:    { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// New: Mock Test Schema
const mockTestSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:            { type: String, required: true },
  exam:             String,
  totalQuestions:   { type: Number, required: true },
  totalTime:        { type: Number, required: true },
  questionsData:    [mongoose.Schema.Types.Mixed],
  userAnswers:      [String],
  score:            { type: Number, default: 0 },
  accuracy:         { type: Number, default: 0 },
  timeSpent:        { type: Number, default: 0 },
  status:           { type: String, enum: ['in-progress', 'completed', 'abandoned'], default: 'in-progress' },
  subjectWisePerfomance: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  questionAnalysis: [{ questionId: String, correct: Boolean, timeSpent: Number, difficulty: String }],
  aiInsights:       String,
  completedAt:      { type: Date, default: null },
  createdAt:        { type: Date, default: Date.now }
});

// New: Study Session Schema (for time tracking)
const studySessionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:     String,
  chapter:     String,
  startTime:   { type: Date, required: true },
  endTime:     { type: Date, default: null },
  duration:    { type: Number, default: 0 },
  focusScore:  { type: Number, default: 0 },
  tasksCompleted: { type: Number, default: 0 },
  distractions:   { type: Number, default: 0 },
  mood:        { type: Number, min: 1, max: 5, default: 3 },
  notes:       String,
  createdAt:   { type: Date, default: Date.now }
});

// New: Performance Analytics Schema
const analyticsSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:          { type: String, required: true },
  dailyXP:       { type: Number, default: 0 },
  questionsAttempted: { type: Number, default: 0 },
  questionsCorrect:   { type: Number, default: 0 },
  accuracy:      { type: Number, default: 0 },
  studyHours:    { type: Number, default: 0 },
  streak:        { type: Number, default: 0 },
  subjectScores: { type: Map, of: Number, default: {} },
  topicsFocused: [String],
  createdAt:     { type: Date, default: Date.now }
});

// Models
const User             = mongoose.model('User', userSchema);
const ChatSession      = mongoose.model('ChatSession', sessionSchema);
const MockTest         = mongoose.model('MockTest', mockTestSchema);
const StudySession     = mongoose.model('StudySession', studySessionSchema);
const Analytics        = mongoose.model('Analytics', analyticsSchema);

// Keep existing models...
const mistakeSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  questionId:       { type: String, default: '' },
  question:         String,
  subject:          String,
  chapter:          String,
  topic:            String,
  explanation:      String,
  cheatSheet:       { type: String, default: '' },
  trapAlert:        { type: String, default: '' },
  userAnswer:       String,
  correctAnswer:    String,
  note:             { type: String, default: '' },
  isPYQ:            { type: Boolean, default: false },
  pyqYear:          { type: String, default: '' },
  pyqExam:          { type: String, default: '' },
  pyqShift:         { type: String, default: '' },
  weekKey:          { type: String, default: '' },
  mistakeBookEntry: { type: String, default: '' },
  reviewCount:      { type: Number, default: 0 },
  lastReviewDate:   { type: Date, default: null },
  createdAt:        { type: Date, default: Date.now }
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
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true },
  name:      String,
  rating:    Number,
  message:   String,
  type:      { type: String, default: 'exit' },
  flags:     [String],
  createdAt: { type: Date, default: Date.now }
});

const pyqSchema = new mongoose.Schema({
  subject:      String,
  chapter:      String,
  exam:         String,
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

const moodSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mood:   { type: Number, min: 1, max: 5, required: true },
  note:   { type: String, default: '' },
  date:   { type: String, required: true }
}, { timestamps: true });

const formulaSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:     String,
  chapter:     String,
  formula:     { type: String, required: true },
  context:     String,
  nextReview:  { type: Date, default: Date.now },
  interval:    { type: Number, default: 1 },
  repetitions: { type: Number, default: 0 },
  easeFactor:  { type: Number, default: 2.5 }
}, { timestamps: true });

const bossSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:  String,
  chapter:  String,
  type:     { type: String, enum: ['chapter', 'world'], default: 'chapter' },
  score:    Number,
  total:    Number,
  beaten:   { type: Boolean, default: false },
  xpEarned: Number
}, { timestamps: true });

const noteSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title:     { type: String, default: 'Untitled' },
  content:   { type: String, default: '' },
  subject:   { type: String, default: '' },
  pinned:    { type: Boolean, default: false },
  tags:      [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Mistake          = mongoose.model('Mistake', mistakeSchema);
const PlannerTask      = mongoose.model('PlannerTask', plannerTaskSchema);
const Feedback         = mongoose.model('Feedback', feedbackSchema);
const PYQ              = mongoose.model('PYQ', pyqSchema);
const Mood             = mongoose.model('Mood', moodSchema);
const Formula          = mongoose.model('Formula', formulaSchema);
const BossBattle       = mongoose.model('BossBattle', bossSchema);
const Note             = mongoose.model('Note', noteSchema);

// ──────────────────────────────────────────
// SESSION CONFIG
// ──────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false,
  saveUninitialized: false,
  store:  MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ──────────────────────────────────────────
// PASSPORT AUTH
// ──────────────────────────────────────────
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
    if (diff === 1) user.streak += 1;
    else if (diff > 1) user.streak = 1;
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

// ──────────────────────────────────────────
// AUTH GUARD
// ──────────────────────────────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required' });
};

// ──────────────────────────────────────────
// API KEYS
// ──────────────────────────────────────────
const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2,
  process.env.OPENROUTER_KEY_3, process.env.OPENROUTER_KEY_4,
  process.env.OPENROUTER_KEY_5
].filter(Boolean);

const OPENROUTER_MODELS = [
  'deepseek/deepseek-v4-flash:free',
  'nvidia/nemotron-3-ultra:free',
  'meta-llama/llama-3.3-70b:free',
  'openai/gpt-oss-120b:free'
];

let orIdx = 0, orMIdx = 0;

// ──────────────────────────────────────────
// HELPER FUNCTIONS
// ──────────────────────────────────────────
function getWeekKey() {
  const d    = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function calcLevel(xp) { return Math.floor(Math.sqrt(xp / 100)) + 1; }

function safeParseJSON(raw) {
  let clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start !== -1 && end !== -1) clean = clean.slice(start, end + 1);
  return JSON.parse(clean);
}

async function callOR(messages, prompt) {
  const key   = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://grind-ai.com'
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      temperature: 0.4,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function callORStream(messages, prompt, onToken, abortSignal) {
  const key   = OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://grind-ai.com'
    },
    signal: abortSignal,
    body: JSON.stringify({
      model, max_tokens: 4000, temperature: 0.4, stream: true,
      messages: [{ role: 'system', content: prompt }, ...messages]
    })
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
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
        if (delta) { full += delta; onToken(delta); }
      } catch (e) {}
    }
  }
  return full;
}

async function getReply(messages, prompt) {
  return await callOR(messages, prompt);
}

async function getReplyStream(messages, prompt, onToken, abortSignal) {
  return await callORStream(messages, prompt, onToken, abortSignal);
}

// ──────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// ──────────────────────────────────────────
function buildSystemPrompt(user) {
  const name   = user?.name?.split(' ')[0] || 'there';
  const gender = user?.gender || '';
  const slang  = gender === 'female' ? 'bestie' : gender === 'male' ? 'bro' : 'yaar';
  const wk     = getWeekKey();
  const weakMap   = user?.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user?.weakTopics || {}));
  const weeklyWeak = [...weakMap.entries()].filter(([, v]) => v?.weeks?.includes(wk)).map(([t]) => t);

  return `You are GRIND — an elite JEE/NEET AI mentor for ${name}.

STUDENT PROFILE:
- Name: ${name} | Gender: ${gender}
- Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || '?'}
- Coaching: ${user?.coaching || 'self-study'} | Weak topics: ${weeklyWeak.slice(0, 3).join(', ') || 'none'}
- Study hours: ${user?.hoursPerDay || '?'}/day | Biggest struggle: ${user?.biggestStruggle || '?'}

RESPONSE RULES:
1. Use authentic Indian coaching terminology (NCERT, PYQs, Mock Tests, Error Books)
2. Keep responses concise and actionable
3. Use LaTeX for ALL math: $inline$ and \\[block\\]
4. Match their language style
5. Be brutally honest, never generic
6. End with ONE challenge or question to keep learning active
7. Reference specific concepts, not vague advice

EMOTIONAL SUPPORT:
- Burnout: validate, then ONE micro-step only
- Anxiety: gentle, grounded in reality
- Procrastination: direct and urgent
- Depression: stop academics, provide crisis support

You are NOT generic. You are an elite Indian exam specialist. NEVER mention guest mode or free trials.`;
}

// ──────────────────────────────────────────
// ROUTES - AUTH
// ──────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);

app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u._id, name: u.name, email: u.email, photo: u.photo,
      isOnboarded: u.isOnboarded, exam: u.exam, class: u.class,
      quizXP: u.quizXP, quizLevel: u.quizLevel, streak: u.streak,
      weeklyXP: u.weeklyXP, totalStudyHours: u.totalStudyHours,
      mockTestScore: u.mockTestScore, averageMockScore: u.averageMockScore,
      subjectMastery: Object.fromEntries(u.subjectMastery || new Map()),
      premiumActive: u.premiumActive
    }
  });
});

// ──────────────────────────────────────────
// ROUTES - CHAT WITH STREAMING
// ──────────────────────────────────────────
app.post('/api/chat/stream', requireAuth, async (req, res) => {
  const { messages, sessionId } = req.body;
  const user = req.user;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    const recent = messages.slice(-20);
    const prompt = buildSystemPrompt(user);

    let full = '';
    await getReplyStream(recent, prompt, (chunk) => {
      full += chunk;
      send('chunk', { text: chunk });
    }, abortController.signal);

    send('done', { reply: full });
    
    // Save to DB
    if (sessionId && sessionId.length === 24) {
      await ChatSession.findByIdAndUpdate(sessionId, {
        $push: { messages: [{ role: 'user', content: messages[messages.length - 1].content }, 
                           { role: 'assistant', content: full }] },
        $set: { updatedAt: new Date() }
      }, { upsert: true });
    }
    
    res.end();
  } catch (err) {
    if (err.name !== 'AbortError') send('error', { error: 'AI unavailable' });
    res.end();
  }
});

// ──────────────────────────────────────────
// ROUTES - ANALYTICS DASHBOARD (NEW)
// ──────────────────────────────────────────
app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    
    // Fetch all relevant data
    const [studySessions, analytics, mockTests, sessions, mistakes] = await Promise.all([
      StudySession.find({ userId: user._id, startTime: { $gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) } }).lean(),
      Analytics.find({ userId: user._id }).sort({ date: -1 }).limit(30).lean(),
      MockTest.find({ userId: user._id, status: 'completed' }).sort({ completedAt: -1 }).limit(5).lean(),
      ChatSession.find({ userId: user._id }).countDocuments(),
      Mistake.find({ userId: user._id, createdAt: { $gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) } }).lean()
    ]);

    const totalStudyHours = studySessions.reduce((a, s) => a + (s.duration || 0), 0) / 60;
    const avgAccuracy = analytics.length ? (analytics.reduce((a, x) => a + (x.accuracy || 0), 0) / analytics.length).toFixed(2) : 0;
    const xpThisWeek = analytics.length ? analytics.reduce((a, x) => a + (x.dailyXP || 0), 0) : 0;
    const subjectMastery = user.subjectMastery ? Object.fromEntries(user.subjectMastery) : {};
    const topMistakes = mistakes.slice(0, 5).map(m => ({ topic: m.topic, count: m.reviewCount || 0 }));

    res.json({
      summary: {
        level: user.quizLevel,
        xpThisWeek,
        streak: user.streak,
        totalStudyHours: Math.round(totalStudyHours),
        avgAccuracy,
        mockTestsAttempted: mockTests.length
      },
      charts: {
        dailyXP: analytics.map(a => ({ date: a.date, xp: a.dailyXP })),
        accuracy: analytics.map(a => ({ date: a.date, accuracy: a.accuracy })),
        subjectMastery,
        topMistakes
      },
      recentMockTests: mockTests.map(m => ({
        title: m.title,
        score: m.score,
        accuracy: m.accuracy,
        date: m.completedAt
      })),
      recommendations: generateRecommendations(user, mistakes, analytics)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function generateRecommendations(user, mistakes, analytics) {
  const recommendations = [];
  
  const topicErrors = {};
  mistakes.forEach(m => {
    topicErrors[m.topic] = (topicErrors[m.topic] || 0) + 1;
  });
  
  Object.entries(topicErrors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach(([topic, count]) => {
      recommendations.push(`Focus on ${topic} — ${count} mistakes this week`);
    });
  
  if (user.streak > 0) {
    recommendations.push(`Keep the ${user.streak}-day streak alive 🔥`);
  }
  
  if (analytics.length > 0) {
    const lastAccuracy = analytics[0].accuracy;
    if (lastAccuracy < 50) {
      recommendations.push('Revisit weak topics before attempting new ones');
    }
  }
  
  return recommendations.slice(0, 5);
}

// ──────────────────────────────────────────
// ROUTES - MOCK TESTS (NEW)
// ──────────────────────────────────────────
app.post('/api/mock-test/start', requireAuth, async (req, res) => {
  try {
    const { title, exam, subject, duration } = req.body;
    const user = req.user;
    
    // Generate questions
    const prompt = `Generate a complete ${subject} mock test for ${exam}:
    - 20 questions
    - Mixed difficulty (easy/medium/hard)
    - Varied concepts
    Return ONLY JSON:
    {
      "questions": [
        {"id": 1, "question": "...", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A", "difficulty": "medium", "concept": "..."}
      ]
    }`;
    
    const reply = await getReply([{ role: 'user', content: prompt }], 'Return only JSON');
    const data = safeParseJSON(reply);
    
    const mockTest = await MockTest.create({
      userId: user._id,
      title,
      exam,
      totalQuestions: data.questions.length,
      totalTime: duration || 3600,
      questionsData: data.questions,
      userAnswers: [],
      status: 'in-progress'
    });

    res.json({ mockTestId: mockTest._id, questions: data.questions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/mock-test/:id/submit', requireAuth, async (req, res) => {
  try {
    const { answers, timeSpent } = req.body;
    const mockTest = await MockTest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!mockTest) return res.status(404).json({ error: 'Not found' });

    let correct = 0;
    mockTest.userAnswers = answers;
    mockTest.timeSpent = timeSpent;

    mockTest.questionAnalysis = mockTest.questionsData.map((q, i) => ({
      questionId: q.id,
      correct: answers[i] === q.answer,
      timeSpent: 0,
      difficulty: q.difficulty
    }));

    correct = mockTest.questionAnalysis.filter(a => a.correct).length;
    mockTest.score = correct;
    mockTest.accuracy = Math.round((correct / mockTest.totalQuestions) * 100);
    mockTest.status = 'completed';
    mockTest.completedAt = new Date();

    // Calculate subject-wise performance
    const subjectMap = {};
    mockTest.questionsData.forEach((q, i) => {
      const subject = q.subject || 'General';
      if (!subjectMap[subject]) subjectMap[subject] = { correct: 0, total: 0 };
      subjectMap[subject].total++;
      if (answers[i] === q.answer) subjectMap[subject].correct++;
    });

    mockTest.subjectWisePerfomance = subjectMap;

    // Generate AI insights
    const insights = `Score: ${mockTest.score}/${mockTest.totalQuestions} (${mockTest.accuracy}%)
Accuracy: ${mockTest.accuracy}%
Time spent: ${(timeSpent / 60).toFixed(1)} minutes
Weak areas: ${Object.entries(subjectMap)
      .filter(([, v]) => (v.correct / v.total) < 0.6)
      .map(([s]) => s)
      .join(', ') || 'None'}`;

    mockTest.aiInsights = insights;
    await mockTest.save();

    // Update user statistics
    await User.findByIdAndUpdate(req.user._id, {
      mockTestAttempts: (req.user.mockTestAttempts || 0) + 1,
      averageMockScore: ((req.user.averageMockScore || 0) + mockTest.score) / 2,
      $inc: { quizXP: mockTest.score * 5 }
    });

    // Save analytics
    const today = new Date().toISOString().split('T')[0];
    await Analytics.findOneAndUpdate(
      { userId: req.user._id, date: today },
      {
        $inc: { dailyXP: mockTest.score * 5, questionsAttempted: mockTest.totalQuestions, questionsCorrect: correct }
      },
      { upsert: true }
    );

    res.json({
      score: mockTest.score,
      total: mockTest.totalQuestions,
      accuracy: mockTest.accuracy,
      insights: mockTest.aiInsights,
      analysis: mockTest.questionAnalysis
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────
// ROUTES - ADAPTIVE LEARNING (NEW)
// ──────────────────────────────────────────
app.post('/api/adaptive/next-topic', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const wk = getWeekKey();
    
    // Get weak topics
    const weakMap = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
    const weakTopics = [...weakMap.entries()]
      .filter(([, v]) => v?.weeks?.includes(wk))
      .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
      .map(([t]) => t);

    // Get strong topics
    const strongMap = user.strongTopics instanceof Map ? user.strongTopics : new Map(Object.entries(user.strongTopics || {}));
    const strongTopics = [...strongMap.entries()]
      .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
      .map(([t]) => t);

    // Recommend based on learning style
    const recommendation = {
      urgent: weakTopics.slice(0, 2),
      reinforce: strongTopics.slice(0, 2),
      nextChallenge: 'Advanced problem solving',
      estimatedTime: '45 minutes'
    };

    res.json(recommendation);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────
// ROUTES - SESSIONS
// ──────────────────────────────────────────
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt').sort({ updatedAt: -1 }).limit(30);
    res.json({ sessions });
  } catch { res.status(500).json({ error: 'Error loading sessions' }); }
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.create({ userId: req.user._id, title: 'New Chat', messages: [] });
    res.json({ sessionId: s._id });
  } catch { res.status(500).json({ error: 'Error creating session' }); }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.findOne({ _id: req.params.id, userId: req.user._id });
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ session: s });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Error' }); }
});

// ──────────────────────────────────────────
// ROUTES - PERFORMANCE REPORT
// ──────────────────────────────────────────
app.get('/api/report/performance', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const analytics = await Analytics.find({ userId: user._id }).sort({ date: -1 }).limit(30).lean();
    const mistakes = await Mistake.find({ userId: user._id }).lean();

    const subjectStats = {};
    mistakes.forEach(m => {
      if (!subjectStats[m.subject]) subjectStats[m.subject] = { errors: 0, topics: {} };
      subjectStats[m.subject].errors++;
      subjectStats[m.subject].topics[m.topic] = (subjectStats[m.subject].topics[m.topic] || 0) + 1;
    });

    res.json({
      overallAccuracy: analytics.length ? (analytics.reduce((a, x) => a + x.accuracy, 0) / analytics.length).toFixed(2) : 0,
      subjectStats,
      trend: analytics.map(a => ({ date: a.date, accuracy: a.accuracy, xp: a.dailyXP })),
      improvementAreas: Object.entries(subjectStats)
        .sort((a, b) => b[1].errors - a[1].errors)
        .slice(0, 5)
        .map(([subject, data]) => ({ subject, errors: data.errors }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────
// ROUTES - NOTES
// ──────────────────────────────────────────
app.get('/api/notes', requireAuth, async (req, res) => {
  try {
    const notes = await Note.find({ userId: req.user._id }).sort({ pinned: -1, updatedAt: -1 }).lean();
    res.json({ notes });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/notes', requireAuth, async (req, res) => {
  try {
    const note = await Note.create({ userId: req.user._id, title: req.body.title || 'Untitled', content: req.body.content || '' });
    res.json({ note });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const note = await Note.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, 
      { ...req.body, updatedAt: new Date() }, { new: true });
    res.json({ note });
  } catch { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    await Note.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Error' }); }
});

// ──────────────────────────────────────────
// SPA FALLBACK
// ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ──────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI PRO v11 running on port ${PORT}`);
  console.log(`🚀 All PRO features enabled!`);
});
