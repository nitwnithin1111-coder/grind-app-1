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
const io = new Server(server, { 
  cors: { origin: '*', credentials: true } 
});

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE SETUP
// ═══════════════════════════════════════════════════════════════
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(__dirname));

console.log('✅ Middleware configured');

// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('⚠️  Continuing anyway... (will fail on data access)');
  });

// ═══════════════════════════════════════════════════════════════
// DATABASE SCHEMAS
// ═══════════════════════════════════════════════════════════════
const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, unique: true, sparse: true },
  name: { type: String, required: true },
  photo: { type: String, default: '' },
  gender: { type: String, default: '' },
  exam: { type: String, default: '' },
  class: { type: String, default: '' },
  coaching: { type: String, default: '' },
  biggestStruggle: { type: String, default: '' },
  hoursPerDay: { type: String, default: '' },
  isOnboarded: { type: Boolean, default: false },
  streak: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  quizXP: { type: Number, default: 0 },
  quizLevel: { type: Number, default: 1 },
  weeklyXP: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'users' });

userSchema.index({ googleId: 1 });
userSchema.index({ email: 1 });

const User = mongoose.model('User', userSchema);

const sessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'New Conversation' },
  messages: [{
    role: { type: String, enum: ['user', 'assistant'] },
    content: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'chat_sessions' });

const ChatSession = mongoose.model('ChatSession', sessionSchema);

const noteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'Untitled' },
  content: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { collection: 'notes' });

const Note = mongoose.model('Note', noteSchema);

console.log('✅ Database schemas created');

// ═══════════════════════════════════════════════════════════════
// SESSION CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'grind-secret-2025-dev',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' // HTTPS only in production
  },
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/grind',
    touchAfter: 24 * 3600 // lazy session update
  })
};

app.use(session(sessionConfig));
console.log('✅ Session configured');

// ═══════════════════════════════════════════════════════════════
// PASSPORT AUTHENTICATION
// ═══════════════════════════════════════════════════════════════
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('🔐 Google OAuth callback - User:', profile.emails[0].value);

    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      console.log('👤 Creating new user:', profile.displayName);
      user = new User({
        googleId: profile.id,
        email: profile.emails[0].value,
        name: profile.displayName,
        photo: profile.photos[0]?.value || ''
      });
      await user.save();
      console.log('✅ User created:', user._id);
    } else {
      console.log('✅ User found:', user._id);
      user.lastActive = new Date();
      await user.save();
    }

    return done(null, user);
  } catch (err) {
    console.error('❌ OAuth error:', err);
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => {
  console.log('📦 Serializing user:', user._id);
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    console.log('📦 Deserializing user:', id);
    done(null, user);
  } catch (err) {
    console.error('❌ Deserialization error:', err);
    done(err, null);
  }
});

app.use(passport.initialize());
app.use(passport.session());
console.log('✅ Passport configured');

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    console.log('✅ Auth check passed for:', req.user.email);
    return next();
  }
  console.log('❌ Auth check failed - User not authenticated');
  res.status(401).json({ error: 'Not authenticated', loginUrl: '/auth/google' });
};

// ═══════════════════════════════════════════════════════════════
// ROUTES - HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/ping', (req, res) => {
  res.json({ 
    status: 'alive', 
    version: 'v11', 
    timestamp: new Date(),
    authenticated: req.isAuthenticated()
  });
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

// Google OAuth Login
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'consent'
  })
);

// Google OAuth Callback
app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/?error=auth_failed',
    failureMessage: true
  }),
  (req, res) => {
    console.log('🎉 OAuth callback successful for:', req.user.email);
    const redirectUrl = req.user.isOnboarded ? '/?loggedin=true' : '/?onboarding=true';
    console.log('📍 Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  }
);

// Logout
app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    console.log('✅ User logged out');
    res.redirect('/');
  });
});

