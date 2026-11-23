/* ==========================================================================
 * Clear Air Advisor — API layer
 *
 * OpenWeatherMap and Gemini requests go through same-origin Vercel functions,
 * keeping provider credentials out of browser code.
 *
 * Every call is classified: a typed error object comes back so the UI can
 * react precisely (bad key, region restriction, rate limit, offline). If the
 * weather feed is unreachable, a clearly-labelled synthetic bundle keeps the
 * demonstration alive.
 * ========================================================================== */

const CA_API = (function () {
  "use strict";

  /* ---- low-level fetch with timeout and error wrapping ---- */

  function fetchJSON(url, options, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 20000);
    const opts = Object.assign({ signal: ctl.signal }, options || {});
    return fetch(url, opts).then(function (res) {
      clearTimeout(timer);
      const ok = res.ok;
      return res.text().then(function (text) {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
        if (!ok) {
          const err = new Error("HTTP " + res.status);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") {
        const err = new Error("Request timed out");
        err.kind = "timeout";
        throw err;
      }
      if (e.kind === "timeout") throw e;
      if (e.status) throw e;
      const err = new Error(e.message || "Network unreachable");
      err.kind = "network";
      throw err;
    });
  }

  function weatherURL(action, params) {
    const q = new URLSearchParams(params || {});
    q.set("action", action);
    return "/api/weather?" + q.toString();
  }

  /* ---- OpenWeatherMap endpoints ---- */

  function geocode(query) {
    return fetchJSON(weatherURL("geocode", { q: query + ",IN", limit: 8 }), null, 15000)
      .then(function (list) {
        return (list || []).filter(function (r) { return r.country === "IN"; }).map(function (r) {
          return { name: r.name, state: r.state || "", lat: r.lat, lon: r.lon, source: "geocoder" };
        });
      });
  }

  function reverseGeocode(lat, lon) {
    return fetchJSON(weatherURL("reverse", { lat: lat, lon: lon, limit: 1 }), null, 15000)
      .then(function (list) {
        const r = (list || [])[0] || {};
        return { name: r.name || "Selected location", state: r.state || "", lat: lat, lon: lon };
      });
  }

  function weather(lat, lon) {
    return fetchJSON(weatherURL("weather", { lat: lat, lon: lon, units: CA_CONFIG.owm.units, lang: CA_CONFIG.owm.lang }));
  }

  function airPollution(lat, lon) {
    return fetchJSON(weatherURL("air", { lat: lat, lon: lon }));
  }

  function airForecast(lat, lon) {
    return fetchJSON(weatherURL("forecast", { lat: lat, lon: lon }));
  }

  /* All three location feeds at once; individual failures are tolerated. */
  function loadLocationFeeds(lat, lon) {
    return Promise.allSettled([
      weather(lat, lon), airPollution(lat, lon), airForecast(lat, lon)
    ]).then(function (rs) {
      const out = { weather: null, air: null, forecast: null, errors: [] };
      const names = ["weather", "air", "forecast"];
      rs.forEach(function (r, i) {
        if (r.status === "fulfilled") out[names[i]] = r.value;
        else out.errors.push({ feed: names[i], message: r.reason.message, status: r.reason.status });
      });
      return out;
    });
  }

  /* ---- synthetic fallback bundle (live service unreachable) ----
   * Deterministic per city name so a reload does not jump values.
   * Shape matches the real feeds so downstream code is identical. */

  function syntheticBundle(cityName) {
    let h = 0;
    const s = String(cityName || "India");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const rnd = function (n) { h = (h * 1103515245 + 12345) >>> 0; return (h >>> 8) % n; };

    const basePm25 = 60 + rnd(180);                    /* 60–239 µg/m³ */
    const nowSec = Math.floor(Date.now() / 1000);
    const components = {
      pm2_5: basePm25,
      pm10: Math.round(basePm25 * (1.3 + rnd(60) / 100)),
      no2: 20 + rnd(50), o3: 15 + rnd(40), so2: 5 + rnd(25),
      nh3: 8 + rnd(30), co: 300 + rnd(900)
    };
    const forecastList = [];
    for (let i = 0; i < 96; i++) {
      const diurnal = 1 + 0.45 * Math.sin(((i + 9) % 24) / 24 * 2 * Math.PI); /* peaks at night */
      const drift = 1 + 0.15 * Math.sin(i / 30);
      const c = Object.assign({}, components);
      c.pm2_5 = Math.round(basePm25 * diurnal * drift);
      c.pm10 = Math.round(c.pm2_5 * 1.35);
      forecastList.push({ dt: nowSec + i * 3600, main: { aqi: 4 }, components: c });
    }

    return {
      weather: {
        name: cityName,
        main: { temp: 14 + rnd(10), feels_like: 13 + rnd(10), humidity: 55 + rnd(35) },
        wind: { speed: 0.8 + rnd(30) / 10 },
        weather: [{ main: "Haze", description: "haze (synthetic)" }]
      },
      air: { list: [{ main: { aqi: 4 }, components: components, dt: nowSec }] },
      forecast: { list: forecastList },
      errors: [],
      synthetic: true
    };
  }

  /* Load feeds, falling back to the synthetic bundle only when ALL feeds fail. */
  function loadLocationOrDemo(city) {
    return loadLocationFeeds(city.lat, city.lon).then(function (out) {
      const allFailed = !out.weather && !out.air && !out.forecast;
      if (allFailed && CA_CONFIG.allowDemoData) {
        const demo = syntheticBundle(city.name);
        demo.synthetic = true;
        demo.degraded = true;
        demo.fallbackErrors = out.errors;
        return demo;
      }
      out.synthetic = false;
      return out;
    });
  }

  /* ---- Gemini content generation ---- */

  function geminiChat(messages, opts) {
    const o = opts || {};
    const cfg = CA_CONFIG.gemini;
    const payload = {
      messages: messages,
      temperature: o.temperature !== undefined ? o.temperature : cfg.temperature,
      maxTokens: o.maxTokens || cfg.planMaxTokens,
      jsonMode: !!o.jsonMode
    };

    return fetchJSON("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, cfg.timeoutMs).then(function (body) {
      const choice = body && body.choices && body.choices[0];
      const text = choice && choice.message && choice.message.content;
      if (!text) {
        const err = new Error("Empty completion");
        err.kind = "http";
        throw err;
      }
      return { text: text, model: body.model || cfg.model };
    }).catch(function (e) {
      if (!e.kind) {
        if (e.status === 401 || e.status === 403) {
          e.message = "Gemini rejected the key or request";
          e.kind = "auth";
        } else if (e.status === 429) {
          e.message = "Gemini quota or rate limit reached";
          e.kind = "rate";
        } else {
          e.message = e.message || "Gemini request failed";
          e.kind = "http";
        }
      }
      throw e;
    });
  }

  return {
    geocode: geocode,
    reverseGeocode: reverseGeocode,
    weather: weather,
    airPollution: airPollution,
    airForecast: airForecast,
    loadLocationFeeds: loadLocationFeeds,
    loadLocationOrDemo: loadLocationOrDemo,
    syntheticBundle: syntheticBundle,
    geminiChat: geminiChat
  };
})();
