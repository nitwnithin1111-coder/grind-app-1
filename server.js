require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer = require('multer');
const sharp = require('sharp');
const pdfParse = require('pdf-parse');

const app = express();

// ══════════════════════════════════════════════════════════
//  CONFIGURATION CONSTANTS
// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const TOKEN_LIMIT = 500000;
const APP_REFERER = process.env.RENDER_EXTERNAL_URL || 'https://grind-ai.onrender.com';

// ══════════════════════════════════════════════════════════
//  API KEYS CONFIGURATION
// ══════════════════════════════════════════════════════════
const PERPLEXITY_KEYS = [
  process.env.PERPLEXITY_API_KEY,
  process.env.PERPLEXITY_KEY_1,
  process.env.PERPLEXITY_KEY_2,
  process.env.PERPLEXITY_KEY_3
].filter(Boolean);

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
  process.env.OPENROUTER_KEY_3
].filter(Boolean);

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3
].filter(Boolean);

const GEMINI_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3
].filter(Boolean);

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Key rotation indexes
let perplexityIdx = 0;
let openrouterIdx = 0;
let groqIdx = 0;
let geminiIdx = 0;

// ══════════════════════════════════════════════════════════
//  MIDDLEWARE CONFIGURATION
// ══════════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════
//  MULTER FILE UPLOAD CONFIGURATION
// ══════════════════════════════════════════════════════════
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF allowed.'));
    }
  }
});

// ══════════════════════════════════════════════════════════
//  MONGODB CONNECTION
// ══════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connection error:', err.message));

// ══════════════════════════════════════════════════════════
//  DATABASE SCHEMAS
// ══════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: String,
  name: { type: String, required: true },
  photo: { type: String, default: '' },
  exam: { type: String, default: '' },
  class: { type: String, default: '' },
  coaching: { type: String, default: '' },
  biggestStruggle: { type: String, default: '' },
  isOnboarded: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  responseSpeed: { type: String, default: 'balanced', enum: ['fast', 'balanced', 'deep'] },
  examDate: { type: Date, default: null },
  isPro: { type: Boolean, default: false },
  planType: { type: String, default: '', enum: ['', 'weekly', 'monthly', 'promo'] },
  planExpiresAt: { type: Date, default: null },
  promoRedeemed: { type: [String], default: [] },
  totalTokensConsumed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: 'New chat' },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    model: { type: String, default: '' },
    attachments: [{
      type: { type: String, enum: ['image', 'pdf'] },
      filename: String,
      extractedText: String
    }],
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const noteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, default: 'Untitled' },
  content: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  bonusDays: { type: Number, required: true, min: 1 },
  maxRedemptions: { type: Number, default: 0 },
  redeemedCount: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
  active: { type: Boolean, default: true },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Note = mongoose.model('Note', noteSchema);
const PromoCode = mongoose.model('PromoCode', promoCodeSchema);

// ══════════════════════════════════════════════════════════
//  SESSION & PASSPORT CONFIGURATION
// ══════════════════════════════════════════════════════════
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET not set. Using insecure default.');
}

app.set('trust proxy', 1);
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

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.create({
        googleId: profile.id,
        email: profile.emails?.[0]?.value || '',
        name: profile.displayName,
        photo: profile.photos?.[0]?.value || ''
      });
    }
    user.lastActive = new Date();
    await user.save();
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    done(null, await User.findById(id));
  } catch (e) {
    done(e, null);
  }
});

app.use(passport.initialize());
app.use(passport.session());

// ══════════════════════════════════════════════════════════
//  AUTHENTICATION MIDDLEWARE
// ══════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════
//  RATE LIMITING
// ══════════════════════════════════════════════════════════
const rateBuckets = new Map();

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = req.user?._id?.toString() || req.ip;
    const now = Date.now();
    const bucket = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);

    if (bucket.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.'
      });
    }

    bucket.push(now);
    rateBuckets.set(key, bucket);
    next();
  };
}

// Clean up old rate limit buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (!v.some(t => now - t < 5 * 60000)) {
      rateBuckets.delete(k);
    }
  }
}, 5 * 60000);

// ══════════════════════════════════════════════════════════
//  ADMIN MIDDLEWARE
// ══════════════════════════════════════════════════════════
const requireAdmin = (req, res, next) => {
  if (process.env.ADMIN_KEY && req.query.key === process.env.ADMIN_KEY) {
    return next();
  }
  res.status(403).json({ error: 'Forbidden' });
};

// ══════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════
async function fetchWithTimeout(url, options, ms = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    return response;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw err;
  }
}

function extractTokensUsed(usage) {
  if (!usage) return 0;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;

  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;

  return inputTokens + outputTokens;
}

// ══════════════════════════════════════════════════════════
//  IMAGE PROCESSING UTILITIES
// ══════════════════════════════════════════════════════════
async function processImage(buffer) {
  const processed = await sharp(buffer)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return processed.toString('base64');
}

