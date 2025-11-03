import OpenAI from "openai";
import dotenv from 'dotenv'
dotenv.config()
const client = new OpenAI({
  baseURL: "https://router.huggingface.co/v1",
  apiKey: process.env.HF_API_KEY,
});

async function listModels() {
  const response = await fetch("https://huggingface.co/api/models?limit=10", {
    headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` },
  });
  const data = await response.json();
  console.log(data.map((m) => m.modelId));
}

listModels();
