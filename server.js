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

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ───────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  email:           String,
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
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep', 'ultra'] },
  examDate:        { type: Date, default: null },
  quizXP:          { type: Number, default: 0 },
  quizLevel:       { type: Number, default: 1 },
  totalQSolved:    { type: Number, default: 0 },
  totalQCorrect:   { type: Number, default: 0 },
  quizStreak:      { type: Number, default: 0 },
  maxQuizStreak:   { type: Number, default: 0 },
  achievements:    [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP:        { type: Number, default: 0 },
  weeklyXPReset:   { type: Date, default: Date.now },
  weakTopics:      { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  // NEW: stores feedback irritation flags for adaptive tone
  feedbackFlags:   { type: Map, of: String, default: {} },
  createdAt:       { type: Date, default: Date.now }
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
  // NEW: raw [MISTAKE_START]...[MISTAKE_END] extracted from chat
  mistakeBookEntry: { type: String, default: '' },
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
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true },
  name:      String,
  rating:    Number,
  message:   String,
  type:      { type: String, default: 'exit' },
  // NEW: structured irritation tags parsed from message
  flags:     [String],
  createdAt: { type: Date, default: Date.now }
});

// PYQ bank — verified cache so we never repeat across sessions
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

const User        = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake     = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const Feedback    = mongoose.model('Feedback', feedbackSchema);
const PYQ         = mongoose.model('PYQ', pyqSchema);

// ── SESSION ───────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false, saveUninitialized: false,
  store:  MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
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
        email:    profile.emails[0].value,
        name:     profile.displayName,
        photo:    profile.photos[0]?.value || ''
      });
    }
    const now  = new Date();
    const diff = Math.floor((now - new Date(user.lastActive)) / 86400000);
    if      (diff === 1) user.streak += 1;
    else if (diff > 1)  user.streak  = 1;
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

// ── AUTH GUARD — strictly no guest mode ──────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required', loginUrl: '/auth/google' });
};

// ── API KEYS ──────────────────────────────────────────────
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

// ── HELPERS ───────────────────────────────────────────────
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

// NEW: extract [MISTAKE_START]...[MISTAKE_END] blocks from AI reply
function extractMistakeEntries(text) {
  const matches = [];
  const re      = /\[MISTAKE_START\]([\s\S]*?)\[MISTAKE_END\]/g;
  let m;
  while ((m = re.exec(text)) !== null) matches.push(m[1].trim());
  return matches;
}

