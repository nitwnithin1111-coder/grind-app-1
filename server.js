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

console.log('🚀 Starting GRIND AI PRO v11...');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true 
  } 
});

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE SETUP
// ═══════════════════════════════════════════════════════════
app.use(cors({ 
  origin: true, 
  credentials: true 
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════
// MONGODB CONNECTION
// ═══════════════════════════════════════════════════════════
console.log('📦 Connecting to MongoDB...');

if (!process.env.MONGODB_URI) {
  console.error('❌ ERROR: MONGODB_URI not set in environment variables');
  process.exit(1);
}

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });

// ═══════════════════════════════════════════════════════════
// DATABASE SCHEMAS
// ═══════════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, sparse: true },
  email: { type: String, required: true },
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
  totalQSolved: { type: Number, default: 0 },
  totalQCorrect: { type: Number, default: 0 },
  weeklyXP: { type: Number, default: 0 },
  weeklyXPReset: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

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
});

const noteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, default: 'Untitled' },
  content: { type: String, default: '' },
  pinned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const ChatSession = mongoose.model('ChatSession', sessionSchema);
const Note = mongoose.model('Note', noteSchema);

console.log('✅ Database schemas initialized');

// ═══════════════════════════════════════════════════════════
// SESSION CONFIGURATION
// ═══════════════════════════════════════════════════════════

if (!process.env.SESSION_SECRET) {
  console.error('❌ ERROR: SESSION_SECRET not set');
  process.exit(1);
}

const sessionConfig = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: process.env.MONGODB_URI,
    touchAfter: 24 * 3600
  }),
  cookie: { 
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
};

app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

console.log('✅ Session configured');

// ═══════════════════════════════════════════════════════════
// PASSPORT GOOGLE OAUTH SETUP
// ═══════════════════════════════════════════════════════════

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ ERROR: Google OAuth credentials not set');
  process.exit(1);
}

console.log('🔐 Setting up Google OAuth...');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      user = new User({
        googleId: profile.id,
        email: profile.emails[0].value,
        name: profile.displayName,
        photo: profile.photos[0]?.value || ''
      });
      await user.save();
      console.log('✅ New user created:', user.email);
    } else {
      console.log('✅ Existing user login:', user.email);
    }
    
    return done(null, user);
  } catch (err) {
    console.error('❌ OAuth error:', err);
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

console.log('✅ Google OAuth configured');

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE HELPERS
// ═══════════════════════════════════════════════════════════

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  console.log('⚠️  Unauthenticated access attempt');
  return res.status(401).json({ error: 'Login required' });
};

// ═══════════════════════════════════════════════════════════
// ROUTES - HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/ping', (req, res) => {
  res.json({ 
    status: 'alive', 
    version: 'v11',
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════
// ROUTES - AUTHENTICATION
// ═══════════════════════════════════════════════════════════

app.get('/auth/google', passport.authenticate('google', { 
  scope: ['profile', 'email'],
  prompt: 'consent'
}));

app.get('/auth/google/callback', 
  passport.authenticate('google', { 
    failureRedirect: '/?error=auth_failed',
    failureMessage: true
  }), 
  (req, res) => {
    console.log('✅ Google OAuth callback successful');
    console.log('User:', req.user.email, 'Onboarded:', req.user.isOnboarded);
    
    if (req.user.isOnboarded) {
      res.redirect('/?loggedin=true');
    } else {
      res.redirect('/?onboarding=true');
    }
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.redirect('/');
  });
});

app.get('/api/auth/status', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json({ 
      authenticated: true, 
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        isOnboarded: req.user.isOnboarded
      }
    });
  }
  res.json({ authenticated: false, user: null });
});

