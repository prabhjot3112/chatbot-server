import express from "express";
import fetch from "node-fetch"; 
const chutesRouter = express.Router();

// POST /api/chutes/chat-mcp
chutesRouter.post("/chutes/chat", async (req, res) => {
  try {
    const { messages, endpoints = [], authToken } = req.body;

    if (!messages || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    // 🔹 Build system prompt for MCP
    const systemPrompt = {
      role: "system",
      content: `
You are a helpful assistant that can access external APIs when necessary.

You have the following endpoints available:
${endpoints.map(e => {
        const pathParams = e.parameters?.path || [];
        return `- ${e.name}: ${e.description} [${e.method} ${e.url}]` +
               (pathParams.length ? ` (Path parameters: ${pathParams.join(", ")})` : '');
      }).join("\n")}

When you need to call an endpoint that has path parameters, you MUST append the path parameters directly into the URL in order, instead of using query parameters.
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

    let chatMessages = [systemPrompt, ...messages];
    let currentResponse = null;

    console.log("🔹 Starting MCP chat with ChutesAPI...");

    while (true) {
      try {
        // 🔹 Ask Chutes API for next step
        const chutesResponse = await fetch("https://llm.chutes.ai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.CHUTES_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "zai-org/GLM-4.5-Air",
            messages: chatMessages,
            max_tokens: 1024,
            temperature: 0.7,
          }),
        });

        currentResponse = await chutesResponse.json();
        console.log("🧠 Chutes response:", currentResponse);

        const message = currentResponse.choices?.[0]?.message;
        const content = message?.content || "";
        const toolCalls = message?.tool_calls || [];

        let parsed = null;

        if (toolCalls.length) {
          const tool = toolCalls[0].function;
          parsed = { action: tool.name, ...tool.arguments };
        } else {
          try {
            parsed = JSON.parse(content || '{}');
          } catch (e) {
            console.warn("⚠️ Could not parse assistant JSON:", e);
          }
        }

        if (!parsed || parsed.action !== "call_api") break;

        console.log("🔧 Parsed tool call:", parsed);

        const endpoint = endpoints.find(e => e.name === parsed.endpoint);
        if (!endpoint) {
          console.warn("⚠️ Unknown endpoint requested:", parsed.endpoint);
          break;
        }

        // 🔹 Build URL with path params
        let url = endpoint.url;
        if (parsed.params) {
          for (const [key, value] of Object.entries(parsed.params)) {
            url = url.replace(new RegExp(`{${key}}`, "g"), encodeURIComponent(value));
          }
        }

        // 🔹 Prepare headers
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
          if (queryParams.toString()) url += (url.includes("?") ? "&" : "?") + queryParams.toString();
        } else if (["POST", "PUT", "PATCH"].includes(method)) {
          options.body = JSON.stringify(parsed.params || {});
        }

        console.log("🌐 Fetching API URL:", url, "method:", method);
        const apiResp = await fetch(url, options);
        const apiResponseData = await apiResp.json();
        console.log("📦 API response data:", apiResponseData);

        // 🔹 Feed API result back to Chutes model
        chatMessages.push(
          { role: "assistant", content: JSON.stringify(parsed) },
          { role: "user", content: `Here are the results from "${parsed.endpoint}": ${JSON.stringify(apiResponseData)}. Respond conversationally.` }
        );

      } catch (e) {
        console.error("❌ Error during MCP loop:", e);
        return res.json({ msg: "Error occurred during Chutes MCP processing" });
      }
    }

    console.log("✅ Final MCP response:", currentResponse);
    return res.json(currentResponse);

  } catch (err) {
    console.error("❌ Error in /api/chutes/chat-mcp:", err);
    return res.status(500).json({ error: "Failed to fetch from Chutes API" });
  }
});

export default chutesRouter;
