
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
  createdAt:       { type: Date, default: Date.now }
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
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  question:  { type: String, required: true },
  subject:   { type: String, default: '' },
  topic:     { type: String, default: '' },
  note:      { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
 
const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake = mongoose.model('Mistake', mistakeSchema);
 
// ── SESSION ──────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2024',
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
    // Update streak
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
function buildSystemPrompt(user) {
  const name = user?.name?.split(' ')[0] || 'there';
  const gender = user?.gender || '';
  const slang = gender === 'female' ? 'yaar' : gender === 'male' ? 'bhai' : 'yaar';
  const base = `You are GRIND — an elite AI cognitive coach and JEE/NEET tutor for Indian aspirants. You combine deep academic expertise with emotional intelligence.
 
STUDENT PROFILE:
- Name: ${name}
- Gender: ${gender || 'not specified'} → use "${slang}" naturally
- Exam: ${user?.exam || 'JEE/NEET'}
- Class: ${user?.class || 'not specified'}
- Coaching: ${user?.coaching || 'self-study'}
- Biggest struggle: ${user?.biggestStruggle || 'not specified'}
- Study hours/day: ${user?.hoursPerDay || 'not specified'}
 
ACADEMIC EXPERTISE:
- You know every JEE/NEET topic deeply: Rotational Motion, Electrostatics, Organic GOC, Integration, Genetics, etc.
- For academic questions, use: Concept → Step-by-Step → Shortcut Trick
- For numerical problems, show clear steps with units
- For conceptual: give the intuition FIRST then the formula
- 15-16 lakh students appear for JEE every year. Only 16,000 IIT seats.
- Books you recommend: HC Verma, DC Pandey, MS Chouhan, VK Jaiswal, Cengage, NCERT
 
EMOTIONAL INTELLIGENCE — 3 MODES:
1. COMPASSIONATE MODE (burnout/anxiety/failure): Drop everything. Listen first. Validate. Then ONE micro-step.
2. ACCOUNTABILITY MODE (lazy/procrastinating): Direct, urgent, sharp. No lecture. Just action.
3. MEMORY MODE: Reference past patterns gently. "I notice we talked about this before..."
 
DEPRESSION/CRISIS PROTOCOL:
- If student shows deep despair, worthlessness, crying → NEVER use tough-love. Be gentle and protective.
- If student mentions self-harm or suicide → Stop all academics. Provide: Kiran Helpline: 1800-599-0019, iCall: 9152987821, Tele-MANAS: 14416. Their life > any exam.
 
QUIZ MODE (when testing):
- Ask ONE question at a time
- Give exactly 4 options: A, B, C, D
- Include: ⏱️ Target Time, 🔥 % of students who got it wrong, ⚡ Topper's Cheat Sheet
- If wrong answer: add "📑 Save to Mistake Book?" option
- If question has traps: add 🚨 NTA Trap Alert
 
PLANNER MODE (when asked for schedule):
- Never give 8+ hour plans to burnt-out students
- Use 45-min sprints + 10-min breaks
- Include 30-min quick revision block
- End with 3 clickable options for the student
 
BRAIN DUMP MODE:
- If student is anxious/distracted, say: "Type every worry out. Don't filter. Just empty your mind."
- Then validate, filter, and help them start fresh.
 
RESPONSE RULES:
- Address ${name} by name occasionally
- Use ${slang} naturally in Hinglish when it fits
- Light, warm tone — supportive but real
- No hollow phrases like "You got this!" or "Believe in yourself!"
- No [WIN:], [FOCUS:], [RESTART:] tags — those feel forced
- Keep responses focused and warm
- For academic questions: be precise, use **bold** for key terms
- Medium length by default — not too short, not essay-length`;
  return base;
}
 
// ── API HELPERS ──────────────────────────────────────────
async function fetchWithTimeout(url, options, ms = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer); return res;
  } catch (err) { clearTimeout(timer); throw err; }
}
 
async function callGemini(messages, systemPrompt) {
  const key = GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:generateContent?key=${key}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: 600, temperature: 0.85 }
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('GEMINI: ' + data.error.message);
  return data.candidates[0].content.parts[0].text;
}
 
async function callGroq(messages, systemPrompt) {
  const key = GROQ_KEYS[grIdx++ % GROQ_KEYS.length];
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: 600,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
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
      model, max_tokens: 600,
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error('OPENROUTER: ' + data.error.message);
  return data.choices[0].message.content;
}
 
