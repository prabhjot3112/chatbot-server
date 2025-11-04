// const express = require("express");
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { OpenAI  } from 'openai';
import path from 'path';
// const cors = require("cors");
// const dotenv = require("dotenv");
// const OpenAI = require("openai");
// const path = require("path");
import { InferenceClient } from "@huggingface/inference";
// const InferenceClient = require('@huggingface/inference')

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

import { fileURLToPath } from "url";
// import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new OpenAI({
  baseURL: "https://router.huggingface.co/v1",
  apiKey: process.env.HF_API_KEY,
});

app.use('/embed.js', express.static(path.join(__dirname, 'public/embed.js')));
const apiKey = process.env.HF_API_KEY;
if (!apiKey || typeof apiKey !== "string") {
  throw new Error("❌ Invalid or missing HF_API_KEY in environment");
}

const imageClient = new InferenceClient(({}).apiKey);


async function query(data) {
  const response = await fetch(
    "https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-dev",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`HF API error: ${response.status} ${errText}`);
  }

  return await response.blob();
}


app.post("/api/generate-image", async (req, res) => {
  try {
    const prompt = req.body.prompt;
    if (!prompt) return res.status(400).json({ error: "No prompt provided" });

    console.log("prompt:", prompt);

    const image = await query({ inputs: prompt });

    // Convert Blob → Base64
    const arrayBuffer = await image.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    res.json({ image: `data:image/png;base64,${base64}` });
  } catch (err) {
    console.error("❌ Error generating image:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body.messages.map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    }));

    const completion = await client.chat.completions.create({
      // model: "openai/gpt-oss-safeguard-20b",
      "model":"katanemo/Arch-Router-1.5B:hf-inference",
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