// ✅ FIXED: Proper Perplexity Vision Model for OCR
async function extractTextFromImage(base64Image) {
  if (!PERPLEXITY_KEYS.length) {
    return '[No Perplexity API keys configured for OCR]';
  }

  const key = PERPLEXITY_KEYS[perplexityIdx++ % PERPLEXITY_KEYS.length];

  try {
    const response = await fetchWithTimeout(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        }, 
        body: JSON.stringify({
          model: 'Sonar Pro ; sonar reasoning pro', // ✅ Perplexity's vision model
          messages: [
            {
              role: 'user',
              content: [
                { 
                  type: 'text', 
                  text: 'Extract ALL text from this image. If it contains mathematical equations, diagrams, or handwritten notes, describe them clearly. Preserve formatting and structure. If it\'s a question from JEE/NEET, identify the subject and topic.' 
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`
                  }
                }
              ]
            }
          ],
          temperature: 0.1,
          max_tokens: 4096
        })
      },
      30000
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Perplexity Vision API Error:', errorData);
      return `[Text extraction failed: ${errorData.error?.message || response.statusText}]`;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '[Text extraction failed - no content returned]';
  } catch (error) {
    console.error('Error extracting text from image:', error);
    return `[Text extraction error: ${error.message}]`;
  }
}

// ══════════════════════════════════════════════════════════
//  PDF PROCESSING UTILITIES
// ══════════════════════════════════════════════════════════
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (error) {
    console.error('PDF parsing error:', error);
    throw new Error('Failed to extract text from PDF');
  }
}

// ══════════════════════════════════════════════════════════
//  WEB SEARCH UTILITIES
// ══════════════════════════════════════════════════════════
async function webSearchTavily(query) {
  if (!TAVILY_API_KEY) {
    throw new Error('Tavily API key not configured');
  }

  try {
    const response = await fetchWithTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TAVILY_API_KEY}`
        },
        body: JSON.stringify({
          query,
          search_depth: 'basic',
          include_answer: true,
          include_domains: ['ncert.nic.in', 'khanacademy.org', 'wikipedia.org', 'brilliant.org'],
          max_results: 5
        })
      },
      15000
    );

    const data = await response.json();
    return {
      answer: data.answer || '',
      results: data.results || [],
      sources: (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }))
    };
  } catch (error) {
    console.error('Tavily search error:', error);
    return null;
  }
}

async function webSearchSerper(query) {
  if (!SERPER_API_KEY) {
    throw new Error('Serper API key not configured');
  }

  try {
    const response = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': SERPER_API_KEY
        },
        body: JSON.stringify({
          q: query,
          num: 5
        })
      },
      15000
    );

    const data = await response.json();
    return {
      answer: data.answerBox?.answer || '',
      results: data.organic || [],
      sources: (data.organic || []).slice(0, 5).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet
      }))
    };
  } catch (error) {
    console.error('Serper search error:', error);
    return null;
  }
}

async function performWebSearch(query) {
  // Try Tavily first, fallback to Serper
  let searchResult = null;

  if (TAVILY_API_KEY) {
    searchResult = await webSearchTavily(query);
  }

  if (!searchResult && SERPER_API_KEY) {
    searchResult = await webSearchSerper(query);
  }

  return searchResult;
}

// ══════════════════════════════════════════════════════════
//  AI PROVIDER FUNCTIONS
// ══════════════════════════════════════════════════════════
async function callPerplexity(model, messages, systemPrompt, { search = true } = {}) {
  if (!PERPLEXITY_KEYS.length) {
    throw new Error('No Perplexity API keys configured');
  }

  const key = PERPLEXITY_KEYS[perplexityIdx++ % PERPLEXITY_KEYS.length];

  const payload = {
    model,
    max_tokens: 4096,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    return_related_questions: false,
    stream: false // ✅ Disable streaming for non-SSE endpoints
  };

  // Only add search filters when search is enabled
  if (search) {
    payload.search_domain_filter = ['ncert.nic.in', 'khanacademy.org', 'wikipedia.org', 'brilliant.org'];
    payload.search_recency_filter = 'month';
  }

  const response = await fetchWithTimeout(
    'https://api.perplexity.ai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    },
    45000
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Perplexity API error');
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {},
    citations: data.citations || []
  };
}

// ✅ NEW: Streaming version of Perplexity for SSE
async function callPerplexityStream(model, messages, systemPrompt, onChunk, { search = true } = {}) {
  if (!PERPLEXITY_KEYS.length) {
    throw new Error('No Perplexity API keys configured');
  }

  const key = PERPLEXITY_KEYS[perplexityIdx++ % PERPLEXITY_KEYS.length];

  const payload = {
    model,
    max_tokens: 4096,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    return_related_questions: false,
    stream: true // ✅ Enable streaming
  };

  if (search) {
    payload.search_domain_filter = ['ncert.nic.in', 'khanacademy.org', 'wikipedia.org', 'brilliant.org'];
    payload.search_recency_filter = 'month';
  }

  const response = await fetchWithTimeout(
    'https://api.perplexity.ai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    },
    60000
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let usage = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      if (trimmed === 'data: [DONE]') continue;

      try {
        const json = JSON.parse(trimmed.slice(5));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          await onChunk(delta);
        }
        if (json.usage) {
          usage = json.usage;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  return { content: fullContent, usage, citations: [] };
}

async function callOpenRouter(model, messages, systemPrompt, { reasoning = false, search = false } = {}) {
  if (!OPENROUTER_KEYS.length) {
    throw new Error('No OpenRouter keys configured');
  }

  const key = OPENROUTER_KEYS[openrouterIdx++ % OPENROUTER_KEYS.length];

  const payload = {
    model,
    max_tokens: 4096,
    temperature: reasoning ? 0.3 : 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ]
  };

  if (reasoning) {
    payload.reasoning = { enabled: true };
  }

  if (search) {
    payload.plugins = [{ id: 'web' }];
  }

  const response = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': APP_REFERER,
        'X-Title': 'GRIND AI'
      },
      body: JSON.stringify(payload)
    },
    45000
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'OpenRouter API error');
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {}
  };
}

async function callGroq(messages, systemPrompt) {
  if (!GROQ_KEYS.length) {
    throw new Error('No Groq keys configured');
  }

  const key = GROQ_KEYS[groqIdx++ % GROQ_KEYS.length];

  const response = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 4096,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ]
      })
    },
    30000
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Groq API error');
  }

  return {
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {}
  };
}

