// const express = require("express");
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { OpenAI  } from 'openai';
import jwt from 'jsonwebtoken'
import path from 'path';
// const cors = require("cors");
// const dotenv = require("dotenv");
// const OpenAI = require("openai");
// const path = require("path");
import { InferenceClient } from "@huggingface/inference";
// const InferenceClient = require('@huggingface/inference')

dotenv.config();
const app = express();
app.use(cors(
  {
    origin:[
      'http://localhost:5173'
      ,
      'http://localhost:5174',
      'https://i-shop31.vercel.app'

    ]
  }
));
app.use(express.json());

import { fileURLToPath } from "url";
import router from './routes/CometAPI.js';
import chutesRouter from './routes/ChutesAPI.js';
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






export default router;


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
    const { endpoints, authToken } = req.body;

    // 🔹 Build system prompt
    const systemPrompt = {
      role: "system",
      content: `
You are a helpful assistant that can access external APIs when necessary.

You have the following endpoints available:
${endpoints.map(e => {
        const pathParams = e.parameters?.path || [];
        return `- ${e.name}: ${e.description} [${e.method} ${e.url}]` +
               (pathParams.length ? ` (Path parameters: ${pathParams.join(", ")})` : '');
      }).join('\n')}

When you need to call an endpoint that has path parameters, you MUST append the path parameters directly into the URL in order, instead of using query parameters.
Only respond the user in conversational tone....not in a tone where user see that you are thinking or planning steps to execute the response. don't do it.
User might only see the output as a conversational , not the idea about you and your thinking steps etc. 
Respond ONLY in this JSON format:

{
  "action": "call_api",
  "endpoint": "<endpoint name>",
  "params": {
    "include all required path parameters by name here"
  }
}

Do NOT invent query parameters for path parameters.
`
    };

    let messages = [systemPrompt, ...req.body.messages];
    let currentResponse = null;

    console.log("🔹 Starting chat with AIMLAPI...");

    // 🔁 Keep looping until there are no more tool calls
    while (true) {
      try {
        // ========== 🧠 AIMLAPI REQUEST ==========
        const aimlResponse = await fetch("https://api.aimlapi.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.AIMLAPI_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o", // You can change to another model
            messages,
            temperature: 0.7,
          }),
        });

        currentResponse = await aimlResponse.json();
        console.log("🧠 AIMLAPI response:", currentResponse);

        const message = currentResponse.choices?.[0]?.message;
        const content = message?.content || "";
        const toolCalls = message?.tool_calls || [];


        // ======================================================
        // 💤 OLD OLLAMA CALL (COMMENTED OUT FOR REFERENCE)
        // ======================================================
        /*
        const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-oss:20b-cloud",
            messages,
            stream: false
          }),
        });

        currentResponse = await ollamaResponse.json();
        console.log("🧠 Ollama response:", currentResponse);

        const toolCalls = currentResponse.message?.tool_calls || [];
        const content = currentResponse.message?.content || "";
        */
        // ======================================================

        let parsed = null;

        if (toolCalls.length) {
          const tool = toolCalls[0].function;
          parsed = { action: tool.name, ...tool.arguments };
        } else {
          // fallback: try parse assistant content as JSON
          try {
            parsed = JSON.parse(content || '{}');
          } catch (e) {
            console.warn("⚠️ Could not parse assistant JSON:", e);
          }
        }

        // If no valid tool call, exit loop
        if (!parsed || parsed.action !== "call_api") break;

        console.log('🔧 Parsed tool call:', parsed);

        const endpoint = endpoints.find(e => e.name === parsed.endpoint);
        if (!endpoint) {
          console.warn("⚠️ Unknown endpoint requested:", parsed.endpoint);
          break;
        }

        // 🔹 Build full URL (replace path params)
        let url = endpoint.url;
        if (parsed.params) {
          for (const [key, value] of Object.entries(parsed.params)) {
            url = url.replace(new RegExp(`{${key}}`, "g"), encodeURIComponent(value));
          }
        }

        // 🔹 Prepare headers
        const headers = { "Content-Type": "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        // 🔹 Prepare fetch options
        const method = endpoint.method.toUpperCase();
        const options = { method, headers };

        if (["GET", "DELETE"].includes(method)) {
          const queryParams = new URLSearchParams();
          for (const [key, value] of Object.entries(parsed.params || {})) {
            if (!url.includes(`{${key}}`) && value !== undefined && value !== null) {
              queryParams.append(key, value);
            }
          }
          if (queryParams.toString()) {
            url += (url.includes("?") ? "&" : "?") + queryParams.toString();
          }
        } else if (["POST", "PUT", "PATCH"].includes(method)) {
          console.log('trying ppp request , parsed.params are:', parsed.params);
          options.body = JSON.stringify(parsed.params || {});
        }

        console.log("🌐 Fetching API URL:", url, "method:", method);
        const apiResp = await fetch(url, options);
        const apiResponseData = await apiResp.json();
        console.log("📦 API response data:", apiResponseData);

        // 🔹 Feed API result back to model
        const replySummary = JSON.stringify(parsed);
        messages.push(
          { role: "assistant", content: replySummary },
          {
            role: "user",
            content: `Here are the results from the API "${parsed.endpoint}": ${JSON.stringify(apiResponseData)}. Please respond to the user accordingly.`
          }
        );
      } catch (e) {
        console.error("❌ Error during AIMLAPI loop:", e);
        return res.json({ msg: 'Error occurred during AIMLAPI processing' });
      }
    }

    console.log("✅ Final response to send:", currentResponse);
    return res.json(currentResponse);

  } catch (err) {
    console.error("❌ Error in /api/chat:", err);
    return res.status(500).json({ error: "Failed to fetch from AIMLAPI" });
  }
});


app.use('/api',router)
app.use('/api',chutesRouter)




app.post("/api/chat2", async (req, res) => {
  try{
    const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-oss:20b-cloud",
    messages: req.body.messages,
    stream:false
  }),
});
const data = await ollamaResponse.json();
res.json(data)
console.log(data)
  }catch (err) {
    console.error("Error in /api/chat:", err);
    res.status(500).json({ error: "Failed to fetch from Ollama" });
  }
});


const PORT = 3002;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