async function getAIReply(messages, systemPrompt) {
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, systemPrompt); }
    catch (err) { console.log(`❌ Gemini ${i+1}:`, err.message); }
  }
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, systemPrompt); }
    catch (err) { console.log(`❌ Groq ${i+1}:`, err.message); }
  }
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOpenRouter(messages, systemPrompt); }
    catch (err) { console.log(`❌ OpenRouter ${i+1}:`, err.message); }
  }
  throw new Error('ALL_KEYS_EXHAUSTED');
}
 
// ── AUTH ROUTES ──────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive' }));
 
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
 
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);
 
app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));
 
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: {
    id: req.user._id, name: req.user.name, email: req.user.email,
    photo: req.user.photo, isOnboarded: req.user.isOnboarded,
    exam: req.user.exam, class: req.user.class, coaching: req.user.coaching,
    gender: req.user.gender, streak: req.user.streak
  }});
});
 
// ── ONBOARDING ───────────────────────────────────────────
app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;
    await User.findByIdAndUpdate(req.user._id, {
      exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender, isOnboarded: true
    });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
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
 
// ── MAIN CHAT ROUTE ──────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId, isGuest } = req.body;
  const user = req.user;
 
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
 
  const recentMessages = messages.slice(-15);
  const systemPrompt = buildSystemPrompt(user);
 
  try {
    const reply = await getAIReply(recentMessages, systemPrompt);
 
    // Save to MongoDB if logged in
    if (user && sessionId && sessionId !== 'guest') {
      try {
        const userMsg = messages[messages.length - 1];
        // Auto-generate title from first message
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
    res.status(500).json({ error: 'Our AI is taking a short break. Please try again in a moment.' });
  }
});
 
// ── NEW SESSION ──────────────────────────────────────────
app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.create({ userId: req.user._id, title: 'New Conversation', messages: [] });
    res.json({ sessionId: session._id });
  } catch { res.status(500).json({ error: 'Could not create session.' }); }
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
    const { question, subject, topic, note } = req.body;
    const mistake = await Mistake.create({ userId: req.user._id, question, subject, topic, note });
    res.json({ mistake });
  } catch { res.status(500).json({ error: 'Could not save to mistake book.' }); }
});
 
app.delete('/api/mistakes/:id', requireAuth, async (req, res) => {
  try {
    await Mistake.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not delete.' }); }
});
 
// ── SOCKET.IO QUIZ ROOMS ─────────────────────────────────
const quizRooms = {};
 
io.on('connection', (socket) => {
  socket.on('create-room', ({ name, subject }) => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    quizRooms[code] = {
      host: socket.id, subject,
      players: [{ id: socket.id, name, score: 0, streak: 0 }],
      started: false, currentQ: 0, sabotages: {}
    };
    socket.join(code);
    socket.emit('room-created', { code });
    io.to(code).emit('players-update', quizRooms[code].players);
  });
 
  socket.on('join-room', ({ code, name }) => {
    const room = quizRooms[code];
    if (!room) return socket.emit('room-error', 'Room not found.');
    if (room.started) return socket.emit('room-error', 'Game already started.');
    room.players.push({ id: socket.id, name, score: 0, streak: 0 });
    socket.join(code);
    socket.emit('room-joined', { code, subject: room.subject });
    io.to(code).emit('players-update', room.players);
  });
 
  socket.on('start-game', ({ code }) => {
    const room = quizRooms[code];
    if (!room || room.host !== socket.id) return;
    room.started = true;
    io.to(code).emit('game-started');
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
  const prompt = `Generate a JEE/NEET MCQ question for subject: ${room.subject}. Return ONLY valid JSON:
{"question":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"A","explanation":"...","cheatSheet":"...","trapAlert":"...","wrongPercent":65}`;
  try {
    const reply = await getAIReply([{ role: 'user', content: prompt }], 'You are a JEE/NEET question generator. Return only valid JSON, no markdown.');
    const clean = reply.replace(/```json|```/g, '').trim();
    const qData = JSON.parse(clean);
    room.currentAnswer = qData.answer;
    io.to(code).emit('new-question', { ...qData, timeLimit: 30 });
    setTimeout(() => {
      io.to(code).emit('question-ended', { correctAnswer: qData.answer, explanation: qData.explanation, cheatSheet: qData.cheatSheet });
      setTimeout(() => {
        room.currentQ++;
        if (room.currentQ < 10) startQuestion(code);
        else io.to(code).emit('game-over', { players: room.players });
      }, 5000);
    }, 30000);
  } catch (err) {
    console.error('Quiz question error:', err.message);
    io.to(code).emit('quiz-error', 'Question generation failed. Try again.');
  }
}
 
// ── SERVE ────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v4 running on port ${PORT}`);
  console.log(`🔑 Keys: Gemini=${GEMINI_KEYS.length} Groq=${GROQ_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
});