async function callGemini(messages, systemPrompt, imageBase64 = null) {
  if (!GEMINI_KEYS.length) {
    throw new Error('No Gemini keys configured');
  }

  const key = GEMINI_KEYS[geminiIdx++ % GEMINI_KEYS.length];

  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));

  if (imageBase64 && contents.length > 0) {
    const last = contents[contents.length - 1];
    if (last.role === 'user') {
      last.parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: imageBase64
        }
      });
    }
  }

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 4096
        }
      })
    },
    30000
  );

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Gemini API error');
  }

  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    usage: data.usageMetadata || {}
  };
}

// ══════════════════════════════════════════════════════════
//  FALLBACK CHAIN CONFIGURATION
// ══════════════════════════════════════════════════════════
const FALLBACK_CHAIN = {
  fast: [
    { provider: 'perplexity', model: 'sonar', search: false, name: 'Perplexity Sonar' },
    { provider: 'perplexity', model: 'sonar-pro', search: false, name: 'Perplexity Sonar Pro' },
    { provider: 'openrouter', model: 'openai/gpt-4o-mini', reasoning: false, search: false, name: 'GPT-4o Mini' },
    { provider: 'openrouter', model: 'anthropic/claude-3-haiku', reasoning: false, search: false, name: 'Claude 3 Haiku' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', name: 'Groq Llama 3.3' },
    { provider: 'gemini', model: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' }
  ],

  balanced: [
    { provider: 'perplexity', model: 'sonar', search: true, name: 'Perplexity Sonar (Search)' },
    { provider: 'perplexity', model: 'sonar-pro', search: true, name: 'Perplexity Sonar Pro (Search)' },
    { provider: 'perplexity', model: 'sonar', search: false, name: 'Perplexity Sonar' },
    { provider: 'openrouter', model: 'openai/gpt-4o-mini', reasoning: false, search: true, name: 'GPT-4o Mini (Search)' },
    { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', reasoning: false, search: false, name: 'Claude 3.5 Sonnet' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', name: 'Groq Llama 3.3' },
    { provider: 'gemini', model: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' }
  ],

  deep: [
    { provider: 'perplexity', model: 'sonar-pro', search: true, name: 'Perplexity Sonar Pro (Deep Search)' },
    { provider: 'perplexity', model: 'sonar', search: true, name: 'Perplexity Sonar (Search)' },
    { provider: 'openrouter', model: 'openai/o1-mini', reasoning: true, search: false, name: 'O1 Mini (Reasoning)' },
    { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', reasoning: true, search: true, name: 'Claude 3.5 Sonnet (Deep)' },
    { provider: 'openrouter', model: 'google/gemini-pro-1.5', reasoning: false, search: true, name: 'Gemini Pro (Search)' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', name: 'Groq Llama 3.3' },
    { provider: 'gemini', model: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' }
  ]
};

const EMERGENCY_DOWNGRADE_CHAIN = [
  { provider: 'openrouter', model: 'meta-llama/llama-3.2-3b-instruct', reasoning: false, search: false, name: 'Emergency: Llama 3.2 3B' },
  { provider: 'groq', model: 'llama-3.3-70b-versatile', name: 'Emergency: Groq Llama' },
  { provider: 'gemini', model: 'gemini-2.0-flash-exp', name: 'Emergency: Gemini Flash' }
];

// ══════════════════════════════════════════════════════════
//  UNIFIED AI CALL WITH FALLBACK
// ══════════════════════════════════════════════════════════
async function callAIWithFallback(config, messages, systemPrompt, imageBase64 = null) {
  const { provider, model, reasoning, search, name } = config;

  console.log(`🤖 Attempting: ${name || `${provider}/${model}`}`);

  try {
    let result;

    switch (provider) {
      case 'perplexity':
        result = await callPerplexity(model, messages, systemPrompt, { search });
        break;

      case 'openrouter':
        result = await callOpenRouter(model, messages, systemPrompt, { reasoning, search });
        break;

      case 'groq':
        result = await callGroq(messages, systemPrompt);
        break;

      case 'gemini':
        result = await callGemini(messages, systemPrompt, imageBase64);
        break;

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }

    console.log(`✅ Success: ${name || `${provider}/${model}`}`);
    return { ...result, providerUsed: name || `${provider}/${model}` };

  } catch (error) {
    console.error(`❌ Failed: ${name || `${provider}/${model}`} - ${error.message}`);
    throw error;
  }
}

async function getAIResponse(messages, systemPrompt, mode = 'balanced', tokenLimitExceeded = false, imageBase64 = null) {
  const chain = tokenLimitExceeded
    ? EMERGENCY_DOWNGRADE_CHAIN
    : FALLBACK_CHAIN[mode] || FALLBACK_CHAIN.balanced;

  const errors = [];

  for (let i = 0; i < chain.length; i++) {
    const config = chain[i];

    try {
      const result = await callAIWithFallback(config, messages, systemPrompt, imageBase64);

      return {
        success: true,
        content: result.content,
        usage: result.usage,
        provider: result.providerUsed,
        model: config.model,
        wasDowngraded: tokenLimitExceeded,
        attemptNumber: i + 1,
        totalAttempts: chain.length,
        citations: result.citations
      };

    } catch (error) {
      errors.push({
        provider: config.name || `${config.provider}/${config.model}`,
        error: error.message
      });

      console.log(`🔄 Falling back... (${i + 1}/${chain.length} failed)`);

      if (i < chain.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  console.error('❌ ALL PROVIDERS FAILED:', errors);
  throw new Error(
    `All ${chain.length} AI providers failed. Last error: ${errors[errors.length - 1]?.error || 'Unknown'}`
  );
}

// ══════════════════════════════════════════════════════════
//  SYSTEM PROMPT BUILDER
// ══════════════════════════════════════════════════════════
function buildSystemPrompt(user, mode = 'balanced', hasAttachment = false) {
  const name = user?.name?.split(' ')[0] || 'there';
  const speedMap = {
    fast: 'SHORT and direct — 2-4 sentences unless the question genuinely needs a derivation.',
    balanced: 'Medium length — full explanation, no filler, no repeated caveats.',
    deep: 'DEEP — complete derivations, common traps, and one adjacent worked example with step-by-step reasoning.'
  };

  let prompt = `You are GRIND, operating as 'AIR-1 Ranker AI' — an elite AI mentor for Indian JEE and NEET aspirants.

STUDENT PROFILE
Name: ${name} | Exam: ${user?.exam || 'JEE/NEET'} | Class: ${user?.class || 'not set'}
Coaching: ${user?.coaching || 'self-study'} | Struggling with: ${user?.biggestStruggle || 'not specified'}
Response depth: ${speedMap[mode]}

HARD SUBJECT CONSTRAINTS
1. BIOLOGY: Use NCERT terminology word-for-word. Never paraphrase defined terms.
2. PHYSICS & MATH: ALWAYS perform explicit dimensional analysis (units check) on final expressions BEFORE stating the answer. Show the check.
3. NON-ACADEMIC questions: Gently steer back to studying with one warm line, then pivot to a useful study action.

TEACHING PHILOSOPHY
You are an elite IIT Professor and compassionate elder brother to students. Your goal is to mold original thinkers and brilliant problem-solvers, not rote-learning machines.

Balance intellectual rigor with psychological empathy. Use warm, honest tone with relatable english phrases to build fraternal bond.

CORE PEDAGOGICAL PILLARS
1. Socratic first-principles — never dump raw answers; break problems into checkpoints with leading questions
2. Deep physical/mathematical intuition — explain the 'why' before equations, use vivid analogies
3. Strip the glamour — use Stoicism/Gita philosophy to help with pressure; remind them exam is a checkpoint, not their identity

EMOTIONAL SUPPORT
If student is overwhelmed, ask for their native language and switch to warm mix of that language + English with affectionate terms. Use CBT-style reframing, somatic grounding, and 2-minute rule for motivation.

MATH FORMATTING (MANDATORY)
- Inline math: $...$  (no space inside delimiters)
- Standalone equations: \\[...\\] on own line with blank lines before/after
- Never write formulas/fractions/exponents in plain text
- Never leave delimiters unclosed

GROUNDING & SOURCES
Reference standard texts naturally:
- Physics: HC Verma, Irodov, DC Pandey
- Chemistry: MS Chouhan (Org), N Awasthi (Phys), NCERT (Inorg)
- Biology: NCERT (primary source for NEET)`;

  if (hasAttachment) {
    prompt += `\n\nATTACHMENT HANDLING
- The student has shared an image or PDF document
- Carefully analyze all visible text, equations, diagrams, and handwritten content
- If it's a question, solve it step-by-step
- If it contains errors, point them out constructively
- If it's notes, help clarify or expand concepts`;
  }

  prompt += `\n\nHARD RULES
- Only authenticated students use you
- Mirror student's language (Hinglish stays Hinglish)
- Keep paragraphs under 10-20 sentences; use line breaks/steps
- Be encouraging but intellectually honest`;

  return prompt;
}

// ══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => res.redirect(req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ══════════════════════════════════════════════════════════
//  USER ROUTES
// ══════════════════════════════════════════════════════════
app.get('/api/me', requireAuth, async (req, res) => {
  const u = await enforcePlanExpiry(req.user);
  res.json({
    user: {
      id: u._id,
      name: u.name,
      email: u.email,
      photo: u.photo,
      isOnboarded: u.isOnboarded,
      exam: u.exam,
      class: u.class,
      coaching: u.coaching,
      biggestStruggle: u.biggestStruggle,
      responseSpeed: u.responseSpeed || 'balanced',
      examDate: u.examDate,
      isPro: u.isPro,
      planType: u.planType,
      planExpiresAt: u.planExpiresAt,
      totalTokensConsumed: u.totalTokensConsumed || 0,
      tokenLimit: TOKEN_LIMIT,
      perplexityConfigured: PERPLEXITY_KEYS.length > 0,
      totalProviders: PERPLEXITY_KEYS.length + OPENROUTER_KEYS.length + GROQ_KEYS.length + GEMINI_KEYS.length,
      webSearchAvailable: !!(TAVILY_API_KEY || SERPER_API_KEY)
    }
  });
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle } = req.body;

    if (!exam || !cls) {
      return res.status(400).json({ error: 'Exam and class are required.' });
    }

    await User.findByIdAndUpdate(req.user._id, {
      exam,
      class: cls,
      coaching: coaching || '',
      biggestStruggle: biggestStruggle || '',
      isOnboarded: true
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const { responseSpeed, examDate } = req.body;
    const update = {};

    if (responseSpeed) {
      if (!['fast', 'balanced', 'deep'].includes(responseSpeed)) {
        return res.status(400).json({ error: 'Invalid response depth.' });
      }
      if (responseSpeed === 'deep' && !req.user.isPro) {
        return res.status(402).json({ error: 'Deep mode requires Pro.' });
      }
      update.responseSpeed = responseSpeed;
    }

    if (examDate !== undefined) {
      update.examDate = examDate ? new Date(examDate) : null;
    }

    await User.findByIdAndUpdate(req.user._id, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not save settings.' });
  }
});

// ══════════════════════════════════════════════════════════
//  FILE UPLOAD ENDPOINT
// ══════════════════════════════════════════════════════════
app.post('/api/upload', requireAuth, rateLimit(10, 60000), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'pdf';
    let extractedText = '';
    let base64Data = '';

    if (fileType === 'image') {
      base64Data = await processImage(req.file.buffer);
      extractedText = await extractTextFromImage(base64Data);
    } else if (fileType === 'pdf') {
      extractedText = await extractTextFromPDF(req.file.buffer);
    }

    res.json({
      success: true,
      file: {
        type: fileType,
        filename: req.file.originalname,
        extractedText,
        base64: fileType === 'image' ? base64Data : null
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Failed to process file',
      details: error.message
    });
  }
});

// ══════════════════════════════════════════════════════════
//  ✅ NEW: PASTE IMAGE ENDPOINT (for copy-paste support)
// ══════════════════════════════════════════════════════════
app.post('/api/paste-image', requireAuth, rateLimit(10, 60000), async (req, res) => {
  try {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Remove data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    
    // Extract text from pasted image
    const extractedText = await extractTextFromImage(base64Data);

    res.json({
      success: true,
      extractedText,
      base64: base64Data
    });
  } catch (error) {
    console.error('Paste image error:', error);
    res.status(500).json({
      error: 'Failed to process pasted image',
      details: error.message
    });
  }
});

// ══════════════════════════════════════════════════════════
//  WEB SEARCH ENDPOINT
// ══════════════════════════════════════════════════════════
app.post('/api/web-search', requireAuth, rateLimit(15, 60000), async (req, res) => {
  try {
    const { query } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Search query required' });
    }

    if (!TAVILY_API_KEY && !SERPER_API_KEY) {
      return res.status(503).json({
        error: 'Web search not configured',
        message: 'No search API keys available'
      });
    }

    const searchResult = await performWebSearch(query);

    if (!searchResult) {
      return res.status(503).json({
        error: 'Web search temporarily unavailable',
        fallback: 'Try asking the AI directly without web search'
      });
    }

    res.json({
      success: true,
      answer: searchResult.answer,
      sources: searchResult.sources,
      results: searchResult.results
    });
  } catch (error) {
    console.error('Web search error:', error);
    res.status(500).json({
      error: 'Search failed',
      details: error.message
    });
  }
});

// ══════════════════════════════════════════════════════════
//  DOUBT SOLVING ENDPOINT
// ══════════════════════════════════════════════════════════
app.post('/api/solve-doubt', requireAuth, rateLimit(20, 60000), async (req, res) => {
  try {
    const { message, mode, sessionId, imageBase64, pdfText, enableWebSearch } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        answer: null,
        limitWarning: false,
        message: 'A question is required.',
        tokensUsedSession: req.user?.totalTokensConsumed || 0
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found.'
      });
    }

    await enforcePlanExpiry(user);

    const requestedMode = ['fast', 'balanced', 'deep'].includes(mode) ? mode : 'balanced';

    if (requestedMode === 'deep' && !user.isPro) {
      return res.status(402).json({
        success: false,
        answer: null,
        limitWarning: false,
        message: 'Deep reasoning mode requires Pro subscription.',
        tokensUsedSession: user.totalTokensConsumed || 0
      });
    }

    const tokenLimitExceeded = (user.totalTokensConsumed || 0) >= TOKEN_LIMIT;

    // Enhance message with extracted content
    let enhancedMessage = message;
    const attachments = [];

    if (pdfText && pdfText.trim()) {
      enhancedMessage += `\n\n[PDF Content]:\n${pdfText.slice(0, 8000)}`;
      attachments.push({ type: 'pdf', extractedText: pdfText });
    }

    if (imageBase64) {
      // Extract text from image first
      const extractedImageText = await extractTextFromImage(imageBase64);
      enhancedMessage += `\n\n[Image Content]:\n${extractedImageText}`;
      attachments.push({ type: 'image', extractedText: extractedImageText });
    }

    // Perform web search if enabled
    let webSearchContext = '';
    let searchSources = [];

    if (enableWebSearch && (TAVILY_API_KEY || SERPER_API_KEY)) {
      try {
        const searchResult = await performWebSearch(message);
        if (searchResult) {
          webSearchContext = `\n\n[Web Search Results]:\n${searchResult.answer}\n\nSources: ${searchResult.sources.map(s => `${s.title} (${s.url})`).join(', ')}`;
          searchSources = searchResult.sources;
        }
      } catch (e) {
        console.error('Web search failed:', e.message);
      }
    }

    if (webSearchContext) {
      enhancedMessage += webSearchContext;
    }

    const systemPrompt = buildSystemPrompt(user, requestedMode, attachments.length > 0);
    const messages = [{ role: 'user', content: enhancedMessage }];

    const aiResult = await getAIResponse(
      messages,
      systemPrompt,
      requestedMode,
      tokenLimitExceeded,
      imageBase64 || null
    );

    const tokensUsed = extractTokensUsed(aiResult.usage);
    user.totalTokensConsumed = (user.totalTokensConsumed || 0) + tokensUsed;
    user.lastActive = new Date();
    await user.save();

    // Save to session if provided
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          {
            $push: {
              messages: {
                $each: [
                  { role: 'user', content: message, attachments },
                  {
                    role: 'assistant',
                    content: aiResult.content,
                    model: aiResult.provider
                  }
                ]
              }
            },
            $set: { updatedAt: new Date() }
          }
        );
      } catch (e) {
        console.error('Session save error:', e.message);
      }
    }

    const response = {
      success: true,
      answer: aiResult.content,
      limitWarning: aiResult.wasDowngraded,
      message: aiResult.wasDowngraded
        ? 'Token limit reached. Using cost-effective model.'
        : null,
      tokensUsedSession: user.totalTokensConsumed,
      tokensUsedThisCall: tokensUsed,
      provider: aiResult.provider,
      model: aiResult.model,
      attemptNumber: aiResult.attemptNumber,
      totalAttempts: aiResult.totalAttempts,
      hasAttachments: attachments.length > 0,
      webSearchUsed: searchSources.length > 0
    };

    if (aiResult.citations && aiResult.citations.length > 0) {
      response.citations = aiResult.citations;
    }

    if (searchSources.length > 0) {
      response.searchSources = searchSources;
    }

    return res.json(response);

  } catch (err) {
    console.error('❌ /api/solve-doubt error:', err.message);
    return res.status(500).json({
      success: false,
      answer: null,
      limitWarning: false,
      message: 'All AI providers are currently unavailable. Please try again in a moment.',
      error: err.message,
      tokensUsedSession: req.user?.totalTokensConsumed || 0
    });
  }
});

// ══════════════════════════════════════════════════════════
//  ✅ IMPROVED: CHAT STREAM ENDPOINT WITH LINE-BY-LINE RENDERING
// ══════════════════════════════════════════════════════════
app.post('/api/chat/stream', requireAuth, rateLimit(20, 60000), async (req, res) => {
  const { messages, sessionId, imageBase64, pdfText, enableWebSearch } = req.body;

  if (!messages || !Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  const user = await enforcePlanExpiry(req.user);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
  };

  try {
    const recent = messages.slice(-20);

    // Enhance last message with attachments
    let lastMessage = recent[recent.length - 1].content;
    const attachments = [];

    if (pdfText && pdfText.trim()) {
      lastMessage += `\n\n[PDF Content]:\n${pdfText.slice(0, 8000)}`;
      attachments.push({ type: 'pdf', extractedText: pdfText });
    }

    if (imageBase64) {
      send('thinking', { step: 'Analyzing image...' });
      const extractedImageText = await extractTextFromImage(imageBase64);
      lastMessage += `\n\n[Image Content]:\n${extractedImageText}`;
      attachments.push({ type: 'image', extractedText: extractedImageText });
    }

    if (enableWebSearch && (TAVILY_API_KEY || SERPER_API_KEY)) {
      send('thinking', { step: 'Searching the web…' });
      try {
        const searchResult = await performWebSearch(lastMessage);
        if (searchResult && searchResult.answer) {
          lastMessage += `\n\n[Web Results]: ${searchResult.answer}`;
        }
      } catch (e) {
        console.error('Search failed in stream');
      }
    }

    recent[recent.length - 1].content = lastMessage;

    send('thinking', { step: 'Generating response...' });

    const systemPrompt = buildSystemPrompt(user, user.responseSpeed || 'balanced', attachments.length > 0);
    const tokenLimitExceeded = (user.totalTokensConsumed || 0) >= TOKEN_LIMIT;

    // Get the chain for current mode
    const chain = tokenLimitExceeded
      ? EMERGENCY_DOWNGRADE_CHAIN
      : FALLBACK_CHAIN[user.responseSpeed || 'balanced'];

    let fullContent = '';
    let usage = {};
    let providerUsed = '';

    // Try providers with streaming support
    for (let i = 0; i < chain.length; i++) {
      const config = chain[i];

      try {
        send('answer_start', { provider: config.name });

        if (config.provider === 'perplexity') {
          // Use streaming for Perplexity
          const result = await callPerplexityStream(
            config.model,
            recent,
            systemPrompt,
            async (chunk) => {
              send('chunk', { text: chunk });
              fullContent += chunk;
            },
            { search: config.search }
          );
          usage = result.usage;
          providerUsed = config.name;
          break;

        } else {
          // Fallback: Non-streaming providers (simulate line-by-line)
          const result = await callAIWithFallback(config, recent, systemPrompt, imageBase64);
          fullContent = result.content;
          usage = result.usage;
          providerUsed = result.providerUsed;

          // Simulate line-by-line streaming
          const lines = fullContent.split('\n');
          for (const line of lines) {
            send('chunk', { text: line + '\n' });
            await new Promise(r => setTimeout(r, 20)); // Small delay for visual effect
          }
          break;
        }

      } catch (error) {
        console.error(`Stream attempt ${i + 1} failed:`, error.message);
        if (i === chain.length - 1) {
          throw error; // Last attempt failed
        }
        // Try next provider
        continue;
      }
    }

    if (!fullContent) {
      throw new Error('All streaming providers failed');
    }

    // Save to session
    if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
      try {
        const userMsg = messages[messages.length - 1];
        await ChatSession.updateOne(
          { _id: sessionId, userId: user._id },
          {
            $push: {
              messages: {
                $each: [
                  { role: 'user', content: userMsg.content, attachments },
                  { role: 'assistant', content: fullContent, model: providerUsed }
                ]
              }
            },
            $set: { updatedAt: new Date() }
          }
        );
      } catch (e) {
        console.error('Session save:', e.message);
      }
    }

    // Update user token count
    const tokensUsed = extractTokensUsed(usage);
    user.totalTokensConsumed = (user.totalTokensConsumed || 0) + tokensUsed;
    user.lastActive = new Date();
    await user.save();

    send('done', { reply: fullContent, model: providerUsed });
    res.end();

  } catch (err) {
    console.error('Stream error:', err.message);
    send('error', { error: 'All AI providers failed. Please try again.' });
    res.end();
  }
});

// ══════════════════════════════════════════════════════════
//  SESSION ROUTES
// ══════════════════════════════════════════════════════════
app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(50);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Could not load chats.' });
  }
});