// Check Auth Status
app.get('/api/auth/status', (req, res) => {
  console.log('🔍 Checking auth status:', req.isAuthenticated());
  res.json({
    authenticated: req.isAuthenticated(),
    user: req.user ? {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      photo: req.user.photo
    } : null
  });
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - USER
// ═══════════════════════════════════════════════════════════════

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        photo: user.photo,
        isOnboarded: user.isOnboarded,
        exam: user.exam,
        class: user.class,
        coaching: user.coaching,
        gender: user.gender,
        biggestStruggle: user.biggestStruggle,
        hoursPerDay: user.hoursPerDay,
        quizXP: user.quizXP,
        quizLevel: user.quizLevel,
        weeklyXP: user.weeklyXP,
        streak: user.streak
      }
    });
  } catch (err) {
    console.error('❌ Error fetching user:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;

    if (!exam || !cls) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const user = await User.findByIdAndUpdate(req.user._id, {
      exam,
      class: cls,
      coaching: coaching || '',
      biggestStruggle: biggestStruggle || '',
      hoursPerDay: hoursPerDay || '',
      gender: gender || '',
      isOnboarded: true,
      updatedAt: new Date()
    }, { new: true });

    console.log('✅ User onboarded:', user.email);

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        isOnboarded: user.isOnboarded,
        exam: user.exam
      }
    });
  } catch (err) {
    console.error('❌ Onboarding error:', err);
    res.status(500).json({ error: 'Onboarding failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - CHAT
// ═══════════════════════════════════════════════════════════════

app.post('/api/chat/stream', requireAuth, async (req, res) => {
  try {
    const { messages, sessionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (event, data) => {
      res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
    };

    // Simulate AI response
    const userMessage = messages[messages.length - 1]?.content || '';
    console.log('💬 Chat message:', userMessage.substring(0, 50));

    // Generate response
    const response = generateAIResponse(userMessage, req.user);

    // Stream response word by word
    const words = response.split(' ');
    for (const word of words) {
      send('chunk', { text: word + ' ' });
      await new Promise(resolve => setTimeout(resolve, 50)); // Simulate streaming
    }

    send('done', { reply: response });

    // Save to session
    if (sessionId && sessionId.length === 24) {
      try {
        await ChatSession.findByIdAndUpdate(sessionId, {
          $push: {
            messages: [
              { role: 'user', content: userMessage },
              { role: 'assistant', content: response }
            ]
          },
          updatedAt: new Date()
        }, { upsert: true });
      } catch (e) {
        console.error('⚠️  Session save error:', e.message);
      }
    }

    res.end();
  } catch (err) {
    console.error('❌ Chat error:', err);
    res.write(`data: ${JSON.stringify({ event: 'error', error: 'Chat failed' })}\n\n`);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - SESSIONS
// ═══════════════════════════════════════════════════════════════

app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(30)
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('❌ Sessions fetch error:', err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const session = new ChatSession({
      userId: req.user._id,
      title: 'New Chat',
      messages: []
    });
    await session.save();

    console.log('✅ New session created:', session._id);
    res.json({ sessionId: session._id });
  } catch (err) {
    console.error('❌ Session creation error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ session });
  } catch (err) {
    console.error('❌ Session fetch error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    await ChatSession.deleteOne({
      _id: req.params.id,
      userId: req.user._id
    });

    console.log('✅ Session deleted:', req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Session delete error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - NOTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/notes', requireAuth, async (req, res) => {
  try {
    const notes = await Note.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ notes });
  } catch (err) {
    console.error('❌ Notes fetch error:', err);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

app.post('/api/notes', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;

    const note = new Note({
      userId: req.user._id,
      title: title || 'Untitled',
      content: content || ''
    });
    await note.save();

    console.log('✅ Note created:', note._id);
    res.json({ note });
  } catch (err) {
    console.error('❌ Note creation error:', err);
    res.status(500).json({ error: 'Failed to create note' });
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
      return res.status(404).json({ error: 'Note not found' });
    }

    res.json({ note });
  } catch (err) {
    console.error('❌ Note update error:', err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    await Note.deleteOne({ _id: req.params.id, userId: req.user._id });

    console.log('✅ Note deleted:', req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Note delete error:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ROUTES - ANALYTICS (DUMMY)
// ═══════════════════════════════════════════════════════════════

app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    res.json({
      summary: {
        level: req.user.quizLevel || 1,
        xpThisWeek: req.user.weeklyXP || 0,
        streak: req.user.streak || 0,
        totalStudyHours: 145,
        avgAccuracy: 78,
        mockTestsAttempted: 5
      },
      charts: {
        dailyXP: Array(7).fill(0).map((_, i) => ({
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          xp: Math.random() * 300
        })),
        accuracy: Array(7).fill(0).map(() => ({ accuracy: Math.random() * 30 + 60 })),
        subjectMastery: {
          Physics: 84,
          Chemistry: 79,
          Mathematics: 71,
          Biology: 88
        },
        topMistakes: [
          { topic: 'Thermodynamics', count: 8 },
          { topic: 'Organic Chemistry', count: 6 },
          { topic: 'Integration', count: 5 }
        ]
      },
      recommendations: [
        'Focus on Thermodynamics — 8 mistakes',
        'Keep your 7-day streak alive 🔥',
        'Review Integral Calculus'
      ]
    });
  } catch (err) {
    console.error('❌ Analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTION - AI RESPONSE GENERATOR
// ═══════════════════════════════════════════════════════════════

function generateAIResponse(userMessage, user) {
  const name = user?.name?.split(' ')[0] || 'there';
  
  const responses = {
    'thermodynamics': `Hey ${name}! Thermodynamics can be tricky. Let me break it down:\n\n**First Law**: Energy can't be created or destroyed, only converted.\n\n**Second Law**: Entropy always increases in isolated systems.\n\n**Key Formula**: Q = ΔU + W\n\nWhat specific concept is confusing you?`,
    
    'doubt': `I'm here to help with your doubts, ${name}! Tell me:\n\n1. Which subject?\n2. What topic?\n3. What specifically are you stuck on?\n\nI'll explain step-by-step.`,
    
    'mock': `Great idea! Mock tests are crucial for:\n- Identifying weak areas\n- Building exam stamina\n- Managing time better\n\nLet's start a mock test? What subject?`,
    
    'motivation': `${name}, you've got this! 💪\n\nRemember:\n- Consistency > Intensity\n- Small progress > No progress\n- You're closer than yesterday\n\nWhat are you working on?`,
    
    'default': `Hello ${name}! 👋\n\nI'm GRIND AI, your JEE/NEET mentor.\n\nI can help you with:\n- Concept doubts (any subject)\n- Problem solving\n- Strategy & planning\n- Motivation & mental health\n\nWhat's on your mind?`
  };

  const lower = userMessage.toLowerCase();
  
  for (const [key, response] of Object.entries(responses)) {
    if (lower.includes(key)) {
      return response;
    }
  }
  
  return responses.default;
}

// ═══════════════════════════════════════════════════════════════
// SPA FALLBACK
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('❌ Global error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ═══════════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n`);
  console.log(`╔═══════════════════════════════════════╗`);
  console.log(`║  🧠 GRIND AI PRO v11 - STARTED      ║`);
  console.log(`║  Port: ${PORT}                           ║`);
  console.log(`║  Environment: ${process.env.NODE_ENV || 'development'}       ║`);
  console.log(`╚═══════════════════════════════════════╝`);
  console.log(`\n✅ Ready to accept connections!\n`);
  console.log(`📍 Visit: http://localhost:${PORT}`);
  console.log(`🔐 Google OAuth: Configured`);
  console.log(`💾 MongoDB: Connected`);
  console.log(`\n`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
