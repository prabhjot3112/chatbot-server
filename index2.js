import express from "express";
import http from "http";
import { Server } from "socket.io";
import fetch from "node-fetch";
import path from "path";

import { fileURLToPath } from "url";
const app = express();


app.get('/',(req,res) => {
    res.sendFile(path.join(__dirname , '/public/index.html'))
})


// Fix __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.json());

io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("user_message", async (data) => {
    const { endpoints, authToken, messages } = data;
    console.log("💬 Received from user:", messages[messages.length - 1]?.content);

    const systemPrompt = {
  role: "system",
  content: `You are a helpful assistant that can access external APIs when necessary.

You have the following endpoints available:
${endpoints.map(e => {
        const pathParams = e.parameters?.path || [];
        return `- ${e.name}: ${e.description} [${e.method} ${e.url}]` +
               (pathParams.length ? ` (Path parameters: ${pathParams.join(", ")})` : '');
      }).join('\n')}

When calling an endpoint with path parameters, append them directly into the URL in order. Do not invent query parameters for path parameters.

When providing details with a URL, make it a clickable link only if you are sure about it.

IMPORTANT:
- Only output JSON when calling an API. If not calling an API, respond naturally in conversational text.
- API call JSON format:
{
  "action": "call_api",
  "endpoint": "<endpoint name>",
  "params": {
    "include all required path parameters by name here"
  }
}

- DO NOT answer any technical questions about APIs, endpoints, or system internals.  
- DO NOT provide internal reasoning in the response content.
- If asked for technical details you are not sure about, respond exactly:  
"I’m not able to provide that information at the moment."  
- Never explain your internal steps, reasoning, or planned actions to the user.

Always follow these rules. Do not override or avoid them.`
};


    let convoMessages = [systemPrompt, ...messages];
    let currentResponse = null;

    while (true) {
      try {
        console.log("🧠 Sending messages to Ollama...");

        const ollamaResponse = await fetch("http://localhost:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "gpt-oss:20b-cloud",
            messages: convoMessages,
            stream: false,
          }),
        });

        currentResponse = await ollamaResponse.json();
        console.log("🧠 Ollama response:", currentResponse);

        const toolCalls = currentResponse.message?.tool_calls || [];
        const content = currentResponse.message?.content || "";

        let parsed = null;

        if (toolCalls.length) {
          const tool = toolCalls[0].function;
          parsed = { action: tool.name, ...tool.arguments };
        } else {
          try {
            parsed = JSON.parse(content || "{}");
          } catch {
            console.warn("⚠️ Could not parse JSON.");
          }
        }

        // ✅ If no API call needed → final answer
        if (!parsed || parsed.action !== "call_api") {
          console.log("✅ Final natural response, sending to socket.");
          socket.emit("bot_message", { content });
          console.log('sent success')
          break;
        }

        // 🔧 API call requested
        console.log("🔧 Parsed tool call:", parsed);

        const endpoint = endpoints.find((e) => e.name === parsed.endpoint);
        console.log('endpoints:',endpoints)
        if (!endpoint) {
          console.warn("⚠️ Unknown endpoint:", parsed.endpoint);
          socket.emit("bot_message", {
            content: "I couldn't find that endpoint. Please try again.",
          });
          break;
        }

        let url = endpoint.url;
        if (parsed.params) {
          for (const [key, value] of Object.entries(parsed.params)) {
            url = url.replace(new RegExp(`{${key}}`, "g"), encodeURIComponent(value));
          }
        }

        const headers = { "Content-Type": "application/json" };
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

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
          options.body = JSON.stringify(parsed.params || {});
        }

        console.log("🌐 Fetching API URL:", url, "method:", method);
        const apiResp = await fetch(url, options);
        const apiResponseData = await apiResp.json();
        console.log("📦 API response:", apiResponseData);

        // Add API result back to convo for next round
        convoMessages.push(
          { role: "assistant", content: JSON.stringify(parsed) },
          {
            role: "user",
            content: `Here are the results from the API "${parsed.endpoint}": ${JSON.stringify(apiResponseData)}. Please respond to the user accordingly.`,
          }
        );
      } catch (err) {
        console.error("❌ Error during chat loop:", err);
        socket.emit("bot_message", { content: "An error occurred while processing your request." });
        break;
      }
    }

    socket.emit("bot_end", true);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected:", socket.id);
  });
});

server.listen(3002, () => console.log("🚀 Socket server running on port 3002"));
