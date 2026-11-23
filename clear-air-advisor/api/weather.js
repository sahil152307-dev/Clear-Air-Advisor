"use strict";

const WEATHER_ENDPOINTS = {
  geocode: { base: "https://api.openweathermap.org/geo/1.0", path: "/direct", geocoding: true },
  reverse: { base: "https://api.openweathermap.org/geo/1.0", path: "/reverse", geocoding: true },
  weather: { base: "https://api.openweathermap.org/data/2.5", path: "/weather" },
  air: { base: "https://api.openweathermap.org/data/2.5", path: "/air_pollution" },
  forecast: { base: "https://api.openweathermap.org/data/2.5", path: "/air_pollution/forecast" }
};

function sendError(res, status, message) {
  res.status(status).json({ error: { message: message } });
}

function finiteCoordinate(value, min, max) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

module.exports = async function weatherHandler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendError(res, 405, "Method not allowed");
  }

  const url = new URL(req.url, "http://localhost");
  const action = url.searchParams.get("action");
  const endpoint = WEATHER_ENDPOINTS[action];
  if (!endpoint) return sendError(res, 400, "Unsupported weather action");

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return sendError(res, 503, "OpenWeatherMap is not configured on the server");

  const params = new URLSearchParams();
  if (endpoint.geocoding) {
    if (action === "geocode") {
      const query = (url.searchParams.get("q") || "").trim();
      if (!query || query.length > 120) return sendError(res, 400, "A valid location query is required");
      params.set("q", query);
      params.set("limit", "8");
    } else {
      const lat = finiteCoordinate(url.searchParams.get("lat"), -90, 90);
      const lon = finiteCoordinate(url.searchParams.get("lon"), -180, 180);
      if (lat === null || lon === null) return sendError(res, 400, "Valid latitude and longitude are required");
      params.set("lat", String(lat));
      params.set("lon", String(lon));
      params.set("limit", "1");
    }
  } else {
    const lat = finiteCoordinate(url.searchParams.get("lat"), -90, 90);
    const lon = finiteCoordinate(url.searchParams.get("lon"), -180, 180);
    if (lat === null || lon === null) return sendError(res, 400, "Valid latitude and longitude are required");
    params.set("lat", String(lat));
    params.set("lon", String(lon));
    if (action === "weather") {
      params.set("units", "metric");
      params.set("lang", "en");
    }
  }
  params.set("appid", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, 18000);
  try {
    const upstream = await fetch(endpoint.base + endpoint.path + "?" + params.toString(), {
      signal: controller.signal
    });
    const text = await upstream.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status).send(text);
  } catch (error) {
    console.error("OpenWeatherMap request failed:", error.message);
    sendError(res, error.name === "AbortError" ? 504 : 502,
      error.name === "AbortError" ? "OpenWeatherMap request timed out" : "OpenWeatherMap request failed");
  } finally {
    clearTimeout(timeout);
  }
};
