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
  createdAt:            { type: Date, default: Date.now },
  shieldsUsedThisMonth: { type: Number, default: 0 },
  shieldResetDate:      { type: Date, default: null },
  examDate:             { type: Date, default: null },
  lastMoodDate:         { type: String, default: '' }
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
  'deepseek/deepseek-v4-flash:free',      // Top-tier free chain-of-thought reasoning for STEM
  'deepseek/deepseek-r1-distill:free',    // Deep math, analysis, and problem-solving architecture
  'openai/gpt-oss-20b:free',              // Excellent open frontier multi-step logic
  'zhipu/glm-5.1:free',                   // Advanced scientific and mathematical benchmark performer
  'google/gemma-4-31b:free',              // Google's latest high-capacity open-weight logic model
  'meta-llama/llama-3.3-70b:free',        // Highly reliable for complex conceptual physics/chemistry
  'openrouter/free' 
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

// ══════════════════════════════════════════════════
// AI ROUTING ENGINE: OpenRouter → Gemini → Groq
// ══════════════════════════════════════════════════
async function getReply(messages, prompt, imageBase64 = null) {
  // 1st: OpenRouter (DeepSeek R1 — best free reasoning)
  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    try { return await callOR(messages, prompt); }
    catch (e) { console.log(`❌ OR${i+1}:`, e.message); }
  }
  // 2nd: Gemini (image support)
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try { return await callGemini(messages, prompt, imageBase64); }
    catch (e) { console.log(`❌ Gemini${i+1}:`, e.message); }
  }
  // 3rd: Groq fallback
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try { return await callGroq(messages, prompt); }
    catch (e) { console.log(`❌ Groq${i+1}:`, e.message); }
  }
  throw new Error('ALL_EXHAUSTED — check API keys');
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

// ══════════════════════════════════════════════════════════════════
// NEW SCHEMAS
// ══════════════════════════════════════════════════════════════════
const moodSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  mood:   { type: Number, min: 1, max: 5, required: true },
  note:   { type: String, default: '' },
  date:   { type: String, required: true }
}, { timestamps: true });
const Mood = mongoose.model('Mood', moodSchema);

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
const Formula = mongoose.model('Formula', formulaSchema);

const bossSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:  String,
  chapter:  String,
  type:     { type: String, enum: ['chapter','world'], default: 'chapter' },
  score:    Number,
  total:    Number,
  beaten:   { type: Boolean, default: false },
  xpEarned: Number
}, { timestamps: true });
const BossBattle = mongoose.model('BossBattle', bossSchema);

const storySessionSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  subject:      String,
  chapter:      String,
  exam:         String,
  questions:    [mongoose.Schema.Types.Mixed],
  round1Score:  Number,
  round2Score:  Number,
  improvement:  Number,
  xpEarned:     Number,
  wrongConcepts:[String]
}, { timestamps: true });
const StorySession = mongoose.model('StorySession', storySessionSchema);

