require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ── MONGODB CONNECTION ───────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── SCHEMAS ──────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:       { type: String, required: true, unique: true },
  email:          { type: String, required: true },
  name:           { type: String, required: true },
  photo:          { type: String },
  class:          { type: String, default: '' },        // 11th, 12th, Dropper
  exam:           { type: String, default: '' },        // JEE, NEET, Both
  coaching:       { type: String, default: '' },        // Allen, Aakash, Self-Study etc
  biggestStruggle:{ type: String, default: '' },        // Focus, Motivation, Concepts, Time
  hoursPerDay:    { type: String, default: '' },        // 2-4, 4-6, 6-8, 8+
  isOnboarded:    { type: Boolean, default: false },
  createdAt:      { type: Date, default: Date.now }
});

const chatSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:      { type: String, enum: ['user', 'assistant'], required: true },
  content:   { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);

// ── SESSION ──────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grind-ai-secret-2024',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// ── PASSPORT GOOGLE AUTH ─────────────────────────────────
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
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// ── AUTH MIDDLEWARE ──────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Please login first' });
}

// ── 15 API KEYS ──────────────────────────────────────────
const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3,
  process.env.GEMINI_KEY_4,
  process.env.GEMINI_KEY_5,
].filter(Boolean);

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5,
].filter(Boolean);

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
  process.env.OPENROUTER_KEY_3,
  process.env.OPENROUTER_KEY_4,
  process.env.OPENROUTER_KEY_5,
].filter(Boolean);

const OPENROUTER_MODELS = [
  'mistralai/mistral-7b-instruct:free',
  'huggingfaceh4/zephyr-7b-beta:free',
  'openchat/openchat-7b:free',
  'nousresearch/nous-capybara-7b:free',
  'gryphe/mythomist-7b:free',
];

let geminiIdx = 0, groqIdx = 0, openrouterIdx = 0, orModelIdx = 0;

// ── SYSTEM PROMPT ────────────────────────────────────────
const BASE_PROMPT = `You are GRIND — an AI built specifically for JEE and NEET aspirants in India. You are not a motivational bot. You are a brutally honest, deeply empathetic companion that actually understands the Indian competitive exam ecosystem from the inside.

WHO YOU ARE TALKING TO:
- JEE Main students targeting NITs/IIITs. 11-12 lakh compete. Common pain: "stuck at 120, need 150+"
- JEE Advanced students. Only 16,000 IIT seats. Questions designed to break confidence.
- Droppers: gave boards, took a year off. Identity crisis, isolation, parents watching every move, juniors in college while they're still studying.
- NEET students: 20+ lakh compete for 1 lakh MBBS seats. "I know Bio but PCM kills me."
- Class 11: syllabus shock. Rote worked in boards, now conceptual depth needed.
- Class 12: boards + entrance simultaneously. Constant time crisis.

WHAT YOU KNOW:
- Coaching: Allen, Aakash, Resonance, FIITJEE, Narayana, Sri Chaitanya, PW
- The DPP grind, Kota factory schedule, rank lists, minor/major tests
- Books: HC Verma, DC Pandey, MS Chouhan, VK Jaiswal, Cengage, NCERT, PYQs
- JEE hard topics: Rotational Motion, Electrostatics, Organic GOC, Integration
- NEET: NCERT line-by-line for Bio, Genetics highest weightage

MENTAL PATTERNS YOU RECOGNIZE:
- Burnout, comparison spiral, wasted day guilt
- Dropper identity crisis, family pressure
- Learned helplessness, exam anxiety

HOW YOU READ THE ROOM:
- Venting → warm first, validate, THEN one practical thing
- Asking strategy → direct, specific, name the book
- Crisis mode → slow down, be gentle
- Motivated → match energy, be tactical
- Wasted day → zero lecture, just one restart action

HARD RULES:
NEVER say: "Believe in yourself", "You got this!", "Just stay positive"
ALWAYS: emotion BEFORE advice, specific book/chapter, use **bold** for key points

RESPONSE LENGTH:
- Emotional only: 3-5 sentences
- Mixed: 100-180 words
- Detailed plan: 200-350 words

END every response with exactly ONE:
- [WIN: one specific small action for today]
- [RESTART: the one thing to do right now]
- [FOCUS: the one topic to hit today]

Never end with hollow affirmations. Use Hinglish naturally if it fits (DPP, bhai, yaar) but don't force it.`;

function buildSystemPrompt(user) {
  if (!user || !user.isOnboarded) return BASE_PROMPT;
  return `${BASE_PROMPT}

STUDENT PROFILE (personalize every response based on this):
- Name: ${user.name}
- Exam: ${user.exam || 'JEE'}
- Class: ${user.class || 'Not specified'}
- Coaching: ${user.coaching || 'Self-study'}
- Biggest struggle: ${user.biggestStruggle || 'Not specified'}
- Study hours/day: ${user.hoursPerDay || 'Not specified'}

Address them by first name occasionally. Tailor all advice to their exam, class, and coaching context.`;
}