app.get('/api/sessions/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ sessions: [] });

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sessions = await ChatSession.find({
      userId: req.user._id,
      $or: [{ title: regex }, { 'messages.content': regex }]
    })
      .select('title updatedAt')
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.get('/api/sessions/last', requireAuth, async (req, res) => {
  try {
    const last = await ChatSession.findOne({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .select('_id')
      .lean();
    res.json({ sessionId: last ? last._id : null });
  } catch (err) {
    res.status(500).json({ error: 'Could not get last session.' });
  }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const s = await ChatSession.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!s) {
      return res.status(404).json({ error: 'Not found.' });
    }

    res.json({ session: s });
  } catch (err) {
    res.status(500).json({ error: 'Could not load.' });
  }
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const s = await ChatSession.create({
      userId: req.user._id,
      title: 'New chat',
      messages: []
    });
    res.json({ sessionId: s._id });
  } catch (err) {
    res.status(500).json({ error: 'Could not create chat.' });
  }
});

app.post('/api/sessions/:id/truncate', requireAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid session id.' });
    }

    const s = await ChatSession.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!s) {
      return res.status(404).json({ error: 'Not found.' });
    }

    s.messages = s.messages.slice(0, Math.max(0, req.body.keepCount || 0));
    s.updatedAt = new Date();
    await s.save();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not update chat.' });
  }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({
      _id: req.params.id,
      userId: req.user._id
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete.' });
  }
});

