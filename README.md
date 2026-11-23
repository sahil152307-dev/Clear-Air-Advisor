# Clear Air Advisor

**PromptWars Challenge 6: Urban Air Quality Assistant**

Clear Air Advisor is a practical web assistant that helps Indian households understand live air pollution and turn AQI data into specific, safe, low-cost actions.

The complete application, source code, tests, and technical documentation are in [`clear-air-advisor/`](clear-air-advisor/). See the [full project README](clear-air-advisor/README.md) for setup and deployment instructions.

## Chosen vertical

This solution addresses the urban air-quality challenge for Indian families and communities. It is designed for residents who need to decide when to commute, exercise, ventilate a home, or take protective measures during high-pollution periods.

## Approach and logic

1. Resolve a city through the offline city list, geocoder, or browser geolocation.
2. Fetch live weather, air composition, and pollution forecasts.
3. Convert pollutant concentrations to estimated CPCB National AQI sub-indices and select the dominant pollutant.
4. Combine AQI, weather, forecast windows, household profile, and user goals into a Gemini prompt.
5. Return a structured action plan for immediate, indoor, and sustainable choices.
6. Use a deterministic rules engine if Gemini or the weather feed is unavailable, while clearly labelling fallback data.

## Assumptions

- Live pollutant readings are model or feed values, not certified CPCB station averages.
- AQI values and quantified environmental impacts are estimates, not exact measurements or medical guidance.
- Gemini output is advisory and can be overridden by official government health bulletins or a healthcare professional.
- OpenWeatherMap availability and API quota affect live-data updates.

## Key features

- India-wide city search and browser geolocation
- Estimated CPCB-style AQI for major pollutants
- 48-hour pollution outlook and cleaner ventilation windows
- Gemini-generated household action plan and follow-up chat
- Offline rules engine and clearly labelled demo-data fallback
- Responsive, accessible interface with copy and print support

## Security

Provider keys are stored in `.env.local` for local development or as Vercel Environment Variables for deployment. They are never prefixed with `NEXT_PUBLIC_` or exposed in browser code.

To run locally, first open the app folder:

```powershell
cd clear-air-advisor
.\scripts\dev.ps1
```

Keep API keys in `clear-air-advisor/.env.local`; never commit them.
