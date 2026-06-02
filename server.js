import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config'; // Crucial for loading variables locally during testing

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Read the keys securely from your Environment Tab configuration
const groqKeys = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3
];

const geminiKeys = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3
];

let currentGroqIndex = 0;
let currentGeminiIndex = 0;

// UNTOUCHED: Your Exact System Prompt
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

// Helper: Try Groq API Pool (Primary Choice)
async function tryGroqPool(recentMessages) {
  for (let i = 0; i < groqKeys.length; i++) {
    try {
      const apiKey = groqKeys[currentGroqIndex];
      
      // If the dashboard field is empty or missing, skip it instantly
      if (!apiKey) {
        throw new Error(`Groq Key at slot ${currentGroqIndex} is empty or undefined.`);
      }

      const formattedMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...recentMessages
      ];

      const response = await fetch("https://groq.com", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: formattedMessages,
          max_tokens: 500,
          temperature: 0.8
        })
      });

      const data = await response.json();
      if (data.choices && data.choices[0]) {
        return data.choices[0].message.content;
      }
      throw new Error(data.error?.message || "Invalid Groq response format");
    } catch (err) {
      console.warn(`Groq Key Index ${currentGroqIndex} failed! Error detail:`, err.message || err);
      currentGroqIndex = (currentGroqIndex + 1) % groqKeys.length;
    }
  }
  throw new Error("Entire Groq Key Pool exhausted.");
}

// Helper: Try Gemini API Pool (Backup Choice)
async function tryGeminiPool(recentMessages) {
  for (let i = 0; i < geminiKeys.length; i++) {
    try {
      const apiKey = geminiKeys[currentGeminiIndex];
      
      // If the dashboard field is empty or missing, skip it instantly
      if (!apiKey) {
        throw new Error(`Gemini Key at slot ${currentGeminiIndex} is empty or undefined.`);
      }

      const url = `https://googleapis.com{apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: recentMessages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.8
          }
        })
      });

      const data = await response.json();
      if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      throw new Error(data.error?.message || "Invalid Gemini response format");
    } catch (err) {
      console.warn(`Gemini Key Index ${currentGeminiIndex} failed! Error detail:`, err.message || err);
      currentGeminiIndex = (currentGeminiIndex + 1) % geminiKeys.length;
    }
  }
  throw new Error("Entire Gemini Key Pool exhausted.");
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' });
  }
  const recentMessages = messages.slice(-6);

  try {
    const reply = await tryGroqPool(recentMessages);
    return res.json({ reply });
  } catch (groqPoolError) {
    console.warn("Groq network down or exhausted. Attempting Gemini Backup Pool...");
    try {
      const reply = await tryGeminiPool(recentMessages);
      return res.json({ reply });
    } catch (geminiPoolError) {
      console.error("Critical Failure: Both Key Pools Exhausted completely for today.");
      return res.status(500).json({ error: 'Servers are fully loaded right now. Please restart your session in a few minutes.' });
    }
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GRIND running on port ${PORT}`);
});
