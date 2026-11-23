/* ==========================================================================
 * Clear Air Advisor — public client configuration
 *
 * Provider credentials are held by the server-side Vercel functions in /api.
 * ========================================================================== */

const CA_CONFIG = {
  gemini: {
    model: "gemini-3.5-flash-lite",
    planMaxTokens: 2200,
    chatMaxTokens: 700,
    temperature: 0.6,
    timeoutMs: 60000
  },

  owm: {
    units: "metric",
    lang: "en"
  },

  storage: {
    city: "caa.city",
    profile: "caa.profile"
  },

  allowDemoData: true
};

try {
  localStorage.removeItem("caa.openai.key");
  localStorage.removeItem("caa.owm.key");
} catch (error) {
  /* Browser storage may be unavailable; the app does not depend on it for keys. */
}
