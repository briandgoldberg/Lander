# Lander

A proof of concept for a daily bot competition: launch from one planet, land on another, least fuel wins.

Live: https://briandgoldberg.github.io/Lander/

Open `index.html` in a browser. Everything is in that one file.

## The day's system

A sun with four to six planets on circular orbits. Each day picks a start planet and a target planet, a fuel budget, an engine and a deadline. Gravity is exaggerated so flybys bend a path visibly, the way Kerbal Space Program does it.

What you see matches the numbers:

- Orbits are drawn to scale.
- All planets are drawn at the same magnification (printed on the screen), so a planet that looks three times wider is three times wider.
- Planets share one density, so mass goes with radius cubed. A planet twice as wide is eight times as heavy.
- The approach cam is at true scale.

## How it works

- You submit JavaScript that defines `bot(world, sim)` and returns a controller `(state) => { throttle, dx, dy }`.
- The sandbox is a sealed Web Worker that owns the physics. Your code gets the day's system and a 10 second clock, can test-fly ideas with `sim.fly(controller)`, then returns a controller. The sandbox flies that controller for real, and the replay you watch is that flight.
- Score is fuel used. Lowest among safe landings wins. A safe landing means touching the target planet at a relative speed of at most `world.safeLandingSpeed`.

The starter bot finds a launch window, flies to the target and arrives too fast. Landing is your job.

## The real game

In the real game the day's system stays hidden until midnight, when every uploaded bot gets its clock on it blind. Then the system, replays and leaderboard are published for 24 hours while entrants improve their bots for tomorrow. This page shows today's system up front, so it is practice mode.

## Units

Sun mass 1, G 1, the innermost orbit is about 1. Fuel is a delta-v budget: throttle 1 burns `maxThrust` per time unit. Physics steps are adaptive, finer near planets and during burns. See the API reference on the page for `world`, `state` and `sim`.