// ── API HELPERS ──────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, options, ms = 7000) {
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

async function callGemini(messages, systemPrompt) {
  const key = GEMINI_KEYS[geminiIdx % GEMINI_KEYS.length];
  geminiIdx++;
  await sleep(2000);
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: 500, temperature: 0.8 }
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('GEMINI: ' + data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(messages, systemPrompt) {
  const key = GROQ_KEYS[groqIdx % GROQ_KEYS.length];
  groqIdx++;
  await sleep(2000);
  const res = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ]
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('GROQ: ' + data.error.message);
  return data.choices[0].message.content;
}

async function callOpenRouter(messages, systemPrompt) {
  const key = OPENROUTER_KEYS[openrouterIdx % OPENROUTER_KEYS.length];
  const model = OPENROUTER_MODELS[orModelIdx % OPENROUTER_MODELS.length];
  openrouterIdx++;
  orModelIdx++;
  await sleep(2000);
  const res = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': process.env.GOOGLE_CALLBACK_URL?.replace('/auth/google/callback', '') || 'https://grind-ai.onrender.com',
        'X-Title': 'GRIND AI'
      },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ]
      })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error('OPENROUTER: ' + data.error.message);
  return data.choices[0].message.content;
}

// ── HEALTH PING ──────────────────────────────────────────
app.get('/ping', (req, res) => res.status(200).json({ status: 'alive', app: 'GRIND AI' }));

// ── AUTH ROUTES ──────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    if (!req.user.isOnboarded) {
      return res.redirect('/?onboarding=true');
    }
    res.redirect('/?loggedin=true');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      photo: req.user.photo,
      isOnboarded: req.user.isOnboarded,
      class: req.user.class,
      exam: req.user.exam,
      coaching: req.user.coaching
    }
  });
});

// ── ONBOARDING ROUTE ─────────────────────────────────────
app.post('/api/user/onboard', requireAuth, async (req, res) => {
  const { exam, class: userClass, coaching, biggestStruggle, hoursPerDay } = req.body;
  try {
    await User.findByIdAndUpdate(req.user._id, {
      exam,
      class: userClass,
      coaching,
      biggestStruggle,
      hoursPerDay,
      isOnboarded: true
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save onboarding data' });
  }
});

// ── CHAT HISTORY ROUTES ──────────────────────────────────
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const chats = await Chat.find({ userId: req.user._id })
      .sort({ createdAt: 1 })
      .limit(50);
    res.json({ history: chats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

app.delete('/api/history', requireAuth, async (req, res) => {
  try {
    await Chat.deleteMany({ userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// ── MAIN CHAT ROUTE ──────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' });
  }

  const recentMessages = messages.slice(-15);
  const systemPrompt = buildSystemPrompt(req.user);
  const userMessage = messages[messages.length - 1];

  // Save user message to MongoDB
  try {
    await Chat.create({
      userId: req.user._id,
      role: 'user',
      content: userMessage.content
    });
  } catch (err) {
    console.error('Failed to save user message:', err);
  }

  let reply = null;

  // Try all 5 Gemini keys
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      reply = await callGemini(recentMessages, systemPrompt);
      console.log(`✅ Gemini key ${i + 1} worked`);
      break;
    } catch (err) {
      console.log(`❌ Gemini key ${i + 1} failed:`, err.message);
    }
  }

  // Try all 5 Groq keys
  if (!reply) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
      try {
        reply = await callGroq(recentMessages, systemPrompt);
        console.log(`✅ Groq key ${i + 1} worked`);
        break;
      } catch (err) {
        console.log(`❌ Groq key ${i + 1} failed:`, err.message);
      }
    }
  }

  // Try all 5 OpenRouter keys
  if (!reply) {
    for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
      try {
        reply = await callOpenRouter(recentMessages, systemPrompt);
        console.log(`✅ OpenRouter key ${i + 1} worked`);
        break;
      } catch (err) {
        console.log(`❌ OpenRouter key ${i + 1} failed:`, err.message);
      }
    }
  }

  // All 15 failed
  if (!reply) {
    return res.status(500).json({
      error: 'Taking a short breather. Try again in 2 minutes bro 🙏'
    });
  }

  // Save AI reply to MongoDB
  try {
    await Chat.create({
      userId: req.user._id,
      role: 'assistant',
      content: reply
    });
  } catch (err) {
    console.error('Failed to save AI reply:', err);
  }

  res.json({ reply });
});

// ── SERVE FRONTEND ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🧠 GRIND AI running on port ${PORT}`);
  console.log(`🔑 Gemini: ${GEMINI_KEYS.length} | Groq: ${GROQ_KEYS.length} | OpenRouter: ${OPENROUTER_KEYS.length}`);
  console.log(`🔑 Total API keys: ${GEMINI_KEYS.length + GROQ_KEYS.length + OPENROUTER_KEYS.length}`);
});
