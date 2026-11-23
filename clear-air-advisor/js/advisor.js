/* ==========================================================================
 * Clear Air Advisor — advisory engine
 *
 * Generates the household action plan and answers follow-up questions.
 *
 * Primary path   — Gemini content generation. The plan is requested as strict
 *                  JSON and validated field by field before rendering.
 * Fallback path  — a deterministic rules engine that reads the live AQI
 *                  category, pollutant mix, weather and household profile
 *                  and produces the same plan shape with quantified impact
 *                  estimates. It keeps the demonstration alive if Gemini is
 *                  unreachable, misconfigured or rate-limited.
 *
 * All quantified impacts are engineering estimates from published emission
 * factors and are explicitly labelled as such in the UI.
 * ========================================================================== */

const CA_ADVISOR = (function () {
  "use strict";

  /* ---------- context assembly ---------- */

  function buildContext(state) {
    const air = state.air, wx = state.weather, fc = state.forecastSummary;
    const comps = CA_AQI.fromOpenWeather(air && air.list && air.list[0] ? air.list[0].components : null);
    const est = CA_AQI.overall(comps);
    const cat = est.aqi !== null ? CA_AQI.categoryOf(est.aqi) : null;
    const dom = est.dominant ? CA_AQI.POLLUTANTS[est.dominant].label : null;

    const ctx = {
      place: state.city ? state.city.name + (state.city.state ? ", " + state.city.state : "") + ", India" : "India",
      aqi: est.aqi !== null ? Math.round(est.aqi) : null,
      category: cat ? cat.name : null,
      healthAdvice: cat ? cat.advice : null,
      dominant: dom,
      pm25: comps && comps.pm25 !== undefined ? Math.round(comps.pm25 * 10) / 10 : null,
      weather: null,
      bestWindow: fc && fc.best ? CA_AQI.windowLabel(fc.best.start, fc.best.end) : null,
      worstWindow: fc && fc.worst ? CA_AQI.windowLabel(fc.worst.start, fc.worst.end) : null,
      trend: fc ? fc.trend.label : null,
      tomorrowMax: fc && fc.days[1] ? { aqi: Math.round(fc.days[1].max), category: fc.days[1].category.name } : null,
      profile: state.profile,
      dataSource: state.synthetic ? "synthetic demo data" : "OpenWeatherMap live feed"
    };

    if (wx && wx.main) {
      ctx.weather = {
        temperatureC: Math.round(wx.main.temp),
        feelsLikeC: Math.round(wx.main.feels_like),
        humidityPct: wx.main.humidity,
        windMs: wx.wind ? Math.round(wx.wind.speed * 10) / 10 : null,
        sky: wx.weather && wx.weather[0] ? wx.weather[0].main : null
      };
    }
    return ctx;
  }

  /* ---------- shared persona ---------- */

  const PERSONA =
    "You are the advisory engine of Clear Air Advisor, an air-quality guidance service for households in India during " +
    "the winter smog season. You write like a careful public-health officer: plain, concrete, professional English. " +
    "Never use emojis, never use markdown headings or bullet characters, never dramatise. Every quantified impact must be " +
    "a stated estimate grounded in published emission factors (for example: a petrol car near 0.17 kg CO2e per km, a " +
    "two-wheeler near 0.11, metro rail near 0.04 per passenger-km; an N95 respirator filters at least 95 percent of PM2.5 " +
    "when fitted). Follow Indian context: CPCB National AQI categories, INR costs, metro and bus networks, LPG versus " +
    "biomass cooking, stubble-burning seasonality in the northwest.";

  /* ---------- plan generation ---------- */

  function planSchemaText() {
    return "Return ONLY a JSON object with this exact shape:\n" +
      '{\n' +
      '  "headline": string (max 12 words),\n' +
      '  "summary": string (max 60 words, situates today in numbers),\n' +
      '  "routine": [ { "title": string, "window": string (IST time window or "all day"), "action": string (max 40 words), "impact": string (max 28 words, quantified estimate) } ],\n' +
      '  "indoor": [ same item shape ],\n' +
      '  "swaps": [ same item shape ],\n' +
      '  "risk_note": string (max 45 words, who is most at risk today and the single most important instruction)\n' +
      "}\n" +
      "Exactly 4 items in each of routine, indoor and swaps.";
  }

  function planUserMessage(ctx) {
    return "Live context for this household (JSON):\n" + JSON.stringify(ctx, null, 1) +
      "\n\nTask: produce today's action plan. Use the bestWindow and worstWindow values for timing. " +
      "Respect the household profile: budget governs which filtration options appear; cooking fuel governs kitchen items; " +
      "commute mode governs transport swaps; listed members tighten health advice. " +
      "Quantify the impact of every item (exposure avoided, PM2.5 reduction, CO2e saved, rupee cost) and mark it as an estimate.";
  }

  function sanitizePlan(plan) {
    if (!plan || typeof plan !== "object") return null;
    const str = function (v) { return typeof v === "string" ? v.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim() : ""; };
    const items = function (arr) {
      if (!Array.isArray(arr)) return null;
      const out = [];
      for (const raw of arr.slice(0, 4)) {
        if (!raw || typeof raw !== "object") continue;
        if (!str(raw.action)) continue;
        out.push({
          title: str(raw.title) || str(raw.action).slice(0, 60),
          window: str(raw.window) || "all day",
          action: str(raw.action),
          impact: str(raw.impact) || "Impact not quantified by the model."
        });
      }
      return out.length >= 3 ? out : null;
    };
    const routine = items(plan.routine), indoor = items(plan.indoor), swaps = items(plan.swaps);
    if (!routine || !indoor || !swaps) return null;
    return {
      headline: str(plan.headline) || "Your air-quality action plan",
      summary: str(plan.summary),
      routine: routine, indoor: indoor, swaps: swaps,
      risk_note: str(plan.risk_note)
    };
  }

  function generatePlan(ctx) {
    return CA_API.geminiChat(
      [
        { role: "system", content: PERSONA + " " + planSchemaText() },
        { role: "user", content: planUserMessage(ctx) }
      ],
      { jsonMode: true, temperature: 0.55, maxTokens: CA_CONFIG.gemini.planMaxTokens }
    ).then(function (res) {
      let parsed = null;
      try {
        const cleaned = res.text.replace(/^```(?:json)?/m, "").replace(/```$/m, "").trim();
        parsed = JSON.parse(cleaned);
      } catch (e) { /* fall through to validation failure */ }
      const plan = sanitizePlan(parsed);
      if (!plan) {
        const err = new Error("Model output failed validation");
        err.kind = "invalid";
        throw err;
      }
      return { mode: "ai", plan: plan, model: res.model };
    });
  }

  /* ---------- follow-up chat ---------- */

  function chatSystemPrompt(ctx) {
    return PERSONA + " You know this household's live data (JSON below). Answer in at most 180 words of plain " +
      "prose — no headings, no bullet lists, no emojis. Be specific to today; use the numbers given.\n" +
      JSON.stringify(ctx);
  }

  function askQuestion(ctx, question, history) {
    const msgs = [{ role: "system", content: chatSystemPrompt(ctx) }];
    for (const h of (history || []).slice(-6)) {
      msgs.push({ role: h.role === "user" ? "user" : "assistant", content: h.content });
    }
    msgs.push({ role: "user", content: question });
    return CA_API.geminiChat(msgs, {
      temperature: 0.6,
      maxTokens: CA_CONFIG.gemini.chatMaxTokens
    }).then(function (res) {
      return { mode: "ai", answer: res.text.trim(), model: res.model };
    });
  }

  /* ==========================================================================
   * Offline rules engine
   * ========================================================================== */

  function _label(v, unit) { return v === null || v === undefined ? "" : v + (unit || ""); }

  function localPlan(ctx) {
    const sev = ctx.category
      ? CA_AQI.CATEGORIES.findIndex(function (c) { return c.name === ctx.category; })
      : 2;
    const p = ctx.profile || {};
    const members = p.members || [];
    const sensitive = members.some(function (m) {
      return m === "elderly" || m === "respiratory" || m === "cardiac" || m === "pregnant";
    });
    const hasChildren = members.indexOf("children") !== -1;
    const roadside = p.home === "roadside";
    const biomass = p.cooking === "wood";
    const calm = ctx.weather && ctx.weather.windMs !== null && ctx.weather.windMs < 2.0;
    const cold = ctx.weather && ctx.weather.temperatureC !== null && ctx.weather.temperatureC < 10;

    const best = ctx.bestWindow || "the cleanest hours on the chart";
    const worst = ctx.worstWindow || "the overnight stretch";
    const budgetLow = p.budget === "low";
    const budgetHigh = p.budget === "high";

    /* --- routine --- */
    const routine = [];

    routine.push({
      title: "Shift the morning commute and school run into the cleanest window",
      window: best,
      action: "Travel, ventilate rooms and walk pets inside " + best +
        ". Outside that window keep the trip short, and skip roadside waiting: stand back from the kerb where concentrations drop measurably." +
        (calm ? " With wind near " + _label(ctx.weather.windMs, " m/s") + ", stagnant air keeps pollution close to the road, so distance from traffic matters most." : ""),
      impact: "Outdoor PM2.5 exposure scales roughly with time and breathing rate; aligning two outdoor trips with the cleanest 3-hour window can avoid about one third of a typical day's inhaled dose (estimate)."
    });

    if (hasChildren && sev >= 2) {
      routine.push({
        title: "Reschedule children's outdoor sports",
        window: "school hours",
        action: "Ask the school to move games period indoors or into " + best + " while the index sits at " +
          ctx.category + ". Children breathe faster than adults and their airways are still developing, so they take a proportionally larger dose of the same air.",
        impact: "An hour of vigorous play at AQI " + (ctx.aqi || 200) + " delivers roughly 3 to 4 times the inhaled PM2.5 of the same hour at rest (estimate)."
      });
    }

    routine.push({
      title: "Move exercise indoors while the index is elevated",
      window: sev >= 3 ? "all day" : "outside " + best,
      action: "Replace outdoor running or cycling with indoor alternatives until the index falls below " +
        (sev >= 4 ? "200" : "100") + ". If exercising outdoors is unavoidable, do it in " + best +
        " and slow the pace so you are not breathing heavily through an unfiltered mouth.",
      impact: "Ventilation rises from roughly 8 litres per minute at rest to 40 or more when running; matching the effort to the cleanest window can cut the inhaled dose for the same workout by about half (estimate)."
    });

    routine.push({
      title: "Plan the evening around the worst stretch",
      window: worst,
      action: "Treat " + worst + " as indoor time" +
        (cold ? ", and layer up rather than burning anything for warmth" : "") +
        ". Keep windows shut through it, finish cooking before it, and let anyone coming home change clothes at the door to keep settled particles off sofas and beds.",
      impact: "Forecast PM2.5 in the worst window peaks near " + (ctx.worstWindow && ctx.pm25 ? "about " + Math.round(ctx.pm25 * 1.4) : "several hundred") + " µg/m³ (estimate from the 48-hour model); staying indoors behind filtration reduces exposure by roughly 60 to 80 percent (estimate)."
    });

    /* --- indoor --- */
    const indoor = [];

    indoor.push({
      title: "Ventilate on schedule, not by habit",
      window: best,
      action: "Open windows crosswise for 10 to 15 minutes during " + best +
        " to flush the house" + (roadside ? ", using windows on the side away from the main road" : "") +
        ", then close them before " + (ctx.worstWindow || "the evening") + ". Around-the-clock closed windows let CO₂ and cooking moisture build; around-the-clock open windows import the street.",
      impact: "A short cross-draft exchanges most of a room's air at negligible cost; ventilating at the cleanest hour imports several times less PM2.5 than ventilating at the peak hour (estimate)."
    });

    if (budgetHigh) {
      indoor.push({
        title: "Run a HEPA purifier sized to the bedroom",
        window: "overnight",
        action: "Choose a unit rated CADR near 300 m³/h for a 20–30 m² room, run it on medium overnight with doors mostly shut, and change filters on schedule. Sleep is when a household spends the longest single block indoors, so the bedroom gives the best return.",
        impact: "Typical outlay ₹8,000–15,000; well-matched HEPA filtration lowers indoor PM2.5 by about 50–80 percent in a closed room (trial estimates)."
      });
    } else if (budgetLow) {
      indoor.push({
        title: "Build a box-fan filter for the main room",
        window: "evening and overnight",
        action: "Strap a pleated MERV-13 or FFP2 filter panel to the intake side of a standard table or box fan, run it on low with the door shut. Total cost stays under ₹2,500 using parts from any hardware shop; clean or replace the panel monthly in season.",
        impact: "Cost about ₹1,500–2,500 one-time; published trials of DIY fan filters report 50–80 percent PM2.5 reduction in sealed rooms within 1–2 hours (estimate)."
      });
    } else {
      indoor.push({
        title: "Filter the rooms where you sleep and work",
        window: "overnight",
        action: "A mid-range HEPA purifier in the bedroom is the first purchase; add a DIY box-fan filter for the living room if more area needs covering. Keep interior doors shut while running so the treated volume stays small.",
        impact: "₹2,000–15,000 depending on route; either route cuts indoor PM2.5 by roughly half in a closed room (estimate)."
      });
    }

    indoor.push({
      title: "Remove indoor combustion entirely",
      window: "all day",
      action: "No incense sticks, camphor, diyas, mosquito coils, tobacco or open-flame candles inside during the smog season" +
        (biomass ? ", and above all keep biomass or coal out of any enclosed kitchen" : "") +
        ". Each burning item is a point source in a closed volume; a single incense stick can push nearby indoor PM2.5 into the hundreds of µg/m³ within minutes (estimate).",
      impact: "Eliminating one indoor burn source per day removes an exposure stream comparable to a busy road at the kerb for the room it burns in (order-of-magnitude estimate)."
    });

    indoor.push({
      title: "Clean surfaces the wet way",
      window: "twice weekly, daily in severe episodes",
      action: "Mop with a damp cloth instead of sweeping, and vacuum only with a filtered machine if you own one. Dry sweeping and beating dust re-suspend the week's settled particles into the air you then breathe all evening.",
      impact: "Re-suspension after dry sweeping raises indoor PM2.5 for one to two hours; wet cleaning removes the reservoir without releasing it (directional estimate)."
    });

    /* --- swaps --- */
    const swaps = [];

    const commuteSwaps = {
      "car": {
        action: "Trade one private-car trip per day for the metro or bus, or share a ride",
        impact: "A typical 10 km petrol-car run releases about 1.7 kg CO₂e; the same trip on metro rail is near 0.4 kg per passenger (estimate). Ten traded trips a month save roughly 13 kg CO₂e and one parking-hassle-free week."
      },
      "two-wheeler": {
        action: "Take the metro or bus for the two-wheeler's longest daily trip",
        impact: "A 10 km two-wheeler run releases about 1.1 kg CO₂e versus near 0.4 kg by metro per passenger (estimate), and moves the rider out of the road-level plume into filtered air."
      },
      "public": {
        action: "Keep the public-transport habit and add one more shifted trip each week",
        impact: "Every 10 km shifted from a private car to the bus or metro avoids roughly 1.3 kg CO₂e (estimate); it also funds the service that makes the swap possible for others."
      },
      "walk-cycle": {
        action: "Keep walking and cycling, but route and time them away from traffic",
        action2: true,
        impact: "Active travel is near-zero tailpipe; shifting 10 km a week from a car to a bicycle avoids about 1.7 kg CO₂e (estimate), and cleaner-hour routing cuts the rider's PM2.5 dose substantially."
      },
      "wfh": {
        action: "Consolidate remote days into the most polluted weekdays",
        impact: "Each avoided 10 km commute day saves about 0.4–1.7 kg CO₂e depending on the mode replaced (estimate), and one work-from-home day a week removes a fifth of the commuting exposure a worker breathes."
      }
    };
    const cs = commuteSwaps[p.commute] || commuteSwaps["car"];
    swaps.push({
      title: "Transport: " + cs.action,
      window: "daily",
      action: cs.action + (p.commute === "walk-cycle" ? " Choose interior lanes and parks over main roads, and ride at " + best + "." : " Book the change into this week's calendar so it survives the first busy morning."),
      impact: cs.impact
    });

    if (biomass) {
      swaps.push({
        title: "Kitchen: move every meal to LPG or electric heat",
        window: "from today",
        action: "A Ujjwala-connected LPG cylinder or an induction plate removes the single largest PM2.5 source a household can own. If a biomass stove is still used for any meal, do it outdoors and never inside a living space.",
        impact: "One meal on a biomass chulha releases on the order of 10–20 g PM2.5 into the home; LPG releases essentially none indoors (WHO household-energy estimates). This is the highest-impact line in this plan."
      });
    } else {
      swaps.push({
        title: "Kitchen: use the chimney or extractor every single meal",
        window: "all day",
        action: "Run the range hood or open a window on the leeward side while frying or tempering, and prefer pressure cooking for long simmers. Frying oil and gas flames raise kitchen PM2.5 several-fold even with clean fuels.",
        impact: "Extraction during cooking can hold kitchen PM2.5 near background instead of a 3–10 fold spike (estimate); it also protects the room the purifier is working on."
      });
    }

    swaps.push({
      title: "Waste: never burn leaves, paper or household refuse",
      window: "always",
      action: "Compost what composts, hand the rest to municipal collection, and report repeated neighbourhood burning to the local body" +
        (sev >= 3 ? " — in today's " + ctx.category + " air, one burning pile is measurable across a whole street" : "") + ".",
      impact: "Burning 5 kg of mixed waste releases on the order of tens of grams of PM2.5, comparable to a petrol car's tailpipe over thousands of kilometres (order-of-magnitude estimate)."
    });

    swaps.push({
      title: "Household energy: shift the small loads off the grid peak",
      window: "evening",
      action: "Move washing machine or pump runs out of the evening peak, switch remaining bulbs to LED, and unplug idle chargers. Winter generation leans harder on thermal plants, so each saved unit is slightly dirtier than usual.",
      impact: "LED retrofits cut lighting electricity by about 80 percent (published estimates); a household saving 2 units a day avoids roughly 1.6 kg CO₂e daily from coal-heavy grids (estimate)."
    });

    /* --- summary, headline, risk --- */

    const wxLine = ctx.weather
      ? "Weather now " + ctx.weather.temperatureC + " °C, " + ctx.weather.humidityPct + " percent humidity, wind " +
        _label(ctx.weather.windMs, " m/s") + (calm ? " — calm air is trapping pollution near the surface." : ".")
      : "";

    const headline = "Air index " + (ctx.aqi !== null ? ctx.aqi : "n/a") + " — " +
      (ctx.category ? ctx.category.toLowerCase() : "unavailable") +
      (ctx.dominant ? ", driven by " + ctx.dominant : "");

    const summary = (ctx.place ? ctx.place + ": " : "") +
      (ctx.aqi !== null ? "CPCB-style index " + ctx.aqi + " (" + ctx.category + "), dominated by " + ctx.dominant +
        " at about " + ctx.pm25 + " µg/m³. " : "") +
      "Forecast trend " + (ctx.trend || "flat").toLowerCase() +
      (ctx.tomorrowMax ? ", tomorrow peaking near AQI " + ctx.tomorrowMax.aqi + " (" + ctx.tomorrowMax.category + "). " : ". ") +
      wxLine + " Cleanest window " + best + "; worst stretch " + worst + ".";

    const riskParts = [];
    if (sensitive) riskParts.push("Household members who are older, pregnant, or living with heart or lung disease face the highest risk today");
    else if (hasChildren) riskParts.push("Young children face the highest relative risk today");
    else riskParts.push("Sensitive groups in the neighbourhood face the highest risk today");
    riskParts.push((sev >= 3 ? "keep outdoor time short and filtered time long" :
      "time outdoor activity inside " + best) + ".");
    const risk_note = riskParts.join("; ");

    return {
      headline: headline,
      summary: summary,
      routine: routine, indoor: indoor, swaps: swaps,
      risk_note: risk_note
    };
  }

  /* plan with fallback: try AI, else rules engine */
  function generatePlanResilient(ctx) {
    return generatePlan(ctx).then(function (r) {
      return { mode: "ai", plan: r.plan, model: r.model };
    }).catch(function (e) {
      return {
        mode: "offline",
        plan: localPlan(ctx),
        reason: e.message || "AI engine unavailable",
        kind: e.kind || "error"
      };
    });
  }

  /* ---------- offline answers for follow-up questions ---------- */

  function localAnswer(ctx, question) {
    const q = String(question || "").toLowerCase();
    const best = ctx.bestWindow || "the cleanest hours on the chart";
    const worst = ctx.worstWindow || "the overnight stretch";
    const aqiTxt = ctx.aqi !== null ? "AQI " + ctx.aqi + " (" + ctx.category + ")" : "unavailable data";
    const has = function () {
      for (const kw of arguments) { if (q.indexOf(kw) !== -1) return true; }
      return false;
    };

    if (has("ventilat", "window", "open", "air the", "fresh air")) {
      return "Ventilate in " + best + " — open windows on opposite sides for 10 to 15 minutes to flush the house, then shut them before " + worst +
        ". Right now the index reads " + aqiTxt + (ctx.dominant ? ", dominated by " + ctx.dominant : "") +
        ". Ventilating at the cleanest hour imports several times less PM2.5 than ventilating at the peak hour (estimate).";
    }
    if (has("mask", "n95", "respirator")) {
      return "A properly fitted N95 or FFP2 respirator filters at least 95 percent of PM2.5; cloth masks and loose surgical masks filter far less. " +
        (ctx.category === "Poor" || ctx.category === "Very Poor" || ctx.category === "Severe"
          ? "At today's " + aqiTxt + ", wear one for any outdoor wait longer than a few minutes, especially at " + worst + "."
          : "At today's " + aqiTxt + " a respirator is worth wearing for long roadside waits, less necessary for short errands.") +
        " Fit matters more than brand: no gaps at the nose and jaw.";
    }
    if (has("purifier", "filter", "diy", "fan", "hepa")) {
      return "Filter the room you sleep in first. A HEPA purifier rated for the room runs ₹8,000–15,000; a box-fan filter built from a fan and a pleated panel stays under ₹2,500 and published trials report 50–80 percent PM2.5 reduction in sealed rooms (estimate). " +
        "Run either overnight with doors mostly shut, and pair it with wet mopping so settled dust is not re-suspended.";
    }
    if (has("jog", "run", "cycl", "exercise", "workout", "walk", "cricket", "sport", "badminton", "tennis")) {
      return "At " + aqiTxt + ", move exercise indoors" + (ctx.category === "Good" || ctx.category === "Satisfactory" ? " or keep it short and easy" : "") +
        ", or do it in " + best + ". Vigorous breathing multiplies the dose: running draws roughly 40 litres of air a minute against about 8 at rest, so the same hour outdoors can deliver 3 to 4 times the inhaled PM2.5 (estimate). " +
        "Slow the pace if you must stay out.";
    }
    if (has("school", "kid", "child", "son", "daughter", "baby")) {
      return "Children breathe faster and their airways are still developing, so at " + aqiTxt +
        " shift games period into " + best + " or indoors, and keep the school run short with windows up" +
        (ctx.category === "Poor" || ctx.category === "Very Poor" || ctx.category === "Severe" ? " — at this level, keep outdoor play under half an hour" : "") +
        ". No burning items in their bedroom, and wet-mop rather than sweep.";
    }
    if (has("elder", "old", "father", "mother", "grand", "asthma", "copd", "heart", "patient")) {
      return "For older family members or anyone with asthma, COPD or heart disease, today's " + aqiTxt +
        " argues for short outdoor trips, medicines on schedule and a written action plan from the doctor for bad-air days. " +
        "Keep their daytime room filtered, ventilate it in " + best + ", and seek care early if breathlessness or chest tightness appears — do not wait for symptoms to pass on a " + ctx.category + " day.";
    }
    if (has("plant", "trees")) {
      return "Houseplants barely move indoor PM2.5 — the air-exchange they achieve is negligible next to even a slow leak from a window, so do not rely on them. Trees and hedges outdoors help mainly as a screen: a dense hedge between a window and a road lowers roadside concentrations at the facade (directional estimate). Planting stays worthwhile for shade, heat and long-term city air, not for today's index.";
    }
    if (has("cook", "kitchen", "chulha", "lpg", "fry")) {
      return (ctx.profile && ctx.profile.cooking === "wood"
        ? "The household still uses biomass, and that is the largest exposure source you control: one meal on a chulha releases on the order of 10–20 g of PM2.5 indoors (estimate). Move every meal to LPG or induction, or at minimum cook outdoors."
        : "With LPG or electric cooking, use the chimney or an open leeward window for every frying or tempering session — kitchen PM2.5 can spike 3 to 10 fold without extraction (estimate). Pressure-cook long simmers and keep the kitchen door shut so the rest of the house stays clean.") +
        " Keep indoor burning — incense, coils, diyas — out of the kitchen and every other room.";
    }
    if (has("burn", "diya", "candle", "incense", "agarbatti", "coil", "smoke", "cigarette")) {
      return "Treat every indoor flame or smoke as a point source in a closed room: one incense stick or mosquito coil can push nearby PM2.5 into the hundreds of µg/m³ within minutes (estimate). At today's " + aqiTxt +
        " the household cannot afford an indoor combustion source. Move rituals to the balcony or veranda, keep tobacco strictly outdoors, and prefer electric lights over open candles.";
    }
    if (has("travel", "trip", "highway", "train", "flight", "delhi", "leave")) {
      return "For travel on a " + (ctx.category || "Moderate") + " day: prefer trains over road corridors in the smog belt, time road driving away from " + worst +
        ", keep the car on recirculate with a good cabin filter, and carry N95 respirators for station and street waits. " +
        (ctx.tomorrowMax ? "Tomorrow's peak is forecast near AQI " + ctx.tomorrowMax.aqi + " (" + ctx.tomorrowMax.category + "), so timing matters as much as route." : "Check the 48-hour chart before choosing the departure hour.");
    }
    if (has("tomorrow", "weekend", "later", "day after")) {
      const d = ctx.tomorrowMax;
      return d ? "Tomorrow peaks near AQI " + d.aqi + " (" + d.category + ") in this forecast, against " + aqiTxt + " now, with trend " + (ctx.trend || "flat").toLowerCase() +
        ". Plan outdoor events for the morning hours after any washout, keep the evening free of outdoor commitments, and re-check the chart before locking plans."
        : "The 48-hour chart above carries the hourly picture; re-check it before fixing outdoor plans, and plan them for the cleanest window rather than the calendar's convenience.";
    }
    if (has("co2", "carbon", "emission", "climate")) {
      return "Today's swaps add up: one metro trip instead of a car saves about 1.3 kg CO₂e (estimate), an LED retrofit cuts lighting electricity by about 80 percent, and eliminating any biomass cooking removes the household's largest single emission and exposure source at once. " +
        "Air-quality action and climate action mostly point the same way in an Indian winter — the same trip, fuel and burning choices drive both.";
    }

    /* default */
    return "Today reads " + aqiTxt + (ctx.dominant ? " with " + ctx.dominant + " dominant" : "") + ", trend " + (ctx.trend || "flat").toLowerCase() +
      ". The plan above already covers the highest-impact moves: time outdoor activity inside " + best + ", keep windows shut through " + worst +
      ", filter the bedroom overnight, and hold the household to zero indoor burning. Ask me anything more specific — a school event, a mask choice, ventilation timing — and I will answer against these same numbers.";
  }

  function askQuestionResilient(ctx, question, history) {
    return askQuestion(ctx, question, history).then(function (r) {
      return r;
    }).catch(function (e) {
      return { mode: "offline", answer: localAnswer(ctx, question), reason: e.message, kind: e.kind || "error" };
    });
  }

  /* ---------- plain-text rendering for the Copy button ---------- */

  function formatPlanAsText(plan, ctx) {
    const lines = [];
    lines.push("CLEAR AIR ADVISOR — ACTION PLAN");
    lines.push(ctx ? ctx.place : "");
    lines.push("");
    lines.push(plan.headline);
    if (plan.summary) { lines.push(""); lines.push(plan.summary); }
    const section = function (num, title, items) {
      lines.push("");
      lines.push(num + ". " + title.toUpperCase());
      items.forEach(function (it, i) {
        lines.push("  " + (i + 1) + ") " + it.title + (it.window && it.window !== "all day" ? " [" + it.window + "]" : ""));
        lines.push("     " + it.action);
        lines.push("     Impact: " + it.impact);
      });
    };
    section(1, "Low-emission daily routine", plan.routine);
    section(2, "Indoor air measures", plan.indoor);
    section(3, "Sustainable alternatives", plan.swaps);
    if (plan.risk_note) { lines.push(""); lines.push("NOTE: " + plan.risk_note); }
    lines.push("");
    lines.push("Impacts are engineering estimates from published emission factors. Not medical advice.");
    return lines.join("\n");
  }

  return {
    buildContext: buildContext,
    generatePlan: generatePlan,
    generatePlanResilient: generatePlanResilient,
    askQuestion: askQuestion,
    askQuestionResilient: askQuestionResilient,
    localPlan: localPlan,
    localAnswer: localAnswer,
    formatPlanAsText: formatPlanAsText
  };
})();
