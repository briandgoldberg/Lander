# Lander

Launch from one planet, land on another. Your JavaScript gets 10 seconds to plan the path. Most fuel left wins.

Live: https://lander-briandgoldbergs-projects.vercel.app

## How it works

1. Sign up with your email. A magic link signs you in. Your first launch is free, more are $1 each in USDC on Base.
2. Submit JavaScript that defines `bot(world, sim)` and returns a controller. On launch, the server runs it in a sealed worker with no network and a 10 second clock, then flies the controller you returned through the game's physics.
3. Everyone watching the site sees each launch as it happens. One launch flies at a time; if two people launch together, one is asked to hold and goes automatically next.
4. A game lasts 10 days. The safe landing with the most fuel left wins, and the winning code is published in Previous winners. Entering means agreeing to that.

## Pieces

- `index.html` is the whole site: system view, approach cam, telemetry, sign-in, credits, launch queue, live feed, leaderboard, previous winners, and a free practice sandbox that runs in the browser on a random system.
- `lib/engine.js` is the physics: a star, four or five planets on circular orbits, a rocket with a delta-v budget, adaptive steps. The same file runs in the browser and on the server.
- `lib/starter.js` is the starter bot. It reaches the target and arrives too fast.
- `lib/runner.js` runs an entrant's bot in a worker thread with a bare VM context and a wall-clock cap.
- `api/launch.js` runs a claimed launch and records the official flight. `api/pay.js` verifies a USDC transfer on Base and credits launches. `api/winner.js` reveals the winning code once a game ends.
- Supabase holds games, profiles, launches and payments. The server has no privileged key: it calls database functions as the signed-in user and proves server-only writes with an HMAC signature over a shared secret.

## Running it

Vercel, with these production environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GAME_SECRET` (must match `private.config` in the database), and optionally `TREASURY_ADDRESS` (a Base address that receives USDC; payments stay off until it is set) and `BASE_RPC_URL`.

One manual step in Supabase: Authentication → URL Configuration → set the Site URL to the live URL, so magic links come back to the site.

## Units

Star mass 1, G 1, the innermost orbit is about 1. Planets share one density, so mass goes with radius cubed. Fuel is a delta-v budget: throttle 1 burns `maxThrust` per time unit. Gravity is exaggerated so flybys matter.