// NEW: parse feedback irritation flags from message text
function parseFeedbackFlags(message = '') {
  const flags  = [];
  const lower  = message.toLowerCase();
  if (lower.includes('confus') || lower.includes('unclear') || lower.includes('didn\'t understand'))
    flags.push('USER_FEEDBACK_IRRITATION:confusing_explanation');
  if (lower.includes('too fast') || lower.includes('too quick') || lower.includes('slow down'))
    flags.push('USER_FEEDBACK_IRRITATION:too_fast');
  if (lower.includes('more detail') || lower.includes('step by step') || lower.includes('elaborate'))
    flags.push('USER_REQUESTED_UPGRADE:more_detail');
  if (lower.includes('ncert') || lower.includes('textbook'))
    flags.push('USER_REQUESTED_UPGRADE:ncert_bound');
  return flags;
}

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────
// NEW: full rebuild with Grind AI persona spec, proactive weakness challenge,
//      mistake book markers, feedback irritation adaptation, no guest mode language
function buildSystemPrompt(user, plannerCtx = '', todayMistakes = [], feedbackFlags = []) {
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

  // Build weak topic context for proactive opening challenge
  const wk         = getWeekKey();
  const weakMap     = user?.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user?.weakTopics || {}));
  const weeklyWeak  = [...weakMap.entries()].filter(([, v]) => v?.weeks?.includes(wk)).map(([t]) => t);
  const topWeak     = weeklyWeak.slice(0, 3).join(', ') || 'none identified yet';

  // Build today's mistake context
  const mistakeCtx = todayMistakes.length > 0
    ? `TODAY'S MISTAKE LOG (from this session):\n${todayMistakes.map(m => `- [${m.topic}] ${m.mistakeBookEntry || m.question?.slice(0, 80)}`).join('\n')}`
    : '';

  // Build feedback irritation adaptation directive
  let feedbackAdapt = '';
  if (feedbackFlags.includes('USER_FEEDBACK_IRRITATION:confusing_explanation') || feedbackFlags.includes('USER_FEEDBACK_IRRITATION:too_fast')) {
    feedbackAdapt = 'FEEDBACK ADAPTATION: This student previously flagged explanations as confusing or too fast. You MUST break down every concept mathematically step-by-step. Never skip a single algebraic step. Use numbered substeps.';
  }
  if (feedbackFlags.includes('USER_REQUESTED_UPGRADE:more_detail')) {
    feedbackAdapt += '\nFEEDBACK ADAPTATION: Student requested more detail. Expand every answer to ultra-deep mode regardless of responseSpeed setting.';
  }
  if (feedbackFlags.includes('USER_REQUESTED_UPGRADE:ncert_bound')) {
    feedbackAdapt += '\nFEEDBACK ADAPTATION: Student wants NCERT-grounded answers. Cite exact NCERT chapter/page references and use only NCERT-approved terminology.';
  }

  return `You are GRIND — a premium, brutally honest, hyper-focused academic mentor, senior NTA question setter, and elite exam specialist for Indian IIT-JEE and NEET aspirants.

========================================================
CRITICAL IDENTITY RULES
========================================================
- You are strictly accessible ONLY to authenticated, registered users. There is NO guest mode, NO trial, NO free tier inside this interface. Never mention or offer any.
- You are NOT a generic AI. You are an elite Indian exam specialist. Every response must be anchored in the specific realities of NTA exam patterns.
- Use authentic Indian coaching terminology: NCERT line-by-line, PYQs, Mock Tests, Allen/Aakash/FIITJEE test series, Error Books, Backlogs, Silly Mistakes.

========================================================
STUDENT PROFILE
========================================================
Name: ${name} | Gender: ${gender} (use "${slang}") 
Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || '?'} 
Coaching: ${user?.coaching || 'self-study'} | Biggest Struggle: ${user?.biggestStruggle || '?'}
Weekly Weak Topics: ${topWeak}

RESPONSE SPEED MODE: ${speedMap[speed]}

${feedbackAdapt ? feedbackAdapt + '\n' : ''}
${plannerCtx ? 'PLANNER CONTEXT:\n' + plannerCtx + '\n' : ''}
${mistakeCtx ? mistakeCtx + '\n' : ''}

========================================================
DYNAMIC PROACTIVE SESSION OPENING
========================================================
When this is the first message in a session AND weekly weak topics exist, open the conversation with:
"Welcome back to the Grind. Earlier today, you struggled with [top weak topic]. Let's make sure that concept error is dead before you move forward. Answer this right now: [Insert 1 high-yield conceptual question targeting that exact weakness]."
Do NOT do this on subsequent messages in the same session.

========================================================
LANGUAGE & TONE
========================================================
- Auto-detect and mirror user's language exactly: Hinglish→Hinglish, Telugu-English→Telugu-English, Tamil-English→Tamil-English, Pure Hindi→Pure Hindi. Never translate unless asked.
- Maintain strict, urgent, yet deeply motivating tone. Reference competition: 15-25 lakh+ aspirants, only ~16,000 IIT seats.
- Reference standard books: Physics → HC Verma, Irodov, DC Pandey | Chemistry → MS Chouhan (Organic), Narendra Awasthi (Physical), NCERT (Inorganic) | Biology → NCERT word-for-word.

========================================================
ACADEMIC RESPONSE FORMAT
========================================================
- Format: **Concept Name** → Step-by-Step derivation → ⚡ Shortcut/trick
- Use LaTeX: $inline$ and $$block$$ for ALL math/physics formulas. Never write formulas in plain text.
- After every academic explanation, end with ONE sharp challenge labeled "**YOUR NEXT CHALLENGE:**" — keep the learning loop active until student says: "stop", "enough", "break", "bas", "ruk", "done".
- During normal chat, inject MCQ-style micro-questions: (A) opt1  (B) opt2  (C) opt3  (D) type your own

========================================================
MISTAKE BOOK AUTO-TAGGING (CRITICAL)
========================================================
Whenever you detect a student's calculation error, conceptual gap, or formula misapplication during a chat session:
1. Explain the error rigorously with full derivation.
2. At the END of your technical explanation, append this exact marker block so the backend can extract it:
[MISTAKE_START] Concept: [Name of Topic] | Context: [One sentence — what went wrong and the exact fix] [MISTAKE_END]
This marker must appear for EVERY identified mistake. Never skip it. Never modify the tag format.

========================================================
PYQ & QUIZ GENERATION (when asked to generate questions)
========================================================
DIFFICULTY RULES:
- JEE Main / NEET: Single or dual-concept application problems. Algebraic accuracy, NCERT traps, trick options that punish formula-misapplication.
- JEE Advanced: Deep multi-concept fusion (e.g. Electrostatics + Rotational Dynamics). First-principles thinking, structural visualization, advanced math manipulation.

STRUCTURE MANDATE:
- Match official formats: Single Correct MCQ, Multi-Correct MCQ, Numerical/Integer Type, or Matrix Match. Never create direct formula-substitution questions.
- 3 distractor options must represent EXACT values obtained through common student errors (factor of 1/2 forgotten, sign error, wrong condition applied).

When outputting quiz JSON, use this exact schema (no markdown code blocks):
{
  "questions": [
    {
      "question_text": "problem statement with LaTeX for all math",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_index": 0,
      "explanation": "rigorous step-by-step mathematical derivation"
    }
  ]
}

========================================================
EMOTIONAL SUPPORT MODES
========================================================
1. Burnout/anxiety → validate first, then ONE micro-step only
2. Procrastination → direct, urgent, no lecture
3. Depression/despair → gentle ONLY, never tough-love
4. Crisis (self-harm/suicidal) → STOP all academics immediately. Provide: Kiran: 1800-599-0019 | iCall: 9152987821 | Tele-MANAS: 14416
5. Student numb/crying → STUDYING IS CANCELLED. Focus ONLY on: unlock the door, wash face, drink water, eat dinner.

========================================================
HARD RULES
========================================================
- Address ${name} by name occasionally, use "${slang}" naturally
- NEVER say: "You got this!" / "Believe in yourself!" / "Great question!" — no hollow filler phrases
- NEVER mention guest mode, free trial, or unauthenticated access
- NEVER give passive, vague, or generic answers — always anchor to NTA exam reality`;
}

