# Lander

Launch from one planet, land on another. Plan the flight with four dials, no code. A new star system every day; the most fuel left tops the day.

Live: https://lander-topaz.vercel.app

## How it works

1. Sign in with Google. Ten shots a day.
2. Set four dials (launch time, far point, aim, brake altitude). The page flies the plan in a worker and draws the predicted path; on launch the server flies the same plan through the game physics in a sealed worker.
3. Everyone watching the site sees each launch as it happens. One launch flies at a time; if two people launch together, one is asked to hold and goes automatically next.
4. Each day is its own game: `api/today.js` creates the day's system from the date (a daily cron and the page itself call it). The best landing per pilot tops the day; all-time points add up the fuel-left percentage of each day's best landing.

## Pieces

- `index.html` is the whole site: system view, approach cam, telemetry, the mission planner, sign-in, shots, launch queue, live feed, daily and all-time boards. `lib/plan.js` is the shared autopilot behind the dials.
- `lib/engine.js` is the physics: a star, four or five planets on circular orbits, a rocket with a delta-v budget, adaptive steps. The same file runs in the browser and on the server.
- `lib/starter.js` is the starter bot. It reaches the target and arrives too fast.
- `lib/runner.js` runs an entrant's bot in a worker thread with a bare VM context and a wall-clock cap.
- `api/launch.js` flies a claimed plan and records the official flight. `api/today.js` makes sure today's system exists.
- Supabase holds games, profiles and launches. The server has no privileged key: it calls database functions as the signed-in user and proves server-only writes with an HMAC signature over a shared secret.

## Running it

Vercel, with these production environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GAME_SECRET` (must match `private.config` in the database),.

## Google sign-in setup (manual, once)

1. In Google Cloud Console, create an OAuth 2.0 client ID of type Web application. Add `https://wzywxpmzrblifpphzspf.supabase.co/auth/v1/callback` as an authorized redirect URI (the Supabase callback for this project) and the live site origin as an authorized JavaScript origin.
2. In Supabase, Authentication → Providers → Google: enable it and paste that client ID and client secret.
3. In Supabase, Authentication → URL Configuration: keep the Site URL and the redirect URL list pointing at the live site (both Vercel addresses are listed). Add any preview deployment URL you want to sign in from.

No other sign-in method exists. There is no email or password fallback.

Done on 2026-10-21: Google Cloud project `Lander` (lander-512323) with a published OAuth consent screen (homepage and privacy policy at the live site, `privacy.html`) and a Web application client; the Supabase Google provider is enabled with that client.

## Units

Star mass 1, G 1, the innermost orbit is about 1. Planets share one density, so mass goes with radius cubed. Fuel is a delta-v budget: throttle 1 burns `maxThrust` per time unit. Gravity is exaggerated so flybys matter.
