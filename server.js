const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── 10 API KEYS ─────────────────────────────────────────
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

let geminiIndex = 0;
let groqIndex = 0;

const SYSTEM_PROMPT = `You are GRIND — an AI built specifically for JEE and NEET aspirants in India. You are not a motivational bot. You are a brutally honest, deeply empathetic companion that actually understands the Indian competitive exam ecosystem from the inside.

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
- [FOCUS: the one topic to hit today]`;

// ── GEMINI CALL ─────────────────────────────────────────
async function callGemini(messages) {
  const key = GEMINI_KEYS[geminiIndex % GEMINI_KEYS.length];
  geminiIndex++;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: 500, temperature: 0.8 }
      })
    }
  );
  const data = await response.json();
  if (data.error) throw new Error('GEMINI: ' + data.error.message);
  return data.candidates[0].content.parts[0].text;
}

// ── GROQ CALL ───────────────────────────────────────────
async function callGroq(messages) {
  const key = GROQ_KEYS[groqIndex % GROQ_KEYS.length];
  groqIndex++;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
      ]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error('GROQ: ' + data.error.message);
  return data.choices[0].message.content;
}

// ── CHAT ROUTE ──────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' });
  }

  const recentMessages = messages.slice(-6);

  // Try all Gemini keys first
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      const reply = await callGemini(recentMessages);
      console.log(`Gemini key ${i + 1} worked ✅`);
      return res.json({ reply });
    } catch (err) {
      console.log(`Gemini key ${i + 1} failed ❌:`, err.message);
    }
  }

  // All Gemini failed — try all Groq keys
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try {
      const reply = await callGroq(recentMessages);
      console.log(`Groq key ${i + 1} worked ✅`);
      return res.json({ reply });
    } catch (err) {
      console.log(`Groq key ${i + 1} failed ❌:`, err.message);
    }
  }

  // All 10 failed
  res.status(500).json({ 
    error: 'Taking a breather. Try again in 2 minutes.' 
  });
});

// ── SERVE FRONTEND ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GRIND running on port ${PORT}`);
});