// ── PYQ GENERATION PROMPT ─────────────────────────────────
function buildPYQPrompt(subject, chapter, exam, difficulty) {
  const chapterLine = chapter ? `Chapter/Topic: ${chapter}.` : '';
  const examLine    = exam
    ? `Exam: ${exam}.`
    : 'Exam: JEE Main or JEE Advanced or NEET (pick whichever has the best real PYQ for this topic).';
  return `You are a verified JEE/NEET question bank with access to all past papers from 2000–2024.

Task: Retrieve ONE real Previous Year Question (PYQ).
Subject: ${subject}. ${chapterLine} ${examLine} Difficulty: ${difficulty || 'medium'}.

STRICT RULES — NEVER VIOLATE:
1. The question MUST have appeared in an actual exam. DO NOT fabricate.
2. Provide the exact year, exact exam name, and exact shift/date it appeared.
3. If you are less than 90% confident the question is real, generate a NEW question matching the style and difficulty of that exam BUT mark "verified": false.
4. The answer MUST match the official answer key.
5. Explanation: concept name + formula + complete step-by-step working.
6. wrongPercent: estimated % of students who historically got it wrong.
7. The 3 wrong options MUST be calculated using common student errors (sign mistake, factor of 2 error, wrong formula variant).

Return ONLY this exact JSON — no markdown, no text outside JSON:
{
  "question": "full question text with all given data",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "answer": "A",
  "explanation": "Step 1: ... Step 2: ... Step 3: ... Final answer: ...",
  "cheatSheet": "one powerful shortcut or formula trick",
  "trapAlert": "specific NTA trap in this type of question or empty string",
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
  const topicLine   = topic   ? `Topic: ${topic}.`     : '';
  const chapterLine = chapter ? `Chapter: ${chapter}.` : '';
  const adaptLine   = adaptiveFocus?.length
    ? `ADAPTIVE MODE: This student previously answered incorrectly on this concept. Generate a fresh question testing the SAME concept from a DIFFERENT angle to build mastery. Focus on: ${adaptiveFocus.join(', ')}.`
    : '';
  return `You are a premium JEE/NEET expert question setter following NTA exam patterns.
Subject: ${subject}. ${chapterLine} ${topicLine} Difficulty: ${difficulty || 'medium'}.
${adaptLine}

Generate ONE high-quality practice MCQ.
Rules:
- Requires at least 3 logical/mathematical steps to solve. No direct formula substitution.
- 3 distractor options must represent values computed from real student errors (wrong sign, missing factor, misapplied condition).
- Include a conceptual trap that punishes shallow knowledge.
- Explanation must include: concept name, formula, full step-by-step working.

Return ONLY this exact JSON — no markdown, no text outside JSON:
{
  "question": "full question text",
  "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
  "answer": "A",
  "explanation": "Concept: ... | Formula: ... | Step 1: ... Step 2: ... Step 3: ... Final: ...",
  "cheatSheet": "one powerful shortcut trick",
  "trapAlert": "specific common mistake or empty string",
  "wrongPercent": 65,
  "year": "",
  "exam": "",
  "shift": "",
  "chapter": "${chapter || subject}",
  "topic": "${topic || chapter || subject}",
  "verified": false
}`;
}

// ── API CALL HELPERS ──────────────────────────────────────
// Optimized for text-only JEE problem solving using deep reasoning models first
// Global Configuration Variableserror.message);
 // =========================
// AI PRIORITY ORDER
// 1. OpenRouter (Best Reasoning)
// 2. Gemini
// 3. Groq
// =========================

async function fetchWithTimeout(url, options, ms = 30000) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, ms);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} - ${text}`);
    }

    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// =========================
// OPENROUTER
// =========================

async function callOR(messages, prompt) {

  const key =
    OPENROUTER_KEYS[orIdx++ % OPENROUTER_KEYS.length];

  const model =
    OPENROUTER_MODELS[orMIdx++ % OPENROUTER_MODELS.length];

  console.log(`🧠 OpenRouter -> ${model}`);

  const response = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://grind-ai.onrender.com",
        "X-Title": "GRIND AI"
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: prompt
          },
          ...messages
        ]
      })
    }
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.choices[0].message.content;
}

// =========================
// GEMINI
// =========================

async function callGemini(
  messages,
  prompt,
  imageBase64 = null
) {

  const key =
    GEMINI_KEYS[gIdx++ % GEMINI_KEYS.length];

  const contents = messages.map(msg => ({
    role:
      msg.role === "assistant"
        ? "model"
        : "user",
    parts: [
      {
        text: msg.content
      }
    ]
  }));

  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];

    if (last.role === "user") {
      last.parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: imageBase64
        }
      });
    }
  }

  console.log("⚡ Gemini");

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: prompt
            }
          ]
        },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4000
        }
      })
    }
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.candidates[0].content.parts[0].text;
}

// =========================
// GROQ
// =========================

async function callGroq(messages, prompt) {

  const key =
    GROQ_KEYS[grIdx++ % GROQ_KEYS.length];

  console.log("🚀 Groq");

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 4000,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content: prompt
          },
          ...messages
        ]
      })
    }
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.choices[0].message.content;
}

