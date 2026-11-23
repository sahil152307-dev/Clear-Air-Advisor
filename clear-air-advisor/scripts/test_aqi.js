/* Sanity tests for the CPCB engine (run with: node scripts/test_aqi.js) */
const A = require("../js/aqi.js");

let pass = 0, fail = 0;
function eq(name, got, want, tol) {
  const ok = tol !== undefined ? Math.abs(got - want) <= tol : got === want;
  if (ok) { pass++; }
  else { fail++; console.log("FAIL:", name, "got", got, "want", want); }
}

/* PM2.5 breakpoints (exact CPCB examples: 30->50, 60->100, 90->200, 120->300, 250->400) */
eq("pm25 15.5 -> 26 (sub-index)", A.subIndex("pm25", 15.5), 26, 1);
eq("pm25 30 -> 50", A.subIndex("pm25", 30), 50);
eq("pm25 60 -> 100", A.subIndex("pm25", 60), 100);
eq("pm25 90 -> 200", A.subIndex("pm25", 90), 200);
eq("pm25 120 -> 300", A.subIndex("pm25", 120), 300);
eq("pm25 250 -> 400", A.subIndex("pm25", 250), 400);
eq("pm25 500 -> 500", A.subIndex("pm25", 500), 500);
eq("pm25 600 -> clamp 500", A.subIndex("pm25", 600), 500);
eq("pm25 interp 150 -> 323", A.subIndex("pm25", 150), 323, 1);

/* PM10: 100 -> 100, 250 -> 200 */
eq("pm10 100 -> 100", A.subIndex("pm10", 100), 100);
eq("pm10 250 -> 200", A.subIndex("pm10", 250), 200);
eq("pm10 430 -> 400", A.subIndex("pm10", 430), 400);

/* NO2, SO2, O3, CO, NH3 spot checks */
eq("no2 40 -> 50", A.subIndex("no2", 40), 50);
eq("no2 80 -> 100", A.subIndex("no2", 80), 100);
eq("so2 80 -> 100", A.subIndex("so2", 80), 100);
eq("o3 168 -> 200", A.subIndex("o3", 168), 200);
eq("co 2 mg -> 100", A.subIndex("co", 2), 100);
eq("nh3 200 -> 100", A.subIndex("nh3", 200), 100);

/* overall: max of sub-indices + dominant */
const o1 = A.overall({ pm25: 150, pm10: 100, no2: 20, o3: 30, co: 0.5, so2: 10, nh3: 10 });
eq("overall aqi = pm25 sub", o1.aqi, 323, 1);
eq("dominant is pm25", o1.dominant, "pm25");
eq("valid (7 pollutants)", o1.valid, true);

/* CO unit conversion from OWM feed */
const o2 = A.overall(A.fromOpenWeather({ pm2_5: 115.5, pm10: 180, no2: 30, o3: 40, so2: 12, nh3: 15, co: 1200 }));
eq("owm co 1200 ug = 1.2 mg -> sub 60", o2.subs.co, 60, 1);
eq("owm pm25 115.5 -> 285", o2.subs.pm25, 285, 1);
eq("owm overall = pm25 dominant", o2.dominant, "pm25");

/* partial data still yields an index but flags validity */
const o3 = A.overall({ pm25: 80 });
eq("single pollutant aqi", o3.aqi, 166.7, 1);
eq("single pollutant invalid", o3.valid, false);

/* categories */
eq("cat 45 Good", A.categoryOf(45).name, "Good");
eq("cat 150 Moderate", A.categoryOf(150).name, "Moderate");
eq("cat 480 Severe", A.categoryOf(480).name, "Severe");

/* forecast summarisation on a synthetic 96-hour list */
const now = Math.floor(Date.now() / 1000);
const list = [];
for (let i = 0; i < 96; i++) {
  const diurnal = 1 + 0.4 * Math.sin(((i + 9) % 24) / 24 * 2 * Math.PI);
  list.push({ dt: now + i * 3600, main: { aqi: 4 }, components: { pm2_5: 100 * diurnal, pm10: 140, no2: 25, o3: 30, so2: 10, nh3: 10, co: 800 } });
}
const s = A.summarizeForecast(list);
if (!s) { fail++; console.log("FAIL: summarizeForecast returned null"); } else {
  pass++;
  console.log("forecast: current aqi", Math.round(s.currentAqi), "| trend", s.trend.label, s.trend.delta, "| days", s.days.length);
  if (s.best && s.worst) { pass++; console.log("windows:", A.windowLabel(s.best.start, s.best.end), "vs", A.windowLabel(s.worst.start, s.worst.end)); }
  else { fail++; console.log("FAIL: windows missing"); }
}

/* IST conversion check */
const p = A.istParts(new Date("2026-11-23T06:30:00Z").getTime());
eq("IST hour for 06:30Z", p.hour, 12);
eq("IST date for 06:30Z", p.day, 23);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
