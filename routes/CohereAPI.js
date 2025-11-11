import express from "express";
import { CohereClientV2 } from "cohere-ai";
import fetch from "node-fetch";

const cohere = new CohereClientV2({ token: process.env.CO_API_KEY });
const cohereRouter = express.Router();

// POST /api/cohere/chat
cohereRouter.post("/cohere/chat", async (req, res) => {
  try {
    const { messages, endpoints = [], authToken } = req.body;

    if (!messages || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Messages array is required" });
    }
    
     const systemPrompt = {
  role: "system",
  content:systemPrompt(endpoints)
};

    let chatMessages = [systemPrompt(endpoints), ...messages];
    let maxIterations = 5; // safety limit
    let iteration = 0;
    let assistantFinalResp = null;

    console.log("🔹 Starting Cohere chat...");

    while (iteration < maxIterations) {
      iteration++;

      // Call Cohere Chat
      const cohereResp = await cohere.chat({
        model: "command-a-03-2025",
        messages: chatMessages,
        temperature: 0.3,
      });

      // Cohere V2 content is an array
      const contentArray = cohereResp.message?.content || [];
      const content = contentArray
        .map(item => item.type === "text" ? item.text : "")
        .join("\n")
        .trim();

      console.log("Assistant content:", content);

      let parsed = null;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // If JSON parsing fails, treat as final text response
        assistantFinalResp = content;
        break;
      }

      if (!parsed || parsed.action !== "call_api") {
        assistantFinalResp = content;
        break;
      }

      console.log("🔧 Parsed tool call:", parsed);

      const endpoint = endpoints.find(e => e.name === parsed.endpoint);
      if (!endpoint) {
        assistantFinalResp = `Unknown endpoint requested: ${parsed.endpoint}`;
        break;
      }

      // Build URL with path params
      let url = endpoint.url;
      if (parsed.params) {
        for (const [key, value] of Object.entries(parsed.params)) {
          url = url.replace(new RegExp(`{${key}}`, "g"), encodeURIComponent(value));
        }
      }

      // Prepare headers
      const headers = { "Content-Type": "application/json" };
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

      const method = endpoint.method.toUpperCase();
      const options = { method, headers };

      if (["POST", "PUT", "PATCH"].includes(method)) {
        options.body = JSON.stringify(parsed.params || {});
      } else if (["GET", "DELETE"].includes(method)) {
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed.params || {})) {
          if (!url.includes(`{${key}}`) && value !== undefined && value !== null) {
            queryParams.append(key, value);
          }
        }
        if (queryParams.toString()) url += (url.includes("?") ? "&" : "?") + queryParams.toString();
      }

      console.log("🌐 Fetching API URL:", url, "method:", method);
      const apiResp = await fetch(url, options);
      const apiResponseData = await apiResp.json();
      console.log("📦 API response data:", apiResponseData);

      // Feed API result back to Cohere chat
      chatMessages.push(
        { role: "assistant", content: JSON.stringify(parsed) },
        { role: "user", content: `Here are the results from "${parsed.endpoint}": ${JSON.stringify(apiResponseData)}. Respond conversationally.` }
      );
    }

    return res.json({ response: assistantFinalResp });

  } catch (err) {
    console.error("❌ Error in /api/cohere/chat:", err);
    return res.status(500).json({ error: "Failed to fetch from Cohere API" });
  }
});

export default cohereRouter;
