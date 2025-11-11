import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());


async function fetchApi(endpoint, params = {}, authToken) {
  let url = endpoint.url;
  const method = endpoint.method.toUpperCase();
  const headers = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  // Inject path parameters into URL
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (url.includes(`{${k}}`)) url = url.replace(`{${k}}`, encodeURIComponent(String(v)));
    }
  }

  const options = { method, headers };

  // Handle request body for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(method)) {
    options.body = JSON.stringify(params);
  }

  // Handle query params for GET/DELETE
  if (["GET", "DELETE"].includes(method)) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (!url.includes(`{${k}}`) && v !== undefined && v !== null) query.append(k, String(v));
    }
    if (query.toString()) url += (url.includes("?") ? "&" : "?") + query.toString();
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${text}`);
  }

  // Try parsing JSON, fallback to text
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}


io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("user_message", async (data) => {
    const { endpoints, authToken, messages, domain, extraData } = data;
    console.log('endpoints:',endpoints)
    try {
      // --- Dynamic system prompt ---
    const systemPrompt = `
You are a highly intelligent assistant for domain: ${domain || "general"}.
Extra reference: ${extraData || "N/A"}.

Available APIs:
${(endpoints || []).map(e => {
  const pathParams = e.parameters?.path || [];
  return `- ${e.name}: ${e.description} [${e.method} ${e.url}]` +
         (pathParams.length ? ` (Path params: ${pathParams.join(", ")})` : '');
}).join("\n")}

Rules:
- Only call an API if the user's request requires it.
- If you need to fetch data, respond ONLY with JSON:
{
  "action": "call_api",
  "endpoint": "<endpoint name>",
  "params": { ... }
}
- Do NOT invent data or hallucinate results.
- If no API call is needed, respond naturally in plain text using only known information.
- If API returns empty data, reply: "No results found" or similar neutral phrasing.
- Domain can be anything: teachers, mentors, planets, weather, etc.
- Do not assume e-commerce or any specific domain.
- Always be concise, user-friendly, and context-aware.
`;

     const firstResp = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-oss:20b-cloud",
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
    ],
    stream: false
  }),
});

const firstData = await firstResp.json();
console.log('firstData:', firstData);
if(firstData.message){
  if(firstData.message.tool_calls)
  console.log('tool_calls',firstData.message.tool_calls)
}
let apiCall = null;

// Step 1: Try parsing JSON from content
let firstContent = firstData.message?.content || "";
try {
  const parsed = JSON.parse(firstContent.replace(/<[^>]*>/g, ""));
  if (parsed.action === "call_api" && parsed.endpoint) {
    apiCall = parsed;
  }
} catch {}

// Step 2: Heuristic fallback: scan thinking for known endpoint URLs or names
if (!apiCall && firstData.message?.thinking) {
  for (const ep of endpoints) {
    if (firstData.message.thinking.includes(ep.name) || firstData.message.thinking.includes(ep.url)) {
      apiCall = { action: "call_api", endpoint: ep.name, params: {} };
      break;
    }
  }
}

// Step 3: Optional: check tool_calls but ONLY if arguments contain endpoint info
if (!apiCall && Array.isArray(firstData.message?.tool_calls)) {
  for (const toolCall of firstData.message.tool_calls) {
    const args = toolCall.function?.arguments || {};
    for (const ep of endpoints) {
      if (JSON.stringify(args).includes(ep.name) || JSON.stringify(args).includes(ep.url)) {
        apiCall = { action: "call_api", endpoint: ep.name, params: {} };
        break;
      }
    }
    if (apiCall) break;
  }
}

// Step 4: If still no apiCall, fallback to human content
if (!apiCall) {
  socket.emit("bot_message", { content: firstContent || "Sorry, couldn't understand your request." });
  socket.emit("bot_end", true);
  return;
}

console.log("API call detected:", apiCall);


// Stage 2: execute API only if valid endpoint
let apiData = null;
if (apiCall) {
  console.log('api call detected')
  const endpoint = endpoints.find(e => e.name === apiCall.endpoint);
  if (!endpoint) {
    console.log('endpoint not found')
    apiCall = null; // Skip if endpoint not found
  } else {
    console.log('endpoint to fetch:',endpoint)
    apiData = await fetchApi(endpoint, apiCall.params, authToken);

    console.log('apiData:',apiData)
  }
}

// Stage 3: always ask LLM to produce final message
const finalMessages = [
  { role: "system", content: systemPrompt },
  ...messages
];
if (apiCall) {
  finalMessages.push(
    { role: "assistant", content: JSON.stringify(apiCall) },
    { role: "user", content: `Here are the API results: ${JSON.stringify(apiData || {})}. Respond naturally, concisely.` }
  );
}

const finalResp = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-oss:20b-cloud", messages: finalMessages , stream:false })
});
const finalData = await finalResp.json();
console.log('finalData:',finalData)
const finalContent = finalData.message?.content || "No response generated.";
socket.emit("bot_message", { content: finalContent });
socket.emit("bot_end", true);
    } catch (err) {
      console.error("❌ Chat error:", err);
      socket.emit("bot_message", { content: "Something went wrong while processing your request." });
      socket.emit("bot_end", true);
    }
  });

  socket.on("disconnect", () => console.log("🔴 Client disconnected:", socket.id));
});

server.listen(3002, () => console.log("🚀 Socket server running on port 3002"));
