const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const path = require("path");

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  baseURL: "https://router.huggingface.co/v1",
  apiKey: process.env.HF_API_KEY,
});

app.use('/embed.js', express.static(path.join(__dirname, 'public/embed.js')));

app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body.messages.map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    }));

    const completion = await client.chat.completions.create({
      model: "openai/gpt-oss-safeguard-20b",
      messages,
      temperature: 0.7,
      max_tokens: 200,
    });
    console.log('completion:',completion)
    console.log(completion.choices[0].message)
    const message = completion.choices[0].message
    // Hugging Face returns the first assistant message in this path
    const reply = completion.choices[0].message.content[0].text;
    console.log('reply is:',reply)

    res.json({
  role: message.role,
  content: message.content,
  name: message.name,
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch from Hugging Face" });
  }
});

const PORT = 3002;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
