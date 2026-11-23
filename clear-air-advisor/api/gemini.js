"use strict";

const MODEL = "gemini-3.5-flash-lite";
const MAX_MESSAGES = 32;
const MAX_TOTAL_CONTENT = 30000;
const MAX_TOKENS = 2200;

function sendError(res, status, message) {
  res.status(status).json({ error: { message: message } });
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.length <= 60000) return JSON.parse(req.body);
  return null;
}

module.exports = async function geminiHandler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Method not allowed");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return sendError(res, 503, "Gemini is not configured on the server");

  let input;
  try {
    input = readBody(req);
  } catch (error) {
    return sendError(res, 400, "Request body must be valid JSON");
  }

  if (!input || !Array.isArray(input.messages) || input.messages.length < 1 ||
      input.messages.length > MAX_MESSAGES) {
    return sendError(res, 400, "A valid messages array is required");
  }

  let totalContent = 0;
  const systemText = [];
  const contents = [];
  for (const message of input.messages) {
    if (!message || !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string") {
      return sendError(res, 400, "Messages must contain a supported role and text content");
    }
    totalContent += message.content.length;
    if (totalContent > MAX_TOTAL_CONTENT) {
      return sendError(res, 413, "Request messages are too large");
    }
    if (message.role === "system") {
      systemText.push(message.content);
    } else {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
      });
    }
  }

  if (contents.length === 0 || contents[0].role !== "user") {
    return sendError(res, 400, "Conversation must begin with a user message");
  }

  const temperature = input.temperature === undefined ? 0.6 : Number(input.temperature);
  const maxTokens = input.maxTokens === undefined ? 2200 : Number(input.maxTokens);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS) {
    return sendError(res, 400, "Invalid generation options");
  }

  const payload = {
    contents: contents,
    generationConfig: {
      temperature: temperature,
      maxOutputTokens: maxTokens
    }
  };
  if (systemText.length) {
    payload.systemInstruction = { parts: [{ text: systemText.join("\n\n") }] };
  }
  if (input.jsonMode === true) {
    payload.generationConfig.responseMimeType = "application/json";
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 55000);
  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    );
    const text = await upstream.text();
    if (!upstream.ok) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.status(upstream.status).send(text);
    }

    let result;
    try {
      result = JSON.parse(text);
    } catch (error) {
      return sendError(res, 502, "Gemini returned an invalid response");
    }
    const parts = result.candidates && result.candidates[0] &&
      result.candidates[0].content && result.candidates[0].content.parts;
    const responseText = Array.isArray(parts)
      ? parts.map(function (part) { return typeof part.text === "string" ? part.text : ""; }).join("")
      : "";
    if (!responseText) return sendError(res, 502, "Gemini returned no text");

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      model: result.modelVersion || MODEL,
      choices: [{ message: { content: responseText } }]
    });
  } catch (error) {
    console.error("Gemini request failed:", error.message);
    sendError(res, error.name === "AbortError" ? 504 : 502,
      error.name === "AbortError" ? "Gemini request timed out" : "Gemini request failed");
  } finally {
    clearTimeout(timeout);
  }
};
