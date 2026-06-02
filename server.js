require('dotenv').config(); // Loads variables safely from your environment panel
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' });
  }

  const recentMessages = messages.slice(-6);
  
  // FIXED PAYLOAD STRUCTURING: Checks both .content and .text to prevent empty payloads
  const formattedMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...recentMessages.map(m => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user',
      content: m.content || m.text || ""
    }))
  ];

  try {
    const response = await fetch(
      "https://groq.com",
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant", // High speed free model
          messages: formattedMessages,
          max_tokens: 500,
          temperature: 0.8
        })
      }
    );

    // FIXED PARSING SAFETY: Reads response as pure text first to avoid JSON crash loops
    const responseText = await response.text();
    
    if (!responseText) {
      console.error("Groq returned an empty text string response package.");
      return res.status(500).json({ error: "Empty server feedback received from Groq." });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("Failed to parse raw text response to JSON object. Raw content was:", responseText);
      return res.status(500).json({ error: "Server format communication error." });
    }

    if (data.error) {
      console.error('Groq Engine Internal Error Flag:', data.error);
      return res.status(500).json({ error: data.error.message });
    }

    if (data.choices && data.choices[0] && data.choices[0].message) {
      const reply = data.choices[0].message.content;
      res.json({ reply });
    } else {
      console.error('Unexpected payload layout received from Groq network response:', data);
      res.status(500).json({ error: 'Failed to extract content message layout stream.' });
    }

  } catch (err) {
    console.error('Server connection loop crash handled:', err);
    res.status(500).json({ error: 'Server context timeout. Try hitting it again.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GRIND running on port ${PORT}`);
});
