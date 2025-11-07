import express from "express";
import fetch from "node-fetch"; 
const router = express.Router();

router.post("/comet/chat", async (req, res) => {
  try {
    const endpoints = req.body.endpoints || []; // ✅ default to empty array
    const authToken = req.body.authToken;

    // 🔹 Build system prompt
    const systemPrompt = {
      role: "system",
      content: `
You are a helpful assistant that can access external APIs when necessary.

You have the following endpoints available:
${endpoints.length
      ? endpoints.map(e => {
          const pathParams = e.parameters?.path || [];
          return `- ${e.name}: ${e.description} [${e.method} ${e.url}]` +
                 (pathParams.length ? ` (Path parameters: ${pathParams.join(", ")})` : '');
        }).join('\n')
      : "- No endpoints are currently available."}

When you need to call an endpoint that has path parameters, you MUST append the path parameters directly into the URL in order, instead of using query parameters.
Only respond in a conversational tone. Respond ONLY in this JSON format:

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

    console.log("🔹 Starting chat with CometAPI...");

    while (true) {
      try {
        const cometResponse = await fetch("https://api.cometapi.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.COMETAPI_KEY2}`,
            "User-Agent": "cometapi/1.0.0 (https://api.cometapi.com)",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages,
            temperature: 0.7,
          }),
        });

        currentResponse = await cometResponse.json();
        console.log("🧠 CometAPI response:", currentResponse);

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

        console.log('🔧 Parsed tool call:', parsed);

        const endpoint = endpoints.find(e => e.name === parsed.endpoint);

        if (!endpoint) {
          console.warn("⚠️ No endpoints available or unknown endpoint requested:", parsed.endpoint);
          // If no endpoints, just return the assistant message as-is
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
        console.log("📦 API response data:", apiResponseData);

        messages.push(
          { role: "assistant", content: JSON.stringify(parsed) },
          {
            role: "user",
            content: `Here are the results from the API "${parsed.endpoint}": ${JSON.stringify(apiResponseData)}. Please respond to the user accordingly.`
          }
        );

      } catch (e) {
        console.error("❌ Error during CometAPI loop:", e);
        return res.json({ msg: 'Error occurred during CometAPI processing' });
      }
    }

    console.log("✅ Final response to send:", currentResponse);
    return res.json(currentResponse);

  } catch (err) {
    console.error("❌ Error in /api/comet/chat:", err);
    return res.status(500).json({ error: "Failed to fetch from CometAPI" });
  }
});

export default router;
