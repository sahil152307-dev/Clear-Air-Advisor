/* ==========================================================================
 * Clear Air Advisor — CPCB National AQI engine
 *
 * Converts live pollutant concentrations into the official Indian index
 * (CPCB, "National Air Quality Index — Report of the Expert Group", 2014):
 *
 *   1. Each pollutant gets a sub-index by linear interpolation across the
 *      statutory concentration breakpoints.
 *   2. The overall AQI is the maximum sub-index; the pollutant that produced
 *      it is reported as the dominant pollutant.
 *
 * OpenWeatherMap reports instantaneous model concentrations while CPCB
 * breakpoints are written for 24-hour (or 8-hour) means, so results are an
 * estimate of the statutory index and are labelled as such in the UI.
 *
 * Rendering helpers for the pollutant bars and the 48-hour outlook chart
 * live here too. The module works in the browser and under Node (tests).
 * ========================================================================== */

const CA_AQI = (function () {
  "use strict";

  /* ---- statutory breakpoints: [cLow, cHigh, iLow, iHigh] ---- */

  const POLLUTANTS = {
    pm25: {
      label: "PM2.5", unit: "µg/m³", averaging: "24-hour", who24: 15,
      breakpoints: [[0, 30, 0, 50], [30, 60, 50, 100], [60, 90, 100, 200], [90, 120, 200, 300], [120, 250, 300, 400], [250, 500, 400, 500]]
    },
    pm10: {
      label: "PM10", unit: "µg/m³", averaging: "24-hour", who24: 45,
      breakpoints: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 250, 100, 200], [250, 350, 200, 300], [350, 430, 300, 400], [430, 1000, 400, 500]]
    },
    no2: {
      label: "NO₂", unit: "µg/m³", averaging: "24-hour", who24: 25,
      breakpoints: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 180, 100, 200], [180, 280, 200, 300], [280, 400, 300, 400], [400, 1000, 400, 500]]
    },
    o3: {
      label: "O₃", unit: "µg/m³", averaging: "8-hour", who24: 100,
      breakpoints: [[0, 50, 0, 50], [50, 100, 50, 100], [100, 168, 100, 200], [168, 208, 200, 300], [208, 748, 300, 400], [748, 1200, 400, 500]]
    },
    co: {
      label: "CO", unit: "mg/m³", averaging: "8-hour", who24: 4,
      breakpoints: [[0, 1, 0, 50], [1, 2, 50, 100], [2, 10, 100, 200], [10, 17, 200, 300], [17, 34, 300, 400], [34, 50, 400, 500]]
    },
    so2: {
      label: "SO₂", unit: "µg/m³", averaging: "24-hour", who24: 40,
      breakpoints: [[0, 40, 0, 50], [40, 80, 50, 100], [80, 380, 100, 200], [380, 800, 200, 300], [800, 1600, 300, 400], [1600, 2400, 400, 500]]
    },
    nh3: {
      label: "NH₃", unit: "µg/m³", averaging: "24-hour", who24: null,
      breakpoints: [[0, 100, 0, 50], [100, 200, 50, 100], [200, 400, 100, 200], [400, 800, 200, 300], [800, 1200, 300, 400], [1200, 1800, 400, 500]]
    }
  };

  /* ---- health categories (CPCB wording, condensed) ---- */

  const CATEGORIES = [
    { max: 50,  name: "Good",      color: "#4a7c59", advice: "Air quality poses little or no risk. A good day to be outdoors." },
    { max: 100, name: "Satisfactory", color: "#7c8a3a", advice: "Minor breathing discomfort possible for highly sensitive individuals." },
    { max: 200, name: "Moderate",  color: "#c9a227", advice: "Breathing discomfort for people with lung or heart disease, children, older adults and pregnant women." },
    { max: 300, name: "Poor",      color: "#c4761e", advice: "Breathing discomfort for most people on prolonged exposure. Limit outdoor exertion." },
    { max: 400, name: "Very Poor", color: "#a8422f", advice: "Respiratory illness on prolonged exposure. Sensitive groups should stay indoors." },
    { max: 500, name: "Severe",    color: "#7d2a21", advice: "Affects healthy people; serious impact on those with existing disease. Avoid outdoor activity." }
  ];

  /* ---- index maths ---- */

  function subIndex(pollutant, conc) {
    const spec = POLLUTANTS[pollutant];
    if (!spec || conc === null || conc === undefined || !isFinite(conc)) return null;
    const c = Math.max(0, conc);
    for (const bp of spec.breakpoints) {
      const cLo = bp[0], cHi = bp[1], iLo = bp[2], iHi = bp[3];
      if (c <= cHi) {
        if (cHi === cLo) return iHi;
        return iLo + ((iHi - iLo) * (c - cLo)) / (cHi - cLo);
      }
    }
    return 500;
  }

  function categoryOf(aqi) {
    if (aqi === null || aqi === undefined || !isFinite(aqi)) return null;
    for (const cat of CATEGORIES) {
      if (aqi <= cat.max) return cat;
    }
    return CATEGORIES[CATEGORIES.length - 1];
  }

  /* components: { pm25, pm10, no2, o3, co, so2, nh3 } in the units of POLLUTANTS */
  function overall(components) {
    const subs = {};
    let aqi = null, dominant = null, count = 0;
    for (const key of Object.keys(POLLUTANTS)) {
      const si = subIndex(key, components ? components[key] : null);
      subs[key] = si;
      if (si !== null) {
        count += 1;
        if (aqi === null || si > aqi) { aqi = si; dominant = key; }
      }
    }
    const hasParticulate = subs.pm25 !== null || subs.pm10 !== null;
    return { aqi: aqi, dominant: dominant, subs: subs, count: count, valid: count >= 3 && hasParticulate };
  }

  /* Map an OpenWeatherMap `components` object (µg/m³, co in µg/m³) to engine units. */
  function fromOpenWeather(comp) {
    if (!comp) return null;
    return {
      pm25: comp.pm2_5, pm10: comp.pm10, no2: comp.no2,
      o3: comp.o3, so2: comp.so2, nh3: comp.nh3,
      co: comp.co !== undefined ? comp.co / 1000 : undefined /* µg/m³ -> mg/m³ */
    };
  }

  /* ---- forecast summarisation ----
   * list: OpenWeatherMap air_pollution/forecast points {dt, components}
   * Returns hourly CPCB estimates plus windows, daily maxima and trend.
   * All display times are IST (UTC+05:30, no DST). */

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  function istParts(ts) {
    const d = new Date(ts + IST_OFFSET_MS);
    return {
      day: d.getUTCDate(), month: d.getUTCMonth(), year: d.getUTCFullYear(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(),
      weekday: d.getUTCDay(),
      label: String(d.getUTCHours()).padStart(2, "0") + ":00",
      dateKey: d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate()
    };
  }

  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function summarizeForecast(list) {
    const pts = [];
    for (const p of (list || [])) {
      const est = overall(fromOpenWeather(p.components));
      if (est.aqi === null) continue;
      pts.push({ ts: p.dt * 1000, aqi: est.aqi, pm25: p.components.pm2_5, dominant: est.dominant });
    }
    pts.sort(function (a, b) { return a.ts - b.ts; });
    if (!pts.length) return null;

    const now = pts[0].ts;

    /* best (cleanest) and worst 3-hour windows within the next 24 hours;
       a window is four consecutive hourly samples spanning three hours */
    let best = null, worst = null;
    for (let i = 0; i + 4 <= pts.length; i += 1) {
      const w = pts.slice(i, i + 4);
      if (w[3].ts - w[0].ts !== 3 * 3600 * 1000) continue;
      if (w[0].ts - now > 24 * 3600 * 1000) break;
      const mean = w.reduce(function (s, p) { return s + p.pm25; }, 0) / w.length;
      if (!best || mean < best.mean) best = { start: w[0], end: w[3], mean: mean };
      if (!worst || mean > worst.mean) worst = { start: w[0], end: w[3], mean: mean };
    }

    /* daily maxima for the outlook table */
    const byDay = new Map();
    for (const p of pts) {
      const k = istParts(p.ts).dateKey;
      if (!byDay.has(k)) byDay.set(k, { day: null, max: null, sum: 0, n: 0 });
      const d = byDay.get(k);
      if (p.aqi > d.max) { d.max = p.aqi; d.at = p.ts; }
      d.sum += p.aqi; d.n += 1;
    }
    const days = [];
    for (const d of byDay.values()) {
      days.push({
        max: d.max,
        mean: d.sum / d.n,
        at: d.at,
        category: categoryOf(d.max),
        date: istParts(d.at)
      });
    }

    /* trend: next 12 hours vs the following 24 hours */
    let trend = { label: "Stable", delta: 0 };
    if (pts.length >= 24) {
      const first = pts.slice(0, 12).reduce(function (s, p) { return s + p.aqi; }, 0) / 12;
      const next = pts.slice(24, 48).reduce(function (s, p) { return s + p.aqi; }, 0) / Math.max(1, Math.min(24, pts.length - 24));
      const delta = next - first;
      const label = delta <= -15 ? "Improving" : delta >= 15 ? "Worsening" : "Stable";
      trend = { label: label, delta: Math.round(delta) };
    }

    return {
      points: pts, best: best, worst: worst, days: days, trend: trend,
      currentAqi: pts[0].aqi, dominantNow: pts[0].dominant
    };
  }

  /* ---- window label helper: "14:00–17:00, Wed 20 Nov" ---- */

  function windowLabel(startPt, endPt) {
    const s = istParts(startPt.ts), e = istParts(endPt.ts);
    const day = s.day === e.day ? "" : ", " + WEEKDAYS[s.weekday].slice(0, 3) + " " + s.day + " " + MONTHS[s.month];
    return s.label + "–" + e.label + " IST" + day;
  }

  /* ---- pollutant bar rendering ---- */

  function renderPollutantGrid(gridEl, components) {
    gridEl.innerHTML = "";
    const eng = fromOpenWeather(components);
    const est = overall(eng);
    const order = ["pm25", "pm10", "no2", "o3", "co", "so2", "nh3"];

    for (const key of order) {
      const spec = POLLUTANTS[key];
      const si = est.subs[key];
      const conc = eng ? eng[key] : null;
      const cat = si !== null ? categoryOf(si) : null;

      const box = document.createElement("div");
      box.className = "pollutant";

      const row = document.createElement("div");
      row.className = "pollutant-row";

      const name = document.createElement("span");
      name.className = "pollutant-name";
      name.textContent = spec.label;
      row.appendChild(name);

      const value = document.createElement("span");
      value.className = "pollutant-value";
      if (conc !== null && conc !== undefined) {
        const decimals = spec.unit === "mg/m³" ? 2 : 1;
        let txt = conc.toFixed(decimals) + " " + spec.unit;
        if (spec.who24) {
          const ratio = conc / spec.who24;
          const ratioTxt = ratio >= 10 ? Math.round(ratio) + "×" : ratio.toFixed(1) + "×";
          txt += ' <span class="pollutant-ref">' + ratioTxt + " WHO 24-h</span>";
        } else {
          txt += ' <span class="pollutant-ref">no WHO guideline</span>';
        }
        value.innerHTML = txt;
      } else {
        value.textContent = "not reported";
      }
      row.appendChild(value);
      box.appendChild(row);

      const track = document.createElement("div");
      track.className = "pollutant-track";
      const fill = document.createElement("div");
      fill.className = "pollutant-fill";
      if (si !== null) {
        const pct = Math.max(2, Math.min(100, (si / 500) * 100));
        fill.style.width = pct.toFixed(1) + "%";
        if (si > 300) fill.classList.add("pf-over3");
        else if (si > 200) fill.classList.add("pf-over2");
        else if (si > 100) fill.classList.add("pf-over1");
        fill.title = spec.label + " sub-index " + Math.round(si);
      } else {
        fill.style.width = "4%";
      }
      track.appendChild(fill);
      box.appendChild(track);

      const flag = document.createElement("p");
      flag.className = "pollutant-flag";
      flag.textContent = si !== null
        ? "Sub-index " + Math.round(si) + " · " + cat.name + " · " + spec.averaging + " basis"
        : "No concentration in the live feed";
      box.appendChild(flag);

      gridEl.appendChild(box);
    }
  }

  /* ---- 48-hour outlook chart (hand-built SVG, no dependencies) ---- */

  function renderForecastChart(container, summary, hours) {
    container.innerHTML = "";
    if (!summary || !summary.points.length) return;

    const H = hours || 48;
    const pts = summary.points.slice(0, H + 1);
    const W = 760, HGT = 250;
    const M = { top: 18, right: 14, bottom: 30, left: 44 };
    const iw = W - M.left - M.right, ih = HGT - M.top - M.bottom;
    const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    const yMax = 500;

    const x = function (ts) { return M.left + ((ts - t0) / (t1 - t0)) * iw; };
    const y = function (a) { return M.top + ih - (Math.min(a, yMax) / yMax) * ih; };

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + HGT);
    svg.setAttribute("role", "img");

    /* category bands, very light */
    let bandStart = 0;
    for (const cat of CATEGORIES) {
      const yTop = y(cat.max), yBot = y(bandStart);
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x", M.left); rect.setAttribute("y", yTop);
      rect.setAttribute("width", iw); rect.setAttribute("height", Math.max(0, yBot - yTop));
      rect.setAttribute("fill", cat.color);
      rect.setAttribute("fill-opacity", "0.07");
      svg.appendChild(rect);
      const lab = document.createElementNS(svgNS, "text");
      lab.setAttribute("x", M.left + 6); lab.setAttribute("y", yTop + 12);
      lab.setAttribute("font-size", "10"); lab.setAttribute("fill", "#8a94a0");
      lab.textContent = cat.name + " ≤" + cat.max;
      svg.appendChild(lab);
      bandStart = cat.max + 1;
    }

    /* gridlines + y labels */
    for (const g of [0, 100, 200, 300, 400, 500]) {
      const gl = document.createElementNS(svgNS, "line");
      gl.setAttribute("x1", M.left); gl.setAttribute("x2", M.left + iw);
      gl.setAttribute("y1", y(g)); gl.setAttribute("y2", y(g));
      gl.setAttribute("stroke", g === 0 ? "#b9b2a4" : "#e4dfd3");
      gl.setAttribute("stroke-width", "1");
      svg.appendChild(gl);
      const yt = document.createElementNS(svgNS, "text");
      yt.setAttribute("x", M.left - 8); yt.setAttribute("y", y(g) + 3);
      yt.setAttribute("text-anchor", "end"); yt.setAttribute("font-size", "10");
      yt.setAttribute("fill", "#8a94a0");
      yt.textContent = String(g);
      svg.appendChild(yt);
    }

    /* best / worst window shading over the next 24h */
    function shade(win, color, label) {
      if (!win) return;
      const a = Math.max(x(win.start.ts), M.left);
      const b = Math.min(x(win.end.ts), M.left + iw);
      if (b <= a) return;
      const r = document.createElementNS(svgNS, "rect");
      r.setAttribute("x", a); r.setAttribute("y", M.top);
      r.setAttribute("width", b - a); r.setAttribute("height", ih);
      r.setAttribute("fill", color); r.setAttribute("fill-opacity", "0.14");
      svg.appendChild(r);
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", (a + b) / 2); t.setAttribute("y", M.top + 12);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", "10");
      t.setAttribute("fill", "#3d4c5c"); t.setAttribute("font-weight", "600");
      t.textContent = label;
      svg.appendChild(t);
    }
    shade(summary.best, "#4a7c59", "cleanest");
    shade(summary.worst, "#a8422f", "worst");

    /* x axis hour labels every 6 hours */
    for (const p of pts) {
      const part = istParts(p.ts);
      if (part.hour % 6 !== 0) continue;
      const xt = document.createElementNS(svgNS, "text");
      xt.setAttribute("x", x(p.ts)); xt.setAttribute("y", HGT - M.bottom + 14);
      xt.setAttribute("text-anchor", "middle"); xt.setAttribute("font-size", "10");
      xt.setAttribute("fill", "#8a94a0");
      xt.textContent = part.label;
      svg.appendChild(xt);
      if (part.hour === 0 || part.hour === 12) {
        const dt = document.createElementNS(svgNS, "text");
        dt.setAttribute("x", x(p.ts)); dt.setAttribute("y", HGT - M.bottom + 26);
        dt.setAttribute("text-anchor", "middle"); dt.setAttribute("font-size", "10");
        dt.setAttribute("fill", "#5f6e7d");
        dt.textContent = WEEKDAYS[part.weekday].slice(0, 3) + " " + part.day + " " + MONTHS[part.month];
        svg.appendChild(dt);
      }
    }

    /* the AQI line + dots */
    const line = document.createElementNS(svgNS, "path");
    let dstr = "";
    pts.forEach(function (p, i) {
      dstr += (i === 0 ? "M" : "L") + x(p.ts).toFixed(1) + " " + y(p.aqi).toFixed(1) + " ";
    });
    line.setAttribute("d", dstr);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#1c2733");
    line.setAttribute("stroke-width", "1.8");
    line.setAttribute("stroke-linejoin", "round");
    svg.appendChild(line);

    pts.forEach(function (p, i) {
      if (p.ts - t0 !== 0 && (p.ts - t0) % (6 * 3600 * 1000) !== 0 && i !== pts.length - 1) return;
      const c = document.createElementNS(svgNS, "circle");
      c.setAttribute("cx", x(p.ts)); c.setAttribute("cy", y(p.aqi));
      c.setAttribute("r", "2.6");
      c.setAttribute("fill", categoryOf(p.aqi).color);
      const part = istParts(p.ts);
      const title = document.createElementNS(svgNS, "title");
      title.textContent = "AQI ≈" + Math.round(p.aqi) + " (" + categoryOf(p.aqi).name + ") · " +
        WEEKDAYS[part.weekday].slice(0, 3) + " " + part.day + " " + MONTHS[part.month] + ", " + part.label + " IST";
      c.appendChild(title);
      svg.appendChild(c);
    });

    container.appendChild(svg);
  }

  /* ---- public interface ---- */

  return {
    POLLUTANTS: POLLUTANTS,
    CATEGORIES: CATEGORIES,
    subIndex: subIndex,
    categoryOf: categoryOf,
    overall: overall,
    fromOpenWeather: fromOpenWeather,
    summarizeForecast: summarizeForecast,
    istParts: istParts,
    windowLabel: windowLabel,
    renderPollutantGrid: renderPollutantGrid,
    renderForecastChart: renderForecastChart,
    WEEKDAYS: WEEKDAYS,
    MONTHS: MONTHS
  };
})();

/* Node export for the test harness. */
if (typeof module !== "undefined" && module.exports) { module.exports = CA_AQI; }