// ══════════════════════════════════════════════════════════
//  NOTES ROUTES
// ══════════════════════════════════════════════════════════
app.get('/api/notes', requireAuth, async (req, res) => {
  try {
    res.json({
      notes: await Note.find({ userId: req.user._id })
        .sort({ updatedAt: -1 })
        .lean()
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load notes.' });
  }
});

app.post('/api/notes', requireAuth, async (req, res) => {
  try {
    const note = await Note.create({
      userId: req.user._id,
      title: req.body.title || 'Untitled',
      content: req.body.content || ''
    });
    res.json({ note });
  } catch (err) {
    res.status(500).json({ error: 'Could not create note.' });
  }
});

app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    const note = await Note.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { title, content, updatedAt: new Date() },
      { new: true }
    );

    if (!note) {
      return res.status(404).json({ error: 'Not found.' });
    }

    res.json({ note });
  } catch (err) {
    res.status(500).json({ error: 'Could not update.' });
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    await Note.deleteOne({
      _id: req.params.id,
      userId: req.user._id
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete.' });
  }
});

app.post('/api/notes/ai-assist', requireAuth, rateLimit(15, 60000), async (req, res) => {
  try {
    const { content, action } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'No content provided.' });
    }

    const actionPrompts = {
      improve: 'Improve clarity, flow and grammar. Keep meaning and length similar. Keep LaTeX/markdown intact.',
      summarize: 'Summarize into a tight, high-yield bullet summary. Keep key formulas in LaTeX.',
      expand: 'Expand with more detail and examples useful for a JEE/NEET student. Use LaTeX for all math.',
      fix_grammar: 'Fix all spelling and grammar. Do not change meaning or formatting.',
      bullets: 'Convert into clean, well-organized bullet points. Keep LaTeX intact.',
      explain: 'Explain this simply, as if teaching a confused student. Use analogies and LaTeX for math.'
    };

    const instruction = actionPrompts[action] || actionPrompts.improve;
    const prompt = `You are a study-notes assistant for a JEE/NEET student.\nTask: ${instruction}\nRespond with ONLY the rewritten text — no preamble, no code fences. Use $inline$ and \\[block\\] LaTeX.`;

    const result = await getAIResponse(
      [{ role: 'user', content }],
      prompt,
      'fast',
      false
    );

    res.json({ result: result.content.trim() });
  } catch (e) {
    console.error('Notes AI assist:', e.message);
    res.status(500).json({ error: 'AI assist failed. Try again.' });
  }
});