// ═══════════════════════════════════════════════════════════
// ROUTES - USER
// ═══════════════════════════════════════════════════════════

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = req.user;
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
        quizXP: user.quizXP,
        quizLevel: user.quizLevel,
        streak: user.streak,
        weeklyXP: user.weeklyXP,
        totalQSolved: user.totalQSolved,
        totalQCorrect: user.totalQCorrect
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/onboard', requireAuth, async (req, res) => {
  try {
    const { exam, class: cls, coaching, biggestStruggle, hoursPerDay, gender } = req.body;
    
    if (!exam || !cls) {
      return res.status(400).json({ error: 'Exam and class are required' });
    }

    const user = await User.findByIdAndUpdate(req.user._id, {
      exam,
      class: cls,
      coaching,
      biggestStruggle,
      hoursPerDay,
      gender,
      isOnboarded: true
    }, { new: true });

    console.log('✅ User onboarded:', user.email);

    res.json({ 
      success: true,
      user: {
        id: user._id,
        name: user.name,
        isOnboarded: user.isOnboarded
      }
    });
  } catch (err) {
    console.error('Onboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTES - CHAT
// ═══════════════════════════════════════════════════════════

app.post('/api/chat/stream', requireAuth, async (req, res) => {
  try {
    const { messages, sessionId } = req.body;
    const user = req.user;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
    };

    // Simulate AI response (replace with real LLM call)
    let reply = generateMockResponse(messages[messages.length - 1]?.content || '');

    // Stream response word by word
    const words = reply.split(' ');
    for (const word of words) {
      await new Promise(r => setTimeout(r, 50));
      send('chunk', { text: word + ' ' });
    }

    send('done', { reply });

    // Save to session
    if (sessionId && sessionId !== 'new' && sessionId.length === 24) {
      try {
        await ChatSession.findByIdAndUpdate(sessionId, {
          $push: { 
            messages: [
              { role: 'user', content: messages[messages.length - 1].content },
              { role: 'assistant', content: reply }
            ]
          },
          $set: { updatedAt: new Date() }
        }, { upsert: true });
      } catch (e) {
        console.error('Session save error:', e);
      }
    }

    res.end();
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

function generateMockResponse(userMessage) {
  const responses = {
    'hi': 'Hey there! 👋 Welcome to GRIND AI. How can I help you with your studies today?',
    'help': 'I can help you with:\n- Concept explanations\n- Problem solving\n- Mock tests\n- Study planning\n\nWhat would you like to work on?',
    'default': 'That\'s a great question! 🤔\n\nBased on your exam goals, I\'d recommend:\n1. Start with fundamentals\n2. Solve at least 10 practice problems\n3. Review mistakes daily\n\nLet me know if you need more specific help!'
  };

  const key = userMessage.toLowerCase().includes('hi') ? 'hi' 
           : userMessage.toLowerCase().includes('help') ? 'help'
           : 'default';
  
  return responses[key];
}

// ═══════════════════════════════════════════════════════════
// ROUTES - SESSIONS
// ═══════════════════════════════════════════════════════════

app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await ChatSession.find({ userId: req.user._id })
      .select('title createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .limit(30);
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/new', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.create({
      userId: req.user._id,
      title: 'New Chat',
      messages: []
    });
    res.json({ sessionId: session._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  try {
    const session = await ChatSession.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTES - NOTES
// ═══════════════════════════════════════════════════════════

app.get('/api/notes', requireAuth, async (req, res) => {
  try {
    const notes = await Note.find({ userId: req.user._id })
      .sort({ pinned: -1, updatedAt: -1 });
    res.json({ notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    const note = await Note.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!note) return res.status(404).json({ error: 'Not found' });
    res.json({ note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', requireAuth, async (req, res) => {
  try {
    await Note.deleteOne({ _id: req.params.id, userId: req.user._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ROUTES - ANALYTICS (MOCK)
// ═══════════════════════════════════════════════════════════

app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    res.json({
      summary: {
        level: user.quizLevel || 1,
        xpThisWeek: user.weeklyXP || 0,
        streak: user.streak || 0,
        totalStudyHours: 142,
        avgAccuracy: 78,
        mockTestsAttempted: 5
      },
      charts: {
        dailyXP: [
          { date: '2024-12-15', xp: 240 },
          { date: '2024-12-16', xp: 180 },
          { date: '2024-12-17', xp: 320 }
        ],
        accuracy: [
          { date: '2024-12-15', accuracy: 82 },
          { date: '2024-12-16', accuracy: 78 },
          { date: '2024-12-17', accuracy: 85 }
        ],
        subjectMastery: { Physics: 84, Chemistry: 79, Math: 71 }
      },
      recommendations: [
        'Focus on Thermodynamics',
        'Keep your streak alive! 🔥'
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SPA FALLBACK
// ═══════════════════════════════════════════════════════════

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message 
  });
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  🧠 GRIND AI PRO v11 STARTED SUCCESSFULLY  ║
╚════════════════════════════════════════════╝

🌐 Server running on port: ${PORT}
📍 Environment: ${process.env.NODE_ENV || 'development'}
🔗 MongoDB: Connected
🔐 OAuth: Configured
🚀 Ready for users!

Access at: http://localhost:${PORT}
  `);
});

module.exports = server;
