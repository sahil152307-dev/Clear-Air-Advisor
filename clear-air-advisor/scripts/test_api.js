"use strict";

const assert = require("assert");
const weatherHandler = require("../api/weather.js");
const geminiHandler = require("../api/gemini.js");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader: function (name, value) { this.headers[name] = value; },
    status: function (code) { this.statusCode = code; return this; },
    json: function (body) { this.body = body; return this; },
    send: function (body) { this.body = body; return this; }
  };
}

async function main() {
  const previousFetch = global.fetch;
  const previousWeatherKey = process.env.OPENWEATHER_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;

  try {
    process.env.OPENWEATHER_API_KEY = "test-weather-key";
    global.fetch = async function (url) {
      assert(url.includes("appid=test-weather-key"));
      return { status: 200, text: async function () { return JSON.stringify({ name: "Test" }); } };
    };
    const weatherRes = response();
    await weatherHandler({ method: "GET", url: "/api/weather?action=weather&lat=28.6&lon=77.2" }, weatherRes);
    assert.strictEqual(weatherRes.statusCode, 200);
    assert.strictEqual(JSON.parse(weatherRes.body).name, "Test");
    assert(!weatherRes.body.includes("test-weather-key"));

    const invalidWeatherRes = response();
    await weatherHandler({ method: "GET", url: "/api/weather?action=unknown" }, invalidWeatherRes);
    assert.strictEqual(invalidWeatherRes.statusCode, 400);

    delete process.env.OPENWEATHER_API_KEY;
    const missingWeatherRes = response();
    await weatherHandler({ method: "GET", url: "/api/weather?action=weather&lat=28.6&lon=77.2" }, missingWeatherRes);
    assert.strictEqual(missingWeatherRes.statusCode, 503);

    process.env.GEMINI_API_KEY = "test-gemini-key";
    global.fetch = async function (url, options) {
      assert.strictEqual(
        url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
      );
      assert.strictEqual(options.headers["x-goog-api-key"], "test-gemini-key");
      const payload = JSON.parse(options.body);
      assert.strictEqual(payload.contents[0].role, "user");
      assert.strictEqual(payload.contents[1].role, "model");
      assert.strictEqual(payload.systemInstruction.parts[0].text, "You are helpful.");
      assert.strictEqual(payload.generationConfig.maxOutputTokens, 700);
      assert.strictEqual(payload.generationConfig.responseMimeType, "application/json");
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify({
            modelVersion: "gemini-3.5-flash-lite",
            candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }]
          });
        }
      };
    };
    const geminiRes = response();
    await geminiHandler({
      method: "POST",
      body: {
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" }
        ],
        maxTokens: 700,
        jsonMode: true
      }
    }, geminiRes);
    assert.strictEqual(geminiRes.statusCode, 200);
    assert.strictEqual(geminiRes.body.choices[0].message.content, "{\"ok\":true}");
    assert(!JSON.stringify(geminiRes.body).includes("test-gemini-key"));

    delete process.env.GEMINI_API_KEY;
    const missingGeminiRes = response();
    await geminiHandler({
      method: "POST",
      body: { messages: [{ role: "user", content: "Hello" }] }
    }, missingGeminiRes);
    assert.strictEqual(missingGeminiRes.statusCode, 503);

    process.env.GEMINI_API_KEY = "test-gemini-key";
    const invalidGeminiRes = response();
    await geminiHandler({
      method: "POST",
      body: { messages: [{ role: "system", content: "x" }], maxTokens: 99999 }
    }, invalidGeminiRes);
    assert.strictEqual(invalidGeminiRes.statusCode, 400);

    console.log("API proxy tests passed");
  } finally {
    global.fetch = previousFetch;
    if (previousWeatherKey === undefined) delete process.env.OPENWEATHER_API_KEY;
    else process.env.OPENWEATHER_API_KEY = previousWeatherKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
  }
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