// =========================
// MASTER FALLBACK SYSTEM
// =========================

async function getReply(
  messages,
  prompt,
  imageBase64 = null
) {

  // -----------------
  // OPENROUTER FIRST
  // -----------------

  for (
    let i = 0;
    i < OPENROUTER_KEYS.length;
    i++
  ) {
    try {
      return await callOpenRouter(
        messages,
        prompt
      );
    } catch (err) {
      console.log(
        `❌ OpenRouter ${i + 1}:`,
        err.message
      );
    }
  }

  // -----------------
  // GEMINI SECOND
  // -----------------

  for (
    let i = 0;
    i < GEMINI_KEYS.length;
    i++
  ) {
    try {
      return await callGemini(
        messages,
        prompt,
        imageBase64
      );
    } catch (err) {
      console.log(
        `❌ Gemini ${i + 1}:`,
        err.message
      );
    }
  }

  // -----------------
  // GROQ LAST
  // -----------------

  for (
    let i = 0;
    i < GROQ_KEYS.length;
    i++
  ) {
    try {
      return await callGroq(
        messages,
        prompt
      );
    } catch (err) {
      console.log(
        `❌ Groq ${i + 1}:`,
        err.message
      );
    }
  }

  throw new Error(
    "ALL_PROVIDERS_EXHAUSTED"
  );
}

// Text-only pipeline: OpenRouter (Deep Reasoning) -> Gemini -> Groq
async function getReply(messages, prompt, imageBase64 = null) {
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOR(messages, prompt); } 
    catch (e) { console.log(`❌ Primary OR Layer Failure ${i + 1}:`, e.message); }
  }
  
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, prompt); } 
    catch (e) { console.log(`❌ Secondary Gemini Layer Failure ${i + 1}:`, e.message); }
  }
  
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, prompt); } 
    catch (e) { console.log(`❌ Emergency Groq Fallback Activated ${i + 1}:`, e.message); }
  }
  
  throw new Error('ALL_API_ENDPOINTS_EXHAUSTED_FATAL');
}
// TEXT-ONLY ROUTING ENGINE: OpenRouter (Reasoning) -> Gemini -> Groq (Fail-safe)
async function getReply(messages, prompt, imageBase64 = null) {
  // Primary Route: OpenRouter for Deep Reasoning (DeepSeek R1 / o1-mini)
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOR(messages, prompt); } 
    catch (e) { console.log(`❌ Primary OR${i + 1}:`, e.message); }
  }
  
  // Secondary Route: Gemini
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, prompt); } 
    catch (e) { console.log(`❌ Secondary G${i + 1}:`, e.message); }
  }
  
  // Final Route: Groq as the ultimate fail-safe backup
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, prompt); } 
    catch (e) { console.log(`❌ Fail-Safe Backup GR${i + 1}:`, e.message); }
  }
  
  throw new Error('ALL_EXHAUSTED');
}

// ── ACHIEVEMENTS ENGINE ───────────────────────────────────
const ACHIEVEMENTS = [
  { id: 'first_blood',   name: 'First Blood',      icon: '🎯' },
  { id: 'hot_streak_5',  name: 'On Fire!',          icon: '🔥' },
  { id: 'hot_streak_10', name: 'Unstoppable',       icon: '⚡' },
  { id: 'centurion',     name: 'Centurion',         icon: '💯' },
  { id: 'solver_500',    name: 'Problem Destroyer', icon: '🏆' },
  { id: 'level_5',       name: 'Rising Star',       icon: '⭐' },
  { id: 'level_10',      name: 'JEE Warrior',       icon: '⚔️' },
  { id: 'level_20',      name: 'IIT Bound',         icon: '🚀' },
  { id: 'accuracy_90',   name: 'Sniper',            icon: '🎖️' },
];