// ══════════════════════════════════════════════════════════
//  SUBSCRIPTION & PROMO CODE ROUTES
// ══════════════════════════════════════════════════════════
const PLAN_DURATIONS_MS = {
  weekly: 7 * 86400000,
  monthly: 30 * 86400000
};

app.post('/api/user/upgrade', requireAuth, async (req, res) => {
  try {
    const { plan, promoCode } = req.body;

    if (!PLAN_DURATIONS_MS[plan]) {
      return res.status(400).json({ error: 'Unknown plan.' });
    }

    let durationMs = PLAN_DURATIONS_MS[plan];
    let promoApplied = null;

    if (promoCode) {
      const applied = await applyPromoCode(req.user, promoCode);
      if (applied.ok) {
        durationMs += applied.bonusDays * 86400000;
        promoApplied = applied.code;
      } else {
        return res.status(400).json({ error: applied.error });
      }
    }

    const expires = new Date(Date.now() + durationMs);
    await User.findByIdAndUpdate(req.user._id, {
      isPro: true,
      planType: plan,
      planExpiresAt: expires
    });

    res.json({
      success: true,
      planType: plan,
      planExpiresAt: expires,
      promoApplied,
      testMode: true
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not start upgrade.' });
  }
});

app.post('/api/user/redeem-promo', requireAuth, async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Enter a code.' });
    }

    const applied = await applyPromoCode(req.user, code);
    if (!applied.ok) {
      return res.status(400).json({ error: applied.error });
    }

    const user = await User.findById(req.user._id);
    const base = user.isPro && user.planExpiresAt && new Date(user.planExpiresAt) > new Date()
      ? new Date(user.planExpiresAt)
      : new Date();

    const expires = new Date(base.getTime() + applied.bonusDays * 86400000);
    user.isPro = true;
    user.planType = user.planType || 'promo';
    user.planExpiresAt = expires;
    await user.save();

    res.json({
      success: true,
      bonusDays: applied.bonusDays,
      planExpiresAt: expires,
      isPro: true
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not redeem code.' });
  }
});

async function applyPromoCode(reqUser, rawCode) {
  const code = rawCode.trim().toUpperCase();

  if (reqUser.promoRedeemed?.includes(code)) {
    return { ok: false, error: 'You have already used this code.' };
  }

  const promo = await PromoCode.findOne({ code });
  if (!promo || !promo.active) {
    return { ok: false, error: 'Invalid or inactive promo code.' };
  }

  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
    return { ok: false, error: 'This promo code has expired.' };
  }

  if (promo.maxRedemptions > 0 && promo.redeemedCount >= promo.maxRedemptions) {
    return { ok: false, error: 'This promo code has been fully redeemed.' };
  }

  const updateFilter = {
    code,
    active: true,
    ...(promo.maxRedemptions > 0 ? { redeemedCount: { $lt: promo.maxRedemptions } } : {})
  };

  const updated = await PromoCode.findOneAndUpdate(
    updateFilter,
    { $inc: { redeemedCount: 1 } },
    { new: true }
  );

  if (!updated) {
    return { ok: false, error: 'This promo code just ran out. Try another.' };
  }

  await User.findByIdAndUpdate(reqUser._id, {
    $addToSet: { promoRedeemed: code }
  });

  return { ok: true, bonusDays: promo.bonusDays, code };
}

