/* ==========================================================================
 * Clear Air Advisor — application wiring
 *
 * Owns UI state, the location combobox (offline dataset + live geocoder),
 * rendering of conditions, outlook, action plan and chat, and the
 * API setup dialog. No frameworks or build step.
 * ========================================================================== */

(function () {
  "use strict";

  /* ---------- tiny DOM helpers ---------- */

  const $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ---------- state ---------- */

  const state = {
    city: null,            /* { name, state, lat, lon } */
    weather: null,
    air: null,
    forecast: null,
    forecastSummary: null,
    synthetic: false,
    loading: false,
    profile: null,
    planText: "",
    chatHistory: []
  };

  const PROFILE_DEFAULT = {
    members: [],
    commute: "two-wheeler",
    cooking: "lpg",
    home: "apartment",
    budget: "medium",
    goal: "both",
    hours: "medium"
  };

  /* ---------- persistent storage ---------- */

  function loadJSON(key) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  /* ==========================================================================
   * API setup dialog
   * ========================================================================== */

  const settingsDialog = $("settings-dialog");

  function openSettings() {
    if (typeof settingsDialog.showModal === "function") settingsDialog.showModal();
    else settingsDialog.setAttribute("open", "");
  }

  function closeSettings() {
    if (typeof settingsDialog.close === "function") settingsDialog.close();
    else settingsDialog.removeAttribute("open");
  }

  $("btn-settings").addEventListener("click", openSettings);
  $("btn-settings-close").addEventListener("click", closeSettings);

  /* ==========================================================================
   * Location combobox
   * ========================================================================== */

  const cityInput = $("city-input");
  const cityList = $("city-listbox");
  let listOpen = false;
  let activeIndex = -1;
  let currentOptions = [];
  let geocodeTimer = null;
  let geocodeSeq = 0;

  function openList() {
    cityList.hidden = false;
    cityInput.setAttribute("aria-expanded", "true");
    listOpen = true;
  }
  function closeList() {
    cityList.hidden = true;
    cityInput.setAttribute("aria-expanded", "false");
    listOpen = false;
    activeIndex = -1;
  }

  function renderOptions(options, emptyLabel) {
    cityList.innerHTML = "";
    currentOptions = options;
    activeIndex = -1;
    if (!options.length) {
      const li = el("li", "", emptyLabel || "No match — press Enter to search the live geocoder");
      li.style.pointerEvents = "none";
      li.style.color = "#8a94a0";
      cityList.appendChild(li);
      openList();
      return;
    }
    options.forEach(function (opt, i) {
      const li = el("li");
      li.setAttribute("role", "option");
      const nm = el("span", "", opt.name);
      const st = el("span", "cb-state", opt.state || "");
      li.appendChild(nm);
      li.appendChild(st);
      li.addEventListener("mousedown", function (e) { e.preventDefault(); selectOption(opt); });
      cityList.appendChild(li);
    });
    openList();
  }

  function setActive(i) {
    const items = cityList.querySelectorAll("li");
    if (!items.length) return;
    activeIndex = Math.max(0, Math.min(items.length - 1, i));
    items.forEach(function (li, j) { li.classList.toggle("cb-active", j === activeIndex); });
    if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: "nearest" });
  }

  function selectOption(opt) {
    closeList();
    cityInput.value = opt.state ? opt.name + ", " + opt.state : opt.name;
    loadLocation(opt);
  }

  function queryOptions(q) {
    const local = caSearchCities(q, 6);
    const seen = new Set(local.map(function (c) { return (c.name + "|" + (c.state || "")).toLowerCase(); }));
    return { local: local, seen: seen };
  }

  function onCityInput() {
    const q = cityInput.value.trim();
    clearTimeout(geocodeTimer);
    if (!q) {
      renderOptions(caFeaturedCities(), "");
      return;
    }
    const found = queryOptions(q);
    renderOptions(found.local);

    /* live geocoder for anything beyond the offline dataset */
    const seq = ++geocodeSeq;
    geocodeTimer = setTimeout(function () {
      CA_API.geocode(q).then(function (remote) {
        if (seq !== geocodeSeq) return;               /* stale response */
        const merged = remote.filter(function (r) {
          const key = (r.name + "|" + (r.state || "")).toLowerCase();
          if (found.seen.has(key)) return false;
          found.seen.add(key);
          return true;
        });
        const combined = found.local.concat(merged).slice(0, 8);
        if (listOpen || document.activeElement === cityInput) renderOptions(combined);
      }).catch(function () { /* offline dataset remains */ });
    }, 380);
  }

  cityInput.addEventListener("input", onCityInput);
  cityInput.addEventListener("focus", function () {
    if (!cityInput.value.trim()) renderOptions(caFeaturedCities(), "");
  });
  cityInput.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!listOpen) onCityInput(); setActive(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = currentOptions[activeIndex >= 0 ? activeIndex : 0];
      if (pick) selectOption(pick);
      else if (cityInput.value.trim()) selectOption({ name: cityInput.value.trim(), state: "", lat: null, lon: null });
    } else if (e.key === "Escape") { closeList(); }
  });
  document.addEventListener("click", function (e) {
    if (!$("combobox").contains(e.target)) closeList();
  });

  /* ---- geolocate ---- */

  const btnGeo = $("btn-geolocate");
  btnGeo.addEventListener("click", function () {
    if (!navigator.geolocation) { btnGeo.textContent = "Geolocation unsupported"; return; }
    btnGeo.disabled = true;
    const prev = btnGeo.lastChild.textContent;
    btnGeo.lastChild.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(function (pos) {
      CA_API.reverseGeocode(pos.coords.latitude, pos.coords.longitude).then(function (city) {
        cityInput.value = city.state ? city.name + ", " + city.state : city.name;
        loadLocation(city);
      }).catch(function () { loadLocation({ name: "My location", state: "", lat: pos.coords.latitude, lon: pos.coords.longitude }); })
        .finally(function () {
          btnGeo.disabled = false;
          btnGeo.lastChild.textContent = prev;
        });
    }, function () {
      btnGeo.disabled = false;
      btnGeo.lastChild.textContent = prev;
      $("conditions-note").textContent = "Location permission denied — search for your city instead.";
    }, { timeout: 12000 });
  });

  /* ==========================================================================
   * Location loading and rendering
   * ========================================================================== */

  function placeLine() {
    return state.city ? (state.city.name + (state.city.state ? ", " + state.city.state : "") + ", India").toUpperCase() : "WAITING FOR A LOCATION";
  }

  function loadLocation(city) {
    if (state.loading) return;
    state.loading = true;
    state.city = city;
    saveJSON(CA_CONFIG.storage.city, city);

    /* loading placeholders */
    $("aqi-place-line").textContent = placeLine();
    $("aqi-value").textContent = "…";
    $("aqi-value").style.color = "";
    $("aqi-dot").style.background = "var(--hairline-dark)";
    $("aqi-category").textContent = "Loading";
    $("aqi-summary").textContent = "Fetching live air and weather for " + city.name + "…";
    $("health-bulletin").hidden = true;
    $("ai-chip").hidden = true;
    $("conditions-note").textContent = "";

    CA_API.loadLocationOrDemo(city).then(function (bundle) {
      state.weather = bundle.weather;
      state.air = bundle.air;
      state.forecast = bundle.forecast;
      state.synthetic = !!bundle.synthetic;
      state.loading = false;

      if (!state.air || !state.air.list) {
        $("aqi-summary").textContent = "The air-quality feed did not respond. Check the connection and server-side OpenWeatherMap configuration, then search again.";
        $("aqi-value").textContent = "—";
        return;
      }
      renderConditions();
      renderOutlook();
    }).catch(function (e) {
      state.loading = false;
      $("aqi-summary").textContent = "Could not load data: " + (e.message || "unknown error") + ".";
      $("aqi-value").textContent = "—";
    });
  }

  function renderConditions() {
    const air0 = state.air.list[0] || {};
    const comps = CA_AQI.fromOpenWeather(air0.components);
    const est = CA_AQI.overall(comps);
    const cat = est.aqi !== null ? CA_AQI.categoryOf(est.aqi) : null;
    const domLabel = est.dominant ? CA_AQI.POLLUTANTS[est.dominant].label : "n/a";
    const domSpec = est.dominant ? CA_AQI.POLLUTANTS[est.dominant] : null;
    const domVal = est.dominant && comps[est.dominant] !== undefined ? comps[est.dominant] : null;

    $("aqi-place-line").textContent = placeLine();
    $("ai-chip").textContent = state.synthetic ? "Demo data · feed offline" : "Live data · OpenWeatherMap";
    $("ai-chip").hidden = false;
    $("ai-chip").className = "chip " + (state.synthetic ? "chip-warn" : "chip-ok");

    if (est.aqi !== null) {
      $("aqi-value").textContent = String(Math.round(est.aqi));
      $("aqi-value").style.color = cat.color;
      $("aqi-dot").style.background = cat.color;
      $("aqi-category").textContent = cat.name;
      $("aqi-summary").textContent =
        "CPCB-style index of 500. Dominant pollutant " + domLabel +
        (domVal !== null ? " at about " + (domSpec.unit === "mg/m³" ? domVal.toFixed(2) + " mg/m³" : Math.round(domVal) + " µg/m³") : "") +
        " — " + (est.valid ? "computed from " + est.count + " live pollutants." : "computed from the pollutants the feed reports.");
    } else {
      $("aqi-value").textContent = "—";
      $("aqi-category").textContent = "No data";
      $("aqi-summary").textContent = "The live feed returned no pollutant concentrations for this location.";
    }

    const hb = $("health-bulletin");
    if (cat) {
      hb.textContent = "CPCB guidance — " + cat.name + ": " + cat.advice;
      hb.hidden = false;
    } else { hb.hidden = true; }

    /* weather stats */
    const wx = state.weather;
    if (wx && wx.main) {
      $("w-temp").textContent = Math.round(wx.main.temp) + " °C";
      $("w-humidity").textContent = Math.round(wx.main.humidity) + "%";
      $("w-wind").textContent = wx.wind ? (Math.round(wx.wind.speed * 3.6 * 10) / 10) + " km/h" : "—";
      $("w-condition").textContent = wx.weather && wx.weather[0] ? wx.weather[0].main : "—";
      const observed = new Date((wx.dt || Math.floor(Date.now() / 1000)) * 1000);
      const obsIst = CA_AQI.istParts(observed.getTime());
      $("conditions-note").textContent =
        "Feels like " + Math.round(wx.main.feels_like) + " °C · observed " +
        String(obsIst.hour).padStart(2, "0") + ":" + String(obsIst.minute).padStart(2, "0") + " IST · " +
        (state.synthetic ? "synthetic demo bundle — live service unreachable" : "live OpenWeatherMap feed");
    } else {
      $("w-temp").textContent = "—"; $("w-humidity").textContent = "—";
      $("w-wind").textContent = "—"; $("w-condition").textContent = "—";
      $("conditions-note").textContent = "Weather feed unavailable.";
    }

    CA_AQI.renderPollutantGrid($("pollutant-grid"), air0.components);
  }

  function renderOutlook() {
    const section = $("outlook");
    if (!state.forecast || !state.forecast.list || !state.forecast.list.length) {
      $("outlook-window-note").textContent = "Forecast feed unavailable — outlook hidden.";
      $("forecast-chart").innerHTML = "";
      $("forecast-caption").textContent = "";
      return;
    }
    const fc = CA_AQI.summarizeForecast(state.forecast.list);
    state.forecastSummary = fc;

    $("outlook-window-note").textContent =
      "Hourly CPCB-style estimates derived from the OpenWeatherMap 96-hour model · times in IST";
    CA_AQI.renderForecastChart($("forecast-chart"), fc, 48);
    $("forecast-caption").textContent =
      "Line: estimated CPCB index (0–500). Green and red bands mark the cleanest and worst 3-hour windows of the next 24 hours. Hover the dots for hour-by-hour values.";

    if (fc.best) {
      $("outlook-best").textContent = CA_AQI.windowLabel(fc.best.start, fc.best.end);
      $("outlook-best-note").textContent = "Mean PM2.5 in this window ≈ " + Math.round(fc.best.mean) + " µg/m³. Best hours to ventilate rooms, air bedding or exercise outdoors.";
    }
    if (fc.worst) {
      $("outlook-worst").textContent = CA_AQI.windowLabel(fc.worst.start, fc.worst.end);
      $("outlook-worst-note").textContent = "Mean PM2.5 in this window ≈ " + Math.round(fc.worst.mean) + " µg/m³. Keep windows shut and plan indoor alternatives then.";
    }
    $("outlook-trend").textContent = fc.trend.label + " (Δ " + (fc.trend.delta > 0 ? "+" : "") + fc.trend.delta + ")";
    const tomorrow = fc.days[1];
    $("outlook-trend-note").textContent = tomorrow
      ? "Change in the mean estimated index between the next 12 hours and the following day. Tomorrow peaks near AQI " + Math.round(tomorrow.max) + " (" + tomorrow.category.name + ")."
      : "Change in the mean estimated index between the next 12 hours and the following day.";
  }

  /* ==========================================================================
   * Household profile
   * ========================================================================== */

  function syncChipStyles() {
    document.querySelectorAll(".check-chip input").forEach(function (cb) {
      cb.parentElement.classList.toggle("selected", cb.checked);
    });
  }

  document.querySelectorAll(".check-chip input").forEach(function (cb) {
    cb.addEventListener("change", syncChipStyles);
  });

  function readProfile() {
    const members = [];
    document.querySelectorAll('input[name="members"]:checked').forEach(function (cb) { members.push(cb.value); });
    return {
      members: members,
      commute: $("f-commute").value,
      cooking: $("f-cooking").value,
      home: $("f-home").value,
      budget: $("f-budget").value,
      goal: $("f-goal").value,
      hours: $("f-hours").value
    };
  }

  function fillProfile(p) {
    document.querySelectorAll('input[name="members"]').forEach(function (cb) {
      cb.checked = (p.members || []).indexOf(cb.value) !== -1;
    });
    $("f-commute").value = p.commute; $("f-cooking").value = p.cooking;
    $("f-home").value = p.home; $("f-budget").value = p.budget;
    $("f-goal").value = p.goal; $("f-hours").value = p.hours;
    syncChipStyles();
  }

  /* ==========================================================================
   * Action plan
   * ========================================================================== */

  const SECTION_TITLES = [
    ["routine", "I. Low-emission daily routine"],
    ["indoor", "II. Indoor air measures"],
    ["swaps", "III. Sustainable alternatives"]
  ];

  function renderPlan(plan, modeLabel, modeTitle) {
    const chip = $("plan-mode-chip");
    chip.textContent = modeLabel;
    if (modeTitle) chip.title = modeTitle;
    chip.hidden = false;

    const sum = $("plan-summary");
    sum.innerHTML = "";
    const over = el("p", "overline", "Situation");
    const h = el("h3", "", plan.headline);
    const p = el("p", "", plan.summary || "");
    const risk = el("p", "plan-risk", plan.risk_note || "");
    sum.appendChild(over); sum.appendChild(h); sum.appendChild(p); sum.appendChild(risk);

    const wrap = $("plan-sections");
    wrap.innerHTML = "";
    for (const [key, title] of SECTION_TITLES) {
      const items = plan[key] || [];
      const sec = el("div", "plan-section");
      const head = el("div", "plan-section-head");
      const h3 = el("h3", "", title);
      const count = el("span", "plan-section-count", items.length + (items.length === 1 ? " measure" : " measures"));
      head.appendChild(h3); head.appendChild(count);
      sec.appendChild(head);

      items.forEach(function (item, i) {
        const box = el("div", "plan-item");
        const titleRow = el("p", "plan-item-title");
        titleRow.appendChild(document.createTextNode((i + 1) + ". " + item.title));
        if (item.window && item.window !== "all day") {
          titleRow.appendChild(el("span", "plan-section-count", "  ·  " + item.window));
        }
        box.appendChild(titleRow);
        box.appendChild(el("p", "plan-item-detail", item.action));
        const impact = el("p", "plan-item-impact");
        impact.appendChild(el("span", "impact-label", "Impact"));
        impact.appendChild(document.createTextNode(item.impact));
        box.appendChild(impact);
        sec.appendChild(box);
      });
      wrap.appendChild(sec);
    }

    state.planText = CA_ADVISOR.formatPlanAsText(plan, CA_ADVISOR.buildContext(state));
    $("plan-empty").hidden = true;
    $("plan-body").hidden = false;
    $("btn-print").hidden = false;
    $("btn-copy").hidden = false;
  }

  $("profile-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const note = $("plan-note");

    if (!state.air) {
      note.textContent = "Choose a location first — the advisory is built on live air data for your city.";
      return;
    }
    state.profile = readProfile();
    saveJSON(CA_CONFIG.storage.profile, state.profile);

    const btn = $("btn-plan");
    btn.disabled = true;
    const prevLabel = btn.lastChild.textContent;
    btn.lastChild.textContent = "Preparing advisory…";
    note.textContent = "Reading live air data, the 48-hour outlook and your profile. This takes a few seconds.";

    const ctx = CA_ADVISOR.buildContext(state);
    CA_ADVISOR.generatePlanResilient(ctx).then(function (res) {
      btn.disabled = false;
      btn.lastChild.textContent = prevLabel;
      if (res.mode === "ai") {
        renderPlan(res.plan, "AI advisory · " + res.model, "Generated by " + res.model + " from live data");
        note.textContent = "Advisory generated by " + res.model + " from live air data. Answers to follow-up questions use the same context.";
      } else {
        renderPlan(res.plan, "Offline advisory engine", res.reason || "AI engine unavailable");
        note.textContent = "The AI engine was unreachable (" + res.reason + "), so the built-in rules engine produced this plan from the same live data. Print, copy and chat all still work.";
        if (res.kind === "nokey") {
          note.textContent += " Add GEMINI_API_KEY to the server environment to enable the AI path.";
        }
      }
      $("plan").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  $("btn-print").addEventListener("click", function () { window.print(); });

  $("btn-copy").addEventListener("click", function () {
    const done = function (ok) {
      const btn = $("btn-copy");
      const prev = btn.lastChild.textContent;
      btn.lastChild.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () { btn.lastChild.textContent = prev; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.planText).then(function () { done(true); }, function () { done(false); });
    } else {
      const ta = el("textarea");
      ta.value = state.planText;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
  });

  /* ==========================================================================
   * Follow-up chat
   * ========================================================================== */

  function addChatMessage(who, text, mode) {
    const msg = el("div", "chat-msg " + (who === "You" ? "chat-user" : "chat-assistant"));
    const label = el("p", "chat-who", who + (mode ? " · " + mode : ""));
    const body = el("p", "", text);
    msg.appendChild(label);
    msg.appendChild(body);
    const log = $("chat-log");
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
    return msg;
  }

  $("chat-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const input = $("chat-input");
    const question = input.value.trim();
    if (!question) return;

    if (!state.air) {
      $("chat-note").textContent = "Load a location first, then ask against its live numbers.";
      return;
    }

    input.value = "";
    input.disabled = true;
    $("btn-chat").disabled = true;
    $("chat-note").textContent = "Advisor is preparing an answer…";

    addChatMessage("You", question);
    const pending = addChatMessage("Advisor", "…");

    const ctx = CA_ADVISOR.buildContext(state);
    CA_ADVISOR.askQuestionResilient(ctx, question, state.chatHistory).then(function (res) {
      pending.querySelector("p:nth-child(2)").textContent = res.answer;
      pending.querySelector(".chat-who").textContent = "Advisor · " + (res.mode === "ai" ? res.model : "offline engine");
      state.chatHistory.push({ role: "user", content: question });
      state.chatHistory.push({ role: "assistant", content: res.answer });
      if (state.chatHistory.length > 12) state.chatHistory = state.chatHistory.slice(-12);
      $("chat-note").textContent = res.mode === "ai"
        ? "Answers are general guidance, not medical advice."
        : "Answered by the offline engine (" + (res.reason || "AI unavailable") + "). General guidance, not medical advice.";
      input.disabled = false;
      $("btn-chat").disabled = false;
      input.focus();
    });
  });

  /* ==========================================================================
   * Boot
   * ========================================================================== */

  function boot() {
    /* masthead date */
    const now = new Date();
    const ist = CA_AQI.istParts(now.getTime());
    const wd = CA_AQI.WEEKDAYS[ist.weekday];
    const mo = CA_AQI.MONTHS[ist.month];
    $("masthead-date").textContent = wd + ", " + ist.day + " " + mo + " " + ist.year + " · IST";

    /* restore profile and city */
    state.profile = loadJSON(CA_CONFIG.storage.profile) || PROFILE_DEFAULT;
    fillProfile(state.profile);

    let city = loadJSON(CA_CONFIG.storage.city);
    if (!city || !city.lat) {
      city = caFindCity("New Delhi") || CA_CITIES[0];
      cityInput.value = city.name;
    } else {
      cityInput.value = city.state ? city.name + ", " + city.state : city.name;
    }
    loadLocation(city);
  }

  boot();
})();