async function awardXP(userId, xp, correct, newStreak, totalSolved, totalCorrect) {
  const user = await User.findById(userId);
  if (!user) return { newAchievements: [], levelUp: false };
  const oldLevel         = calcLevel(user.quizXP);
  user.quizXP           += xp;
  user.weeklyXP         += xp;
  user.totalQSolved      = totalSolved;
  user.totalQCorrect     = totalCorrect;
  user.quizStreak        = newStreak;
  if (newStreak > user.maxQuizStreak) user.maxQuizStreak = newStreak;
  const newLevel  = calcLevel(user.quizXP);
  user.quizLevel  = newLevel;
  const newAchievements = [];
  const existingIds     = user.achievements.map(a => a.id);
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

// NEW: fetch today's mistakes for a user to pass into system prompt
async function getTodayMistakes(userId) {
  try {
    const today    = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    return await Mistake.find({ userId, createdAt: { $gte: today, $lt: tomorrow } })
      .select('topic mistakeBookEntry question').limit(10).lean();
  } catch { return []; }
}

// NEW: fetch user's feedback flags from DB
async function getUserFeedbackFlags(userId) {
  try {
    const feedbacks = await Feedback.find({ userId }).sort({ createdAt: -1 }).limit(5).lean();
    const allFlags  = feedbacks.flatMap(f => f.flags || []);
    return [...new Set(allFlags)]; // deduplicate
  } catch { return []; }
}

// ── ROUTES ────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date(), version: 'v8' }));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);

app.get('/auth/logout', (req, res) => req.logout(() => res.redirect('/')));

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

// ── MAIN CHAT ─────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, sessionId, imageBase64 } = req.body;
  const user = req.user;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid request.' });

  const recent        = messages.slice(-20);
  const plannerCtx    = await buildPlannerContext(user._id);
  const todayMistakes = await getTodayMistakes(user._id);    // NEW
  const feedbackFlags = await getUserFeedbackFlags(user._id); // NEW

  const prompt = buildSystemPrompt(user, plannerCtx, todayMistakes, feedbackFlags);

  try {
    const reply = await getReply(recent, prompt, imageBase64 || null);

    // NEW: auto-extract [MISTAKE_START]...[MISTAKE_END] blocks and save to DB
    const mistakeEntries = extractMistakeEntries(reply);
    for (const entry of mistakeEntries) {
      try {
        // Parse "Concept: X | Context: Y" format
        const conceptMatch = entry.match(/Concept:\s*([^|]+)/i);
        const contextMatch = entry.match(/Context:\s*(.+)/i);
        const topic   = conceptMatch?.[1]?.trim() || 'General';
        const context = contextMatch?.[1]?.trim() || entry;
        await Mistake.create({
          userId:           user._id,
          topic,
          subject:          user.exam?.includes('NEET') ? 'Biology' : 'General',
          mistakeBookEntry: context,
          question:         context,
          weekKey:          getWeekKey()
        });
        // Also update weakTopics map
        const wk   = getWeekKey();
        const wMap = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
        const ent  = wMap.get(topic) || { count: 0, weeks: [] };
        ent.count += 1;
        if (!ent.weeks.includes(wk)) ent.weeks.push(wk);
        wMap.set(topic, ent);
        await User.findByIdAndUpdate(user._id, { weakTopics: wMap });
      } catch (e) { console.error('Auto-mistake save:', e.message); }
    }

    // Save chat to session
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

    res.json({ reply, autoMistakes: mistakeEntries.length }); // let frontend know how many were auto-logged
  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Our AI is taking a short break. Please try again.' });
  }
});

// ── QUIZ: SOLO QUESTION ───────────────────────────────────
app.post('/api/quiz/question', requireAuth, async (req, res) => {
  const { subject, chapter, topic, difficulty, pyqMode, exam } = req.body;
  const user      = req.user;
  const wk        = getWeekKey();
  const weakMap   = user.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
  const adaptTopics = [];
  for (const [t, v] of weakMap.entries()) {
    if (v?.weeks?.includes(wk)) adaptTopics.push(t);
  }

  const prompt = pyqMode
    ? buildPYQPrompt(subject || 'Physics', chapter, exam, difficulty)
    : buildPracticePrompt(subject || 'Physics', chapter, topic, difficulty, adaptTopics.length ? adaptTopics : null);

  try {
    const reply = await getReply(
      [{ role: 'user', content: prompt }],
      'You are an expert JEE/NEET question generator. Return ONLY valid compact JSON, no markdown, no extra text.'
    );
    const q = safeParseJSON(reply);
    if (!q.question || !q.options || !q.answer) throw new Error('Incomplete structure');
    res.json({ question: q, adaptive: adaptTopics.length > 0, adaptiveTopics: adaptTopics });
  } catch (err) {
    console.error('Quiz gen error:', err.message);
    res.status(500).json({ error: 'Could not generate question. Please try again.' });
  }
});

// ── QUIZ: AWARD XP ────────────────────────────────────────
app.post('/api/quiz/award-xp', requireAuth, async (req, res) => {
  try {
    const { correct, streak, totalSolved, totalCorrect, xpEarned } = req.body;
    const result = await awardXP(req.user._id, xpEarned || (correct ? 10 : 2), correct, streak, totalSolved, totalCorrect);
    res.json(result);
  } catch { res.status(500).json({ error: 'Could not award XP.' }); }
});

// ── QUIZ: LOG WRONG ANSWER ────────────────────────────────
app.post('/api/quiz/log-wrong', requireAuth, async (req, res) => {
  try {
    const { topic, subject, chapter, question, userAnswer, correctAnswer, explanation, cheatSheet, trapAlert, isPYQ, pyqYear, pyqExam, pyqShift } = req.body;
    const wk   = getWeekKey();
    const wMap = req.user.weakTopics instanceof Map ? req.user.weakTopics : new Map(Object.entries(req.user.weakTopics || {}));
    const ent  = wMap.get(topic) || { count: 0, weeks: [], subject, chapter };
    ent.count += 1;
    if (!ent.weeks.includes(wk)) ent.weeks.push(wk);
    wMap.set(topic, ent);
    await User.findByIdAndUpdate(req.user._id, { weakTopics: wMap });
    // Also auto-save to mistake book
    await Mistake.create({
      userId: req.user._id, topic, subject, chapter, question,
      userAnswer, correctAnswer, explanation, cheatSheet, trapAlert,
      isPYQ: isPYQ || false, pyqYear: pyqYear || '', pyqExam: pyqExam || '', pyqShift: pyqShift || '',
      weekKey: wk
    });
    const weeklyWeakTopics = [...wMap.entries()].filter(([, v]) => v.weeks?.includes(wk)).map(([t]) => t);
    res.json({ success: true, weeklyWeakTopics });
  } catch { res.status(500).json({ error: 'Could not log wrong answer.' }); }
});

