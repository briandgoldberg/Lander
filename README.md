# Lander

A proof of concept for a daily bot competition: least fuel from a planet's launch pad to a soft landing on its moon.

Open `index.html` in a browser. Everything is in that one file.

## How it works

- Each day has a system: a planet, a moon on a circular orbit, a launch site, a fuel budget and a deadline. The physics is a 2D restricted three-body problem (planet fixed, moon on rails, rocket massless).
- You submit JavaScript that defines `bot(world, sim)` and returns a controller `(state) => { throttle, dx, dy }`.
- The sandbox is a sealed Web Worker that owns the physics. Your code gets the day's system and a 10 second clock, can test-fly ideas with `sim.fly(controller)`, then returns a controller. The sandbox flies that controller for real, and the replay you watch is that flight.
- Score is fuel used. Lowest among safe landings wins. A safe landing means touching the moon at a relative speed of at most `world.safeLandingSpeed`.

The starter bot lands, wastefully. Beat it.

## The real game

In the real game the day's system stays hidden until midnight, when every uploaded bot gets its clock on it blind. Then the system, replays and leaderboard are published for 24 hours while entrants improve their bots for tomorrow. This page shows today's system up front, so it is practice mode.

## Units

Planet radius 1, planet mass 1, G 1, `dt` 0.01. Fuel is a delta-v budget: throttle 1 burns `maxThrust` per time unit. See the API reference on the page for `world`, `state` and `sim`.