// ══════════════════════════════════════════════════════════════════
// JEE PYQ DATABASE — seed from GitHub repo data into MongoDB
// ══════════════════════════════════════════════════════════════════
// Run once: POST /api/admin/seed-pyqs?key=ADMIN_KEY to populate
app.post('/api/admin/seed-pyqs', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  try {
    // The jee_mains_pyqs_data_base GitHub repo stores questions as JSON
    // We fetch directly from raw GitHub and store in MongoDB PYQ collection
    const baseUrl = 'https://raw.githubusercontent.com/HostServer001/jee_mains_pyqs_data_base/main';
    const subjects = ['physics','chemistry','mathematics'];
    let totalSeeded = 0;
    for (const subj of subjects) {
      try {
        const r = await fetch(`${baseUrl}/${subj}.json`);
        if (!r.ok) continue;
        const questions = await r.json();
        const arr = Array.isArray(questions) ? questions : Object.values(questions).flat();
        for (const q of arr) {
          await PYQ.findOneAndUpdate(
            { question: q.question?.slice(0,80) },
            {
              subject:      subj.charAt(0).toUpperCase() + subj.slice(1),
              chapter:      q.chapter || q.topic || '',
              exam:         q.exam || 'JEE Main',
              year:         String(q.year || ''),
              shift:        q.shift || '',
              question:     q.question || '',
              options:      q.options || [],
              answer:       q.answer || q.correct_answer || '',
              explanation:  q.explanation || q.solution || '',
              cheatSheet:   q.key_concept || '',
              trapAlert:    q.trap || '',
              wrongPercent: q.wrong_percent || null,
              verified:     true
            },
            { upsert: true, new: true }
          );
          totalSeeded++;
        }
      } catch(e) { console.log(`Skip ${subj}:`, e.message); }
    }
    res.json({ success: true, totalSeeded });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get PYQs from MongoDB for a chapter (with AI fallback)
app.post('/api/pyqs/chapter', requireAuth, async (req, res) => {
  const { subject, chapter, exam, count = 8 } = req.body;
  try {
    // Try MongoDB first
    const regex = new RegExp(chapter, 'i');
    let dbQs = await PYQ.find({
      subject: new RegExp(subject, 'i'),
      $or: [{ chapter: regex }, { question: regex }],
      ...(exam && exam !== 'All' ? { exam: new RegExp(exam, 'i') } : {})
    }).limit(count * 3).lean();

    // Shuffle and pick count
    dbQs = dbQs.sort(() => Math.random() - 0.5).slice(0, count);

    if (dbQs.length >= 4) {
      return res.json({ questions: dbQs, source: 'database' });
    }

    // Fallback: AI generates PYQ-style questions
    const prompt = `Generate exactly ${count} real JEE PYQ-style questions for:
Subject: ${subject} | Chapter: ${chapter} | Exam: ${exam || 'JEE Main'}

Cover DIFFERENT sub-concepts across all ${count} questions. No repetition.
Include questions from JEE Main AND JEE Advanced where relevant.
Return ONLY JSON (no markdown):
{
  "questions": [
    {
      "id": 1,
      "concept": "sub-concept name",
      "question": "full question text with all given data",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "answer": "A",
      "explanation": "complete step-by-step solution",
      "cheatSheet": "key formula or trick to remember",
      "trapAlert": "common mistake students make or empty string",
      "year": "2022",
      "exam": "JEE Main",
      "wrongPercent": 65
    }
  ]
}`;
    const raw = await getReply([{ role:'user', content: prompt }],
      'Return ONLY valid JSON. No markdown. No extra text.');
    const data = safeParseJSON(raw);
    if (!data.questions?.length) throw new Error('No questions from AI');

    // Cache AI questions to DB for future use
    for (const q of data.questions) {
      await PYQ.create({
        subject, chapter, exam: q.exam || exam,
        year: q.year || '', question: q.question,
        options: q.options, answer: q.answer,
        explanation: q.explanation, cheatSheet: q.cheatSheet,
        trapAlert: q.trapAlert, wrongPercent: q.wrongPercent,
        verified: false
      }).catch(() => {});
    }

    res.json({ questions: data.questions, source: 'ai-generated' });
  } catch(e) {
    console.error('PYQ chapter:', e.message);
    res.status(500).json({ error: 'Could not load questions. Try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// STORY MODE (4 ACTs — Reverse Engineering PYQ Learning)
// ══════════════════════════════════════════════════════════════════
app.post('/api/story/questions', requireAuth, async (req, res) => {
  const { subject, chapter, exam } = req.body;
  if (!chapter) return res.status(400).json({ error: 'Chapter is required.' });
  try {
    // Use MongoDB PYQ bank first
    const r = await fetch(`http://localhost:${process.env.PORT || 3000}/api/pyqs/chapter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': req.headers.cookie || '' },
      body: JSON.stringify({ subject, chapter, exam, count: 8 })
    });
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/story/teach', requireAuth, async (req, res) => {
  const { subject, chapter, questions, round1Answers, score } = req.body;
  const user = req.user;
  const name = user?.name?.split(' ')[0] || 'bhai';

  const wrongQs = (questions || []).filter((q, i) => round1Answers[i] !== q.answer);
  const rightQs = (questions || []).filter((q, i) => round1Answers[i] === q.answer);
  const wrongConcepts = wrongQs.map(q => q.concept || q.chapter).join(', ') || 'a few concepts';

  const prompt = `You are GRIND — a warm IITian senior mentor teaching ${name}.

STUDENT JUST SCORED: ${score}/8 on ${chapter} (${subject}) — BEFORE learning.
GOT WRONG: ${wrongConcepts}
GOT RIGHT: ${rightQs.map(q=>q.concept||'').join(', ') || 'none'}

YOUR JOB: Teach them everything they need to ace the SAME questions in Round 2.

FORMAT YOUR RESPONSE LIKE THIS:

## 🎯 Let's Fix What Tripped You Up

[Teach each WRONG concept first — give the core idea, a solved example similar to the question, and the key trick]

## 📚 The Full Picture — ${chapter}

[Now complete the chapter — cover remaining concepts they need for JEE]

## ⚡ Your Cheat Sheet

[3-5 bullet points: formulas, patterns, what JEE loves to ask from this chapter]

## 🔄 You're Ready for Round 2

[One warm sentence of encouragement — not fake, genuine]

RULES:
- Use LaTeX for math: $inline$ and $$block$$  
- Talk like a real person, not a textbook
- Keep each section tight and useful — no padding
- ${name} recently recovered from a rough time — be warm, never harsh`;

  try {
    const teaching = await getReply([{ role:'user', content: prompt }],
      `You are GRIND — warm IITian mentor. Teach ${chapter} targeting wrong answers first. Use LaTeX for math.`);

    // Auto-save wrong answers to Mistake Book
    for (const q of wrongQs) {
      await Mistake.create({
        userId: user._id, topic: q.concept || chapter,
        subject, chapter, question: q.question,
        correctAnswer: q.answer, explanation: q.explanation || '',
        cheatSheet: q.cheatSheet || '', isPYQ: true,
        pyqYear: q.year || '', pyqExam: q.exam || '',
        weekKey: getWeekKey(),
        mistakeBookEntry: `${q.concept}: ${(q.explanation||'').slice(0,120)}`
      }).catch(()=>{});
    }

    res.json({ teaching, wrongConcepts: wrongQs.map(q => q.concept || '') });
  } catch(e) { res.status(500).json({ error: 'Could not generate teaching. Try again.' }); }
});

app.post('/api/story/complete', requireAuth, async (req, res) => {
  try {
    const { subject, chapter, exam, questions, round1Score, round2Score } = req.body;
    const improvement = round2Score - round1Score;
    const xp = Math.max(20, improvement * 20 + round2Score * 8 + 10);
    const wrongConcepts = (questions||[])
      .filter((q,i) => (req.body.round2Answers||[])[i] !== q.answer)
      .map(q => q.concept || '');

    await StorySession.create({
      userId: req.user._id, subject, chapter, exam,
      questions: questions?.map(q=>({question:q.question,concept:q.concept,answer:q.answer})),
      round1Score, round2Score, improvement, xpEarned: xp, wrongConcepts
    });

    const result = await awardXP(
      req.user._id, xp,
      round2Score > round1Score,
      req.user.quizStreak + 1,
      req.user.totalQSolved + 8,
      req.user.totalQCorrect + round2Score
    );

    const msg = improvement >= 5 ? `🔥 ${improvement} more correct after learning. That's the method working.`
              : improvement >= 3 ? `📈 +${improvement} — solid. Repetition will push this further.`
              : improvement >= 1 ? `👍 +${improvement} — you're building. Come back tomorrow.`
              : round2Score >= 6 ? `💎 Already strong on this chapter. Move to the next.`
              : `🔄 Attempt this chapter again in 2 days — it'll click.`;

    res.json({ ...result, improvement, xpEarned: xp, message: msg });
  } catch(e) { res.status(500).json({ error: 'Could not save results.' }); }
});

app.get('/api/story/history', requireAuth, async (req, res) => {
  try {
    const sessions = await StorySession.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(20).lean();
    res.json({ sessions });
  } catch(e) { res.status(500).json({ error: 'Could not load history.' }); }
});

// ══════════════════════════════════════════════════════════════════
// MOOD CHECK-IN
// ══════════════════════════════════════════════════════════════════
app.post('/api/mood', requireAuth, async (req, res) => {
  try {
    const { mood, note } = req.body;
    const date = new Date().toISOString().split('T')[0];
    await Mood.findOneAndUpdate(
      { userId: req.user._id, date },
      { mood, note: note||'', userId: req.user._id, date },
      { upsert: true, new: true }
    );
    await User.findByIdAndUpdate(req.user._id, { lastMoodDate: date });

    const last3 = await Mood.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(3).lean();
    const recoveryMode = last3.length >= 3 && last3.every(m => m.mood <= 2);

    let aiMsg = '';
    const name = req.user.name?.split(' ')[0] || 'hey';
    if (mood === 5) aiMsg = `${name}, you're in flow state today. Let's make it count. ⚡`;
    else if (mood === 4) aiMsg = `Good energy, ${name}. Push one chapter harder today. 💪`;
    else if (mood === 3) aiMsg = `Steady. Even 60% effort today adds up. You got this. 🙂`;
    else if (mood === 2) aiMsg = `That's okay. Do one small thing — just one. That's enough. 🌱`;
    else aiMsg = `Rest mode activated. Your only job today: show up. That's it. 💙`;

    res.json({ success: true, recoveryMode, aiMsg, mood });
  } catch(e) { res.status(500).json({ error: 'Could not save mood.' }); }
});

app.get('/api/mood/history', requireAuth, async (req, res) => {
  try {
    const moods = await Mood.find({ userId: req.user._id })
      .sort({ createdAt: -1 }).limit(14).lean();
    const last3 = moods.slice(0,3);
    const recoveryMode = last3.length >= 3 && last3.every(m => m.mood <= 2);
    const todayDate = new Date().toISOString().split('T')[0];
    const checkedToday = moods.length > 0 && moods[0].date === todayDate;
    res.json({ moods, recoveryMode, checkedToday });
  } catch(e) { res.status(500).json({ error: 'Could not load moods.' }); }
});

// ══════════════════════════════════════════════════════════════════
// IMPROVED STUDY PLAN GENERATOR
// ══════════════════════════════════════════════════════════════════
app.post('/api/planner/smart-generate', requireAuth, async (req, res) => {
  try {
    const { period, energyLevel, targetDate, customNote } = req.body;
    const user = req.user;
    const name = user.name?.split(' ')[0] || 'Student';

    // Get weak topics from DB
    const wk = getWeekKey();
    const weakMap = user.weakTopics instanceof Map
      ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
    const weakTopics = [...weakMap.entries()]
      .filter(([,v]) => v?.count > 0)
      .sort((a,b) => (b[1].count||0)-(a[1].count||0))
      .slice(0,5).map(([t]) => t);

    // Get mood data
    const last3Moods = await Mood.find({ userId: user._id })
      .sort({ createdAt: -1 }).limit(3).lean();
    const avgMood = last3Moods.length
      ? (last3Moods.reduce((a,m)=>a+m.mood,0)/last3Moods.length).toFixed(1) : 3;
    const recoveryMode = last3Moods.length >= 3 && last3Moods.every(m => m.mood <= 2);

    const daysLeft = user.examDate
      ? Math.max(0, Math.ceil((new Date(user.examDate)-new Date())/86400000)) : null;

    const prompt = `You are GRIND — a smart JEE study planner for ${name}.

STUDENT PROFILE:
- Exam: ${user.exam || 'JEE Main'} | Class: ${user.class || '12th'}
- Study hours/day: ${user.hoursPerDay || '6'}
- ${daysLeft ? `Days to exam: ${daysLeft}` : 'Exam date not set'}
- Average mood (last 3 days): ${avgMood}/5
- Recovery mode needed: ${recoveryMode ? 'YES — keep sessions short and gentle' : 'No'}
- Energy level today: ${energyLevel || 'medium'}
- Weak topics (prioritize these): ${weakTopics.join(', ') || 'Not tracked yet'}
- Special note: ${customNote || 'none'}

TASK: Generate a ${period || 'daily'} study plan as a JSON array.

RULES:
1. Max tasks: ${energyLevel==='low'||recoveryMode ? 4 : energyLevel==='high' ? 8 : 6}
2. Mix subjects (not 3 Physics in a row)
3. First task after morning = easiest (warm up)
4. Hardest task = second slot when brain is fresh
5. Include 1 Formula Fortress review (10 min)
6. Include 1 Mistake Book revision (15 min)
7. If recovery mode → all tasks max 20 min, only revision (no new chapters)
8. Each task must have clear, specific title — NOT vague like "Study Physics"

Return ONLY this JSON (no markdown, no explanation):
[
  {
    "title": "Specific task name e.g. Solve 5 Thermodynamics PYQs",
    "subject": "Physics",
    "priority": "high",
    "estimatedMins": 45,
    "notes": "Focus on Carnot cycle — you missed 3 questions last week",
    "type": "story_mode | revision | formula_fortress | mistake_book | mock | break"
  }
]`;

    const reply = await getReply([{ role:'user', content: prompt }],
      'Return ONLY a valid JSON array. No markdown. No extra text before or after.');
    const tasks = safeParseJSON(reply);
    if (!Array.isArray(tasks) || !tasks.length) throw new Error('Invalid plan format');

    const date = new Date(targetDate || new Date());
    date.setHours(6, 0, 0, 0);

    const saved = [];
    for (const t of tasks) {
      saved.push(await PlannerTask.create({
        userId: user._id, ...t, scheduledDate: date, aiGenerated: true
      }));
    }
    res.json({ tasks: saved, recoveryMode, weakTopicsUsed: weakTopics });
  } catch(err) {
    console.error('Smart planner:', err.message);
    res.status(500).json({ error: 'Could not generate plan. Try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════
// FORMULA FORTRESS (Spaced Repetition — SM-2 Algorithm)
// ══════════════════════════════════════════════════════════════════
app.get('/api/formulas', requireAuth, async (req, res) => {
  try {
    const due = await Formula.find({
      userId: req.user._id,
      nextReview: { $lte: new Date() }
    }).sort({ nextReview: 1 }).limit(20).lean();
    const total = await Formula.countDocuments({ userId: req.user._id });
    const mastered = await Formula.countDocuments({ userId: req.user._id, repetitions: { $gte: 5 } });
    res.json({ formulas: due, total, mastered, dueCount: due.length });
  } catch(e) { res.status(500).json({ error: 'Could not load formulas.' }); }
});

app.post('/api/formulas', requireAuth, async (req, res) => {
  try {
    const f = await Formula.create({ userId: req.user._id, ...req.body });
    res.json({ formula: f });
  } catch(e) { res.status(500).json({ error: 'Could not save formula.' }); }
});

app.post('/api/formulas/:id/review', requireAuth, async (req, res) => {
  try {
    const { quality } = req.body; // 0=forgot, 3=hard, 4=good, 5=easy
    const f = await Formula.findOne({ _id: req.params.id, userId: req.user._id });
    if (!f) return res.status(404).json({ error: 'Not found.' });
    if (quality >= 3) {
      f.interval = f.repetitions === 0 ? 1 : f.repetitions === 1 ? 6 : Math.round(f.interval * f.easeFactor);
      f.repetitions++;
    } else { f.repetitions = 0; f.interval = 1; }
    f.easeFactor = Math.max(1.3, f.easeFactor + 0.1 - (5-quality)*(0.08+(5-quality)*0.02));
    f.nextReview = new Date(Date.now() + f.interval * 86400000);
    await f.save();
    res.json({ formula: f, mastered: f.repetitions >= 5 });
  } catch(e) { res.status(500).json({ error: 'Review failed.' }); }
});

app.delete('/api/formulas/:id', requireAuth, async (req, res) => {
  try {
    await Formula.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Delete failed.' }); }
});

// ══════════════════════════════════════════════════════════════════
// ARJUN — AI COMPANION (Friendly, remembers, JEE-focused)
// ══════════════════════════════════════════════════════════════════
app.post('/api/arjun', requireAuth, async (req, res) => {
  const { messages } = req.body;
  const user = req.user;
  const name = user?.name?.split(' ')[0] || 'yaar';
  const wk = getWeekKey();
  const weakMap = user.weakTopics instanceof Map
    ? user.weakTopics : new Map(Object.entries(user.weakTopics || {}));
  const weakTopics = [...weakMap.entries()]
    .filter(([,v])=>v?.weeks?.includes(wk)).map(([t])=>t).slice(0,3);

  const last3Moods = await Mood.find({ userId: user._id }).sort({ createdAt:-1 }).limit(3).lean().catch(()=>[]);
  const avgMood = last3Moods.length ? (last3Moods.reduce((a,m)=>a+m.mood,0)/last3Moods.length) : 3;
  const recoveryMode = last3Moods.length >= 3 && last3Moods.every(m => m.mood <= 2);

  const systemPrompt = `You are Arjun — a 22-year-old IIT Bombay student who cracked JEE in 2023. You're ${name}'s personal mentor inside GRIND.

PERSONALITY:
- Talk like a real dost, not a corporate bot. Mix English and Hindi naturally.
- You GENUINELY care about this student. They went through a tough time recently — be human first.
- Short replies by default (3-4 sentences). Go longer only if they ask for explanation.
- When they share something sad → drop all JEE talk. Just be there.
- When they're crushing it → celebrate for real. Not "great job!" but something specific.
- End every reply with ONE question OR one small challenge. Never leave them hanging.
- Never start with "I" or "As an AI" — you're Arjun.

STUDENT DATA:
Name: ${name} | Exam: ${user.exam || 'JEE'} | Level: ${user.quizLevel} | Streak: ${user.streak} days
Weak topics this week: ${weakTopics.join(', ') || 'nothing logged yet'}
Avg mood (last 3 days): ${avgMood.toFixed(1)}/5
${recoveryMode ? '⚠️ RECOVERY MODE: Student has been struggling — be extra gentle, zero pressure.' : ''}

FOR JEE ADVANCED QUESTIONS:
- Give complete solutions with all steps shown
- Mention common traps in that type
- Always end with "similar questions to practice" if they ask about a concept
- Use LaTeX for math: $inline$ and $$block$$`;

  try {
    const reply = await getReply(
      (messages || []).slice(-12),
      systemPrompt
    );
    res.json({ reply });
  } catch(e) { res.status(500).json({ error: 'Arjun is thinking... try again in a sec.' }); }
});

// ══════════════════════════════════════════════════════════════════
// BOSS BATTLES
// ══════════════════════════════════════════════════════════════════
app.post('/api/boss/start', requireAuth, async (req, res) => {
  const { subject, chapter, type } = req.body;
  const isWorld = type === 'world';
  const count = isWorld ? 25 : 15;

  const prompt = `Generate ${count} JEE PYQ-style questions for a BOSS BATTLE.
Subject: ${subject}${chapter && !isWorld ? ` | Chapter: ${chapter}` : ' | ALL chapters mixed'}.
${isWorld ? 'Include JEE Advanced level questions. Mix easy/medium/hard.' : 'Medium-hard difficulty.'}
Negative marking: -1 for wrong answer.

Return ONLY JSON:
{
  "bossName": "${isWorld ? subject + ' World Boss' : chapter + ' Boss'}",
  "intro": "dramatic 1-sentence battle intro",
  "questions": [
    {
      "id": 1,
      "concept": "concept name",
      "question": "full question",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "answer": "A",
      "explanation": "step by step solution",
      "difficulty": "medium",
      "isAdvanced": false
    }
  ]
}`;
  try {
    const raw = await getReply([{ role:'user', content: prompt }],
      'Return ONLY valid JSON for boss battle. No markdown.');
    const data = safeParseJSON(raw);
    res.json({ ...data, total: count, type, negativeMarking: true });
  } catch(e) { res.status(500).json({ error: 'Could not start boss battle.' }); }
});

app.post('/api/boss/complete', requireAuth, async (req, res) => {
  try {
    const { subject, chapter, type, score, total, negativeScore } = req.body;
    const beaten = type === 'world' ? score >= total * 0.7 : score >= total * 0.6;
    const xp = beaten ? (type === 'world' ? 600 : 200) : Math.max(30, score * 10);
    await BossBattle.create({
      userId: req.user._id, subject, chapter, type, score, total, beaten, xpEarned: xp
    });
    const result = await awardXP(req.user._id, xp, beaten,
      req.user.quizStreak, req.user.totalQSolved + total, req.user.totalQCorrect + score);
    const newBadges = [];
    if (beaten && type === 'world') newBadges.push({ id:'world_slayer', name:'World Boss Slayer', icon:'🌍', unlockedAt: new Date() });
    if (beaten && type === 'chapter') newBadges.push({ id:`boss_${(chapter||'').slice(0,8)}`, name:'Chapter Conqueror', icon:'⚔️', unlockedAt: new Date() });
    if (newBadges.length) await User.findByIdAndUpdate(req.user._id, { $push: { achievements: { $each: newBadges } } });
    res.json({ ...result, beaten, xpEarned: xp, newBadges,
      message: beaten
        ? `🔥 BOSS DEFEATED! ${xp} XP earned. You're getting dangerous.`
        : `💀 Boss wins this round. Review your weak concepts and challenge again.` });
  } catch(e) { res.status(500).json({ error: 'Could not save battle.' }); }
});

// ══════════════════════════════════════════════════════════════════
// STREAK SHIELDS
// ══════════════════════════════════════════════════════════════════
app.get('/api/shield', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    const now = new Date();
    const shieldReset = user.shieldResetDate ? new Date(user.shieldResetDate) : new Date(0);
    const sameMonth = shieldReset.getMonth()===now.getMonth() && shieldReset.getFullYear()===now.getFullYear();
    const used = sameMonth ? (user.shieldsUsedThisMonth || 0) : 0;
    res.json({ shieldsLeft: 2 - used, shieldsUsed: used });
  } catch(e) { res.status(500).json({ error: 'Shield status failed.' }); }
});

app.post('/api/shield/use', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const now = new Date();
    const shieldReset = user.shieldResetDate ? new Date(user.shieldResetDate) : new Date(0);
    const sameMonth = shieldReset.getMonth()===now.getMonth() && shieldReset.getFullYear()===now.getFullYear();
    if (!sameMonth) { user.shieldsUsedThisMonth = 0; user.shieldResetDate = now; }
    if ((user.shieldsUsedThisMonth||0) >= 2) {
      return res.json({ success: false, message: 'No shields left this month. Come back next month.', shieldsLeft: 0 });
    }
    user.shieldsUsedThisMonth = (user.shieldsUsedThisMonth||0) + 1;
    user.shieldResetDate = now;
    await user.save();
    const left = 2 - user.shieldsUsedThisMonth;
    res.json({ success: true, shieldsLeft: left,
      message: `🛡️ Shield used! Streak protected. ${left} shield${left!==1?'s':''} left this month.` });
  } catch(e) { res.status(500).json({ error: 'Shield failed.' }); }
});

// ══════════════════════════════════════════════════════════════════
// WEEKLY WAR REPORT
// ══════════════════════════════════════════════════════════════════
app.get('/api/report/weekly', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const name = user.name?.split(' ')[0] || 'Warrior';
    const weekAgo = new Date(Date.now() - 7*86400000);
    const wk = getWeekKey();

    const [mistakes, tasks, moods, bosses, storySessions] = await Promise.all([
      Mistake.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      PlannerTask.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      Mood.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      BossBattle.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean(),
      StorySession.find({ userId: user._id, createdAt: { $gte: weekAgo } }).lean()
    ]);

    const weakMap = user.weakTopics instanceof Map
      ? user.weakTopics : new Map(Object.entries(user.weakTopics||{}));
    const weakTopics = [...weakMap.entries()]
      .filter(([,v])=>v?.weeks?.includes(wk)).map(([t])=>t);

    const avgMood = moods.length ? (moods.reduce((a,m)=>a+m.mood,0)/moods.length).toFixed(1) : 'N/A';
    const completedTasks = tasks.filter(t=>t.status==='completed').length;
    const bossesBeaten = bosses.filter(b=>b.beaten).length;
    const avgImprovement = storySessions.length
      ? (storySessions.reduce((a,s)=>a+(s.improvement||0),0)/storySessions.length).toFixed(1) : 0;

    const prompt = `Write a personal weekly war report for ${name} — a JEE student.

DATA:
- Weekly XP: ${user.weeklyXP} | Level: ${user.quizLevel} | Streak: ${user.streak} days
- Story Mode sessions: ${storySessions.length} | Avg improvement: +${avgImprovement} per session
- Mistakes logged: ${mistakes.length} | Tasks done: ${completedTasks}/${tasks.length}
- Boss battles beaten: ${bossesBeaten}/${bosses.length}
- Average mood this week: ${avgMood}/5
- Weak topics: ${weakTopics.slice(0,4).join(', ') || 'not tracked'}

WRITE:
1. Opening — personal, acknowledges their actual week (1-2 sentences)
2. What they crushed (be specific)
3. What needs work next week (1-2 topics, specific)
4. Next week's priority battle plan (3 bullet points max)
5. Closing battle cry (1 sentence, genuine energy)

Tone: Like a senior IITian who genuinely cares. Real talk, not corporate. Warm but honest.
${name} recently came out of a tough period — celebrate showing up, not just scores.
Length: 150-180 words. No headers with #. Use emojis sparingly.`;

    const reportText = await getReply([{ role:'user', content: prompt }],
      'You are GRIND — IITian mentor writing a personal weekly war report.');

    res.json({
      weeklyXP: user.weeklyXP, streak: user.streak, level: user.quizLevel,
      storySessions: storySessions.length, avgImprovement,
      mistakesLogged: mistakes.length,
      tasksCompleted: completedTasks, totalTasks: tasks.length,
      avgMood, bossesBeaten, weakTopics: weakTopics.slice(0,5),
      reportText
    });
  } catch(e) { console.error(e.message); res.status(500).json({ error: 'Could not generate report.' }); }
});

// ══════════════════════════════════════════════════════════════════
// VIRTUAL RIVAL "ARYAN"
// ══════════════════════════════════════════════════════════════════
app.get('/api/rival', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const aryanLevel = Math.min(100, user.quizLevel + Math.floor(Math.random()*3) + 1);
    const aryanXP = user.quizXP + Math.floor(Math.random()*600) + 200;
    const aryanStreak = Math.max(user.streak, user.streak + Math.floor(Math.random()*4) + 1);
    const xpGap = aryanXP - user.quizXP;
    const taunts = [
      `Aryan just conquered Thermodynamics. Level ${aryanLevel} now. You still on ${user.quizLevel}?`,
      `Aryan did 3 Story Mode sessions today. That's ${xpGap} XP ahead of you.`,
      `Aryan's streak is ${aryanStreak} days straight. He doesn't take days off.`,
      `Aryan just beat the Physics World Boss. He's in another league right now.`,
      `Aryan woke up at 6AM and solved 20 PYQs before breakfast. Just saying.`
    ];
    res.json({
      aryanLevel, aryanXP, aryanStreak,
      taunt: taunts[Math.floor(Math.random()*taunts.length)],
      gap: { xp: xpGap, level: aryanLevel - user.quizLevel, streak: aryanStreak - user.streak }
    });
  } catch(e) { res.status(500).json({ error: 'Rival unavailable.' }); }
});

// ══════════════════════════════════════════════════════════════════
// WAR ROOM — Chapter mastery map
// ══════════════════════════════════════════════════════════════════
app.get('/api/warroom', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const sessions = await StorySession.find({ userId: user._id }).lean();
    const bosses = await BossBattle.find({ userId: user._id }).lean();

    // Build chapter status map
    const chapterMap = {};
    for (const s of sessions) {
      const key = `${s.subject}::${s.chapter}`;
      if (!chapterMap[key]) chapterMap[key] = { subject: s.subject, chapter: s.chapter, attempts: 0, bestImprovement: 0, bestRound2: 0, conquered: false };
      chapterMap[key].attempts++;
      chapterMap[key].bestImprovement = Math.max(chapterMap[key].bestImprovement, s.improvement||0);
      chapterMap[key].bestRound2 = Math.max(chapterMap[key].bestRound2, s.round2Score||0);
      if (s.round2Score >= 7) chapterMap[key].conquered = true;
    }

    const chapters = Object.values(chapterMap).map(c => ({
      ...c,
      status: c.conquered ? 'conquered' : c.attempts >= 1 ? 'in-battle' : 'locked',
      masteryPct: Math.round((c.bestRound2/8)*100)
    }));

    res.json({ chapters, totalConquered: chapters.filter(c=>c.conquered).length, total: chapters.length });
  } catch(e) { res.status(500).json({ error: 'War room failed.' }); }
});



// ── SERVE SPA ─────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 GRIND AI v8 on port ${PORT}`);
  console.log(`🔑 Groq=${GROQ_KEYS.length} Gemini=${GEMINI_KEYS.length} OR=${OPENROUTER_KEYS.length}`);
  // 1. Force the CSS to stop splitting the screen 50/50
const styleOverride = document.createElement('style');
styleOverride.innerHTML = `
  /* Change this selector to match your actual main flex/grid box */
  #main-content-wrapper, .main-container { 
    display: block !important; 
    position: relative !important; 
    width: 100% !important; 
    height: 100vh !important;
  }
  .app-view-panel {
    position: absolute !important;
    top: 0; left: 0; width: 100%; height: 100%;
    display: none;
  }
  .app-view-panel.visible-now {
    display: block !important;
  }
`;
document.head.appendChild(styleOverride);

// 2. Identify your UI components (Add these IDs directly to your HTML markup if needed)
const viewChat = document.getElementById('view-chat') || document.querySelector('.chat-container');
const viewStory = document.getElementById('view-story') || document.querySelector('.story-mode-container');

// Set initial classes
if(viewChat) viewChat.classList.add('app-view-panel', 'visible-now');
if(viewStory) viewStory.classList.add('app-view-panel');

// 3. Find your Sidebar Buttons by searching their text labels dynamically
document.querySelectorAll('.nav-item').forEach(item => {
  const text = item.textContent.toLowerCase();
  
  if (text.includes('chat')) {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      viewChat?.classList.add('visible-now');
      viewStory?.classList.remove('visible-now');
    });
  } 
  else if (text.includes('story') || text.includes('mode')) {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      viewStory?.classList.add('visible-now');
      viewChat?.classList.remove('visible-now');
    });
  }


});