// ── QUIZ: SYNC WEAK TOPICS ────────────────────────────────
app.post('/api/quiz/sync-weak-topics', requireAuth, async (req, res) => {
  try {
    const { weakTopics } = req.body;
    await User.findByIdAndUpdate(req.user._id, { weakTopics: new Map(Object.entries(weakTopics || {})) });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Could not sync weak topics.' }); }
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
    const m = await Mistake.create({ userId: req.user._id, weekKey: getWeekKey(), ...req.body });
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
    if (view === 'today')          { filter.scheduledDate = { $gte: today, $lt: tomorrow }; filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'week')      { filter.scheduledDate = { $gte: today, $lt: weekEnd };  filter.status = { $in: ['pending', 'completed', 'missed'] }; }
    else if (view === 'completed') { filter.status = 'completed'; }
    else                           { filter.scheduledDate = { $gte: today, $lt: tomorrow }; }
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
Rules: Max 6 tasks if tired, 8 medium, 10 energized. Include breaks. Be realistic.`;
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
// NEW: auto-parses irritation flags and stores them, syncs to user feedbackFlags
app.post('/api/feedback', async (req, res) => {
  try {
    const { message, rating, type } = req.body;
    const flags = parseFeedbackFlags(message || '');
    const fb    = await Feedback.create({
      userId: req.user?._id,
      name:   req.user?.name || 'User',
      rating, message, type, flags
    });
    // Persist flags to user doc for fast access in system prompt
    if (req.user && flags.length > 0) {
      const existing = req.user.feedbackFlags instanceof Map
        ? req.user.feedbackFlags
        : new Map(Object.entries(req.user.feedbackFlags || {}));
      flags.forEach(f => existing.set(f, new Date().toISOString()));
      await User.findByIdAndUpdate(req.user._id, { feedbackFlags: existing });
    }
    res.json({ success: true, flagsDetected: flags });
  } catch { res.status(500).json({ error: 'Could not save feedback.' }); }
});

app.get('/api/admin/feedback', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try { res.json({ feedback: await Feedback.find().sort({ createdAt: -1 }).limit(200) }); }
  catch { res.status(500).json({ error: 'Could not load.' }); }
});

// ── SOCKET.IO MULTIPLAYER QUIZ ROOMS ─────────────────────
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
    player.total  = (player.total || 0) + 1;
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
    const room   = quizRooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || (player.streak || 0) < 3) return;
    player.streak = 0;
    socket.to(code).emit('sabotage-activated', { type, by: player.name });
  });

  socket.on('send-emoji', ({ code, emoji }) => {
    const room   = quizRooms[code];
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
  const room   = quizRooms[code];
  if (!room) return;
  const totalQ = room.config?.questionCount || 10;
  if (room.currentQ >= totalQ) {
    io.to(code).emit('game-over', { players: room.players });
    delete quizRooms[code];
    return;
  }
  const subjects   = room.config?.subjects?.length ? room.config.subjects : ['Physics'];
  const subject    = subjects[room.currentQ % subjects.length];
  const chapters   = room.config?.chapters?.length ? room.config.chapters.join(', ') : '';
  const difficulty = room.config?.difficulty || 'mixed';
  const pyqMode    = room.config?.pyqMode || false;

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

// ── SERVE SPA ─────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v8 on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
});require('dotenv').config();
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

// ── MONGODB ───────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// ── SCHEMAS ───────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:        { type: String, unique: true, sparse: true },
  email:           String,
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
  responseSpeed:   { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep', 'ultra'] },
  examDate:        { type: Date, default: null },
  quizXP:          { type: Number, default: 0 },
  quizLevel:       { type: Number, default: 1 },
  totalQSolved:    { type: Number, default: 0 },
  totalQCorrect:   { type: Number, default: 0 },
  quizStreak:      { type: Number, default: 0 },
  maxQuizStreak:   { type: Number, default: 0 },
  achievements:    [{ id: String, name: String, icon: String, unlockedAt: Date }],
  weeklyXP:        { type: Number, default: 0 },
  weeklyXPReset:   { type: Date, default: Date.now },
  weakTopics:      { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  // NEW: stores feedback irritation flags for adaptive tone
  feedbackFlags:   { type: Map, of: String, default: {} },
  createdAt:       { type: Date, default: Date.now }
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
  // NEW: raw [MISTAKE_START]...[MISTAKE_END] extracted from chat
  mistakeBookEntry: { type: String, default: '' },
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
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', sparse: true },
  name:      String,
  rating:    Number,
  message:   String,
  type:      { type: String, default: 'exit' },
  // NEW: structured irritation tags parsed from message
  flags:     [String],
  createdAt: { type: Date, default: Date.now }
});

// PYQ bank — verified cache so we never repeat across sessions
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

const User        = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Mistake     = mongoose.model('Mistake', mistakeSchema);
const PlannerTask = mongoose.model('PlannerTask', plannerTaskSchema);
const Feedback    = mongoose.model('Feedback', feedbackSchema);
const PYQ         = mongoose.model('PYQ', pyqSchema);

// ── SESSION ───────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'grindai-secret-2025',
  resave: false, saveUninitialized: false,
  store:  MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
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
        email:    profile.emails[0].value,
        name:     profile.displayName,
        photo:    profile.photos[0]?.value || ''
      });
    }
    const now  = new Date();
    const diff = Math.floor((now - new Date(user.lastActive)) / 86400000);
    if      (diff === 1) user.streak += 1;
    else if (diff > 1)  user.streak  = 1;
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

// ── AUTH GUARD — strictly no guest mode ──────────────────
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Login required', loginUrl: '/auth/google' });
};

// ── API KEYS ──────────────────────────────────────────────
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
  'deepseek/deepseek-r1:free',
  'deepseek/deepseek-chat:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'google/gemma-3-27b-it:free'
];

let gIdx = 0, grIdx = 0, orIdx = 0, orMIdx = 0;

// ── HELPERS ───────────────────────────────────────────────
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

// NEW: extract [MISTAKE_START]...[MISTAKE_END] blocks from AI reply
function extractMistakeEntries(text) {
  const matches = [];
  const re      = /\[MISTAKE_START\]([\s\S]*?)\[MISTAKE_END\]/g;
  let m;
  while ((m = re.exec(text)) !== null) matches.push(m[1].trim());
  return matches;
}

// NEW: parse feedback irritation flags from message text
function parseFeedbackFlags(message = '') {
  const flags  = [];
  const lower  = message.toLowerCase();
  if (lower.includes('confus') || lower.includes('unclear') || lower.includes('didn\'t understand'))
    flags.push('USER_FEEDBACK_IRRITATION:confusing_explanation');
  if (lower.includes('too fast') || lower.includes('too quick') || lower.includes('slow down'))
    flags.push('USER_FEEDBACK_IRRITATION:too_fast');
  if (lower.includes('more detail') || lower.includes('step by step') || lower.includes('elaborate'))
    flags.push('USER_REQUESTED_UPGRADE:more_detail');
  if (lower.includes('ncert') || lower.includes('textbook'))
    flags.push('USER_REQUESTED_UPGRADE:ncert_bound');
  return flags;
}

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────
// NEW: full rebuild with Grind AI persona spec, proactive weakness challenge,
//      mistake book markers, feedback irritation adaptation, no guest mode language
function buildSystemPrompt(user, plannerCtx = '', todayMistakes = [], feedbackFlags = []) {
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

  // Build weak topic context for proactive opening challenge
  const wk         = getWeekKey();
  const weakMap     = user?.weakTopics instanceof Map ? user.weakTopics : new Map(Object.entries(user?.weakTopics || {}));
  const weeklyWeak  = [...weakMap.entries()].filter(([, v]) => v?.weeks?.includes(wk)).map(([t]) => t);
  const topWeak     = weeklyWeak.slice(0, 3).join(', ') || 'none identified yet';

  // Build today's mistake context
  const mistakeCtx = todayMistakes.length > 0
    ? `TODAY'S MISTAKE LOG (from this session):\n${todayMistakes.map(m => `- [${m.topic}] ${m.mistakeBookEntry || m.question?.slice(0, 80)}`).join('\n')}`
    : '';

  // Build feedback irritation adaptation directive
  let feedbackAdapt = '';
  if (feedbackFlags.includes('USER_FEEDBACK_IRRITATION:confusing_explanation') || feedbackFlags.includes('USER_FEEDBACK_IRRITATION:too_fast')) {
    feedbackAdapt = 'FEEDBACK ADAPTATION: This student previously flagged explanations as confusing or too fast. You MUST break down every concept mathematically step-by-step. Never skip a single algebraic step. Use numbered substeps.';
  }
  if (feedbackFlags.includes('USER_REQUESTED_UPGRADE:more_detail')) {
    feedbackAdapt += '\nFEEDBACK ADAPTATION: Student requested more detail. Expand every answer to ultra-deep mode regardless of responseSpeed setting.';
  }
  if (feedbackFlags.includes('USER_REQUESTED_UPGRADE:ncert_bound')) {
    feedbackAdapt += '\nFEEDBACK ADAPTATION: Student wants NCERT-grounded answers. Cite exact NCERT chapter/page references and use only NCERT-approved terminology.';
  }

  return `You are GRIND — a premium, brutally honest, hyper-focused academic mentor, senior NTA question setter, and elite exam specialist for Indian IIT-JEE and NEET aspirants.

========================================================
CRITICAL IDENTITY RULES
========================================================
- You are strictly accessible ONLY to authenticated, registered users. There is NO guest mode, NO trial, NO free tier inside this interface. Never mention or offer any.
- You are NOT a generic AI. You are an elite Indian exam specialist. Every response must be anchored in the specific realities of NTA exam patterns.
- Use authentic Indian coaching terminology: NCERT line-by-line, PYQs, Mock Tests, Allen/Aakash/FIITJEE test series, Error Books, Backlogs, Silly Mistakes.

========================================================
STUDENT PROFILE
========================================================
Name: ${name} | Gender: ${gender} (use "${slang}") 
Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || '?'} 
Coaching: ${user?.coaching || 'self-study'} | Biggest Struggle: ${user?.biggestStruggle || '?'}
Weekly Weak Topics: ${topWeak}

RESPONSE SPEED MODE: ${speedMap[speed]}

${feedbackAdapt ? feedbackAdapt + '\n' : ''}
${plannerCtx ? 'PLANNER CONTEXT:\n' + plannerCtx + '\n' : ''}
${mistakeCtx ? mistakeCtx + '\n' : ''}

========================================================
DYNAMIC PROACTIVE SESSION OPENING
========================================================
When this is the first message in a session AND weekly weak topics exist, open the conversation with:
"Welcome back to the Grind. Earlier today, you struggled with [top weak topic]. Let's make sure that concept error is dead before you move forward. Answer this right now: [Insert 1 high-yield conceptual question targeting that exact weakness]."
Do NOT do this on subsequent messages in the same session.

========================================================
LANGUAGE & TONE
========================================================
- Auto-detect and mirror user's language exactly: Hinglish→Hinglish, Telugu-English→Telugu-English, Tamil-English→Tamil-English, Pure Hindi→Pure Hindi. Never translate unless asked.
- Maintain strict, urgent, yet deeply motivating tone. Reference competition: 15-25 lakh+ aspirants, only ~16,000 IIT seats.
- Reference standard books: Physics → HC Verma, Irodov, DC Pandey | Chemistry → MS Chouhan (Organic), Narendra Awasthi (Physical), NCERT (Inorganic) | Biology → NCERT word-for-word.

========================================================
ACADEMIC RESPONSE FORMAT
========================================================
- Format: **Concept Name** → Step-by-Step derivation → ⚡ Shortcut/trick
- Use LaTeX: $inline$ and $$block$$ for ALL math/physics formulas. Never write formulas in plain text.
- After every academic explanation, end with ONE sharp challenge labeled "**YOUR NEXT CHALLENGE:**" — keep the learning loop active until student says: "stop", "enough", "break", "bas", "ruk", "done".
- During normal chat, inject MCQ-style micro-questions: (A) opt1  (B) opt2  (C) opt3  (D) type your own

========================================================
MISTAKE BOOK AUTO-TAGGING (CRITICAL)
========================================================
Whenever you detect a student's calculation error, conceptual gap, or formula misapplication during a chat session:
1. Explain the error rigorously with full derivation.
2. At the END of your technical explanation, append this exact marker block so the backend can extract it:
[MISTAKE_START] Concept: [Name of Topic] | Context: [One sentence — what went wrong and the exact fix] [MISTAKE_END]
This marker must appear for EVERY identified mistake. Never skip it. Never modify the tag format.

========================================================
PYQ & QUIZ GENERATION (when asked to generate questions)
========================================================
DIFFICULTY RULES:
- JEE Main / NEET: Single or dual-concept application problems. Algebraic accuracy, NCERT traps, trick options that punish formula-misapplication.
- JEE Advanced: Deep multi-concept fusion (e.g. Electrostatics + Rotational Dynamics). First-principles thinking, structural visualization, advanced math manipulation.

STRUCTURE MANDATE:
- Match official formats: Single Correct MCQ, Multi-Correct MCQ, Numerical/Integer Type, or Matrix Match. Never create direct formula-substitution questions.
- 3 distractor options must represent EXACT values obtained through common student errors (factor of 1/2 forgotten, sign error, wrong condition applied).

When outputting quiz JSON, use this exact schema (no markdown code blocks):
{
  "questions": [
    {
      "question_text": "problem statement with LaTeX for all math",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_index": 0,
      "explanation": "rigorous step-by-step mathematical derivation"
    }
  ]
}

========================================================
EMOTIONAL SUPPORT MODES
========================================================
1. Burnout/anxiety → validate first, then ONE micro-step only
2. Procrastination → direct, urgent, no lecture
3. Depression/despair → gentle ONLY, never tough-love
4. Crisis (self-harm/suicidal) → STOP all academics immediately. Provide: Kiran: 1800-599-0019 | iCall: 9152987821 | Tele-MANAS: 14416
5. Student numb/crying → STUDYING IS CANCELLED. Focus ONLY on: unlock the door, wash face, drink water, eat dinner.

========================================================
HARD RULES
========================================================
- Address ${name} by name occasionally, use "${slang}" naturally
- NEVER say: "You got this!" / "Believe in yourself!" / "Great question!" — no hollow filler phrases
- NEVER mention guest mode, free trial, or unauthenticated access
- NEVER give passive, vague, or generic answers — always anchor to NTA exam reality`;
}

// ── PYQ GENERATION PROMPT ─────────────────────────────────
function buildPYQPrompt(subject, chapter, exam, difficulty) {
  const chapterLine = chapter ? `Chapter/Topic: ${chapter}.` : '';
  const examLine    = exam
    ? `Exam: ${exam}.`
    : 'Exam: JEE Main or JEE Advanced or NEET (pick whichever has the best real PYQ for this topic).';
  return `You are a verified JEE/NEET question bank with access to all past papers from 2000–2024.

Task: Retrieve ONE real Previous Year Question (PYQ).
Subject: ${subject}. ${chapterLine} ${examLine} Difficulty: ${difficulty || 'medium'}.

STRICT RULES — NEVER VIOLATE:
1. The question MUST have appeared in an actual exam. DO NOT fabricate.
2. Provide the exact year, exact exam name, and exact shift/date it appeared.
3. If you are less than 90% confident the question is real, generate a NEW question matching the style and difficulty of that exam BUT mark "verified": false.
4. The answer MUST match the official answer key.
5. Explanation: concept name + formula + complete step-by-step working.
6. wrongPercent: estimated % of students who historically got it wrong.
7. The 3 wrong options MUST be calculated using common student errors (sign mist