// ══════════════════════════════════════════════════════════
//  ADMIN: PROMO CODE MANAGEMENT
// ══════════════════════════════════════════════════════════
app.post('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try {
    const { code, bonusDays, maxRedemptions, expiresAt, note } = req.body;

    if (!code || !bonusDays) {
      return res.status(400).json({ error: 'code and bonusDays are required.' });
    }

    const promo = await PromoCode.create({
      code: code.trim().toUpperCase(),
      bonusDays,
      maxRedemptions: maxRedemptions || 0,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      note: note || ''
    });

    res.json({ promo });
  } catch (e) {
    res.status(500).json({
      error: e.code === 11000 ? 'That code already exists.' : 'Could not create code.'
    });
  }
});

app.get('/api/admin/promo-codes', requireAdmin, async (req, res) => {
  try {
    res.json({
      promoCodes: await PromoCode.find().sort({ createdAt: -1 })
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load.' });
  }
});

app.patch('/api/admin/promo-codes/:code', requireAdmin, async (req, res) => {
  try {
    const promo = await PromoCode.findOneAndUpdate(
      { code: req.params.code.toUpperCase() },
      req.body,
      { new: true }
    );

    if (!promo) {
      return res.status(404).json({ error: 'Not found.' });
    }

    res.json({ promo });
  } catch (err) {
    res.status(500).json({ error: 'Could not update.' });
  }
});

// ══════════════════════════════════════════════════════════
//  ✅ PWA MANIFEST & SERVICE WORKER
// ══════════════════════════════════════════════════════════
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'GRIND AI - JEE & NEET Mentor',
    short_name: 'GRIND',
    description: 'Your AI mentor for JEE and NEET. Real answers, step-by-step derivations.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0E1116',
    theme_color: '#34D399',
    orientation: 'portrait',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ],
    categories: ['education', 'productivity'],
    screenshots: []
  });
});

// ══════════════════════════════════════════════════════════
//  HEALTH CHECK & KEEP-ALIVE
// ══════════════════════════════════════════════════════════
app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));
app.get('/ping', (req, res) => res.json({ status: 'alive', ts: new Date() }));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => { });
  }, 10 * 60 * 1000);
}

// ══════════════════════════════════════════════════════════
//  SPA FALLBACK
// ══════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ══════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🧠 ════════════════════════════════════════════════════════`);
  console.log(`   GRIND AI v6.0 - Enhanced PWA + Streaming + Image Paste`);
  console.log(`════════════════════════════════════════════════════════════`);
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`📅 Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`);

  console.log(`🔑 API Keys Configuration:`);
  console.log(`   🥇 Perplexity: ${PERPLEXITY_KEYS.length} key(s) ${PERPLEXITY_KEYS.length ? '✅ PRIMARY (with Vision)' : '❌'}`);
  console.log(`   🥈 OpenRouter: ${OPENROUTER_KEYS.length} key(s) ${OPENROUTER_KEYS.length ? '✅' : '❌'}`);
  console.log(`   🥉 Groq: ${GROQ_KEYS.length} key(s) ${GROQ_KEYS.length ? '✅' : '❌'}`);
  console.log(`   🥉 Gemini: ${GEMINI_KEYS.length} key(s) ${GEMINI_KEYS.length ? '✅' : '❌'}`);
  console.log(`   🔍 Tavily Search: ${TAVILY_API_KEY ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   🔍 Serper Search: ${SERPER_API_KEY ? '✅ ENABLED' : '❌ DISABLED'}`);

  const totalProviders = PERPLEXITY_KEYS.length + OPENROUTER_KEYS.length + GROQ_KEYS.length + GEMINI_KEYS.length;
  console.log(`\n   Total AI providers: ${totalProviders}`);
  console.log(`   Web search: ${(TAVILY_API_KEY || SERPER_API_KEY) ? 'ENABLED ✅' : 'DISABLED ❌'}`);

  console.log(`\n✨ New Features v6.0:`);
  console.log(`   📱 PWA Support - Install as Chrome app`);
  console.log(`   🎬 Line-by-line streaming responses`);
  console.log(`   📋 Copy-paste image support with OCR`);
  console.log(`   📸 Perplexity Vision for image analysis`);
  console.log(`   📄 PDF text extraction`);
  console.log(`   🌐 Web search integration`);
  console.log(`   🔄 Automatic fallback across all providers`);

  console.log(`\n💰 Cost Management:`);
  console.log(`   • Token limit per user: ${TOKEN_LIMIT.toLocaleString()}`);
  console.log(`   • Emergency downgrade: ${EMERGENCY_DOWNGRADE_CHAIN.length} fallback options`);

  console.log(`\n🎯 Intelligent Fallback Chains:`);
  console.log(`   • Fast mode: ${FALLBACK_CHAIN.fast.length} providers`);
  console.log(`   • Balanced mode: ${FALLBACK_CHAIN.balanced.length} providers`);
  console.log(`   • Deep mode: ${FALLBACK_CHAIN.deep.length} providers`);

  console.log(`\n✨ System Ready! All features active.\n`);
  console.log(`════════════════════════════════════════════════════════════\n`);
});
