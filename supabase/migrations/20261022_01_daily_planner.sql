-- Applied to the Supabase project as migration "lander_daily_planner".
-- A new star system every day, three shots a day, one referral bonus, a beat-my-flight lookup, an all-time board.

alter table public.games add column if not exists day date;
create unique index if not exists games_day_key on public.games(day);
alter table public.profiles add column if not exists bonus_shots int not null default 0;

-- Day N is created by the server (api/today) with a signed world, idempotently.
create or replace function public.ensure_game(p_day date, p_world text, p_sig text) returns jsonb language plpgsql security definer as $$
declare g public.games; n int;
begin
  if not private.check_sig('game|' || p_day::text || '|' || p_world, p_sig) then raise exception 'bad signature'; end if;
  select * into g from public.games where day = p_day;
  if g.id is null then
    select coalesce(max(number), 0) + 1 into n from public.games;
    insert into public.games(number, name, world, day, started_at, ends_at)
      values (n, 'Day ' || n, p_world::jsonb, p_day, p_day::timestamptz, (p_day + 1)::timestamptz)
      on conflict (day) do nothing;
    select * into g from public.games where day = p_day;
  end if;
  return jsonb_build_object('id', g.id, 'number', g.number, 'name', g.name, 'day', g.day, 'ends_at', g.ends_at);
end $$;
grant execute on function public.ensure_game(date, text, text) to anon, authenticated;

-- The current game is the one whose day has not ended; otherwise the latest, flagged as over.
create or replace function public.game_state() returns jsonb language plpgsql stable security definer as $$
declare g public.games; w jsonb; pub jsonb; cur boolean;
begin
  select * into g from public.games where ends_at > now() order by started_at desc limit 1;
  cur := g.id is not null;
  if not cur then select * into g from public.games order by started_at desc limit 1; end if;
  if g.id is null then return jsonb_build_object('game', null); end if;
  w := g.world;
  pub := jsonb_build_object(
    'name', w->'name', 'sun', w->'sun', 'bodies', w->'bodies', 'start', w->'start', 'target', w->'target',
    'rocket', w->'rocket', 'deadline', w->'deadline', 'safeLandingSpeed', w->'safeLandingSpeed', 'hints', w->'hints', 'G', 1);
  return jsonb_build_object('game', jsonb_build_object('id', g.id, 'number', g.number, 'name', g.name, 'day', g.day, 'started_at', g.started_at, 'ends_at', g.ends_at,
    'current', cur, 'busy', g.busy_until > now(), 'busy_launch', g.busy_launch), 'world', pub);
end $$;

-- Shots: three per day, plus any bonus shots earned from referrals.
create or replace function public.shots_left(p_game integer) returns jsonb language plpgsql stable security definer as $$
declare used int; bonus int;
begin
  if auth.uid() is null then return jsonb_build_object('used', 0, 'bonus', 0, 'left', 0); end if;
  select count(*) into used from public.launches where game_id = p_game and user_id = auth.uid();
  select coalesce(bonus_shots, 0) into bonus from public.profiles where user_id = auth.uid();
  return jsonb_build_object('used', used, 'bonus', coalesce(bonus, 0), 'left', greatest(0, 3 - used) + coalesce(bonus, 0));
end $$;
grant execute on function public.shots_left(integer) to anon, authenticated;

-- A launch costs one of today's three shots, then one bonus shot. The code column holds the plan's dials.
create or replace function public.claim_launch(p_game integer, p_bot_name text, p_code text) returns jsonb language plpgsql security definer as $$
declare g public.games; pr public.profiles; lid bigint; used int; left_after int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(p_code) > 2000 then raise exception 'plan too long'; end if;
  select * into pr from public.profiles where user_id = auth.uid() for update;
  if pr.user_id is null then raise exception 'no profile'; end if;
  select * into g from public.games where id = p_game for update;
  if g.id is null then raise exception 'no game'; end if;
  if g.ends_at < now() then return jsonb_build_object('ok', false, 'reason', 'game_over'); end if;
  select count(*) into used from public.launches where game_id = p_game and user_id = auth.uid();
  if used >= 3 then
    if coalesce(pr.bonus_shots, 0) < 1 then return jsonb_build_object('ok', false, 'reason', 'no_credits'); end if;
  end if;
  if g.busy_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'hold', 'wait_ms', greatest(1000, (extract(epoch from (g.busy_until - now())) * 1000)::int), 'busy_launch', g.busy_launch);
  end if;
  if used >= 3 then update public.profiles set bonus_shots = bonus_shots - 1 where user_id = auth.uid(); end if;
  insert into public.launches(game_id, user_id, bot_name, code) values (p_game, auth.uid(), left(coalesce(nullif(trim(p_bot_name), ''), 'plan'), 24), p_code) returning id into lid;
  update public.games set busy_until = now() + interval '75 seconds', busy_launch = lid where id = p_game;
  left_after := greatest(0, 3 - used - 1) + (select coalesce(bonus_shots, 0) from public.profiles where user_id = auth.uid());
  return jsonb_build_object('ok', true, 'launch_id', lid, 'shots_left', left_after);
end $$;

-- The one referral reward: a friend who joined from your link and launched gives you 3 shots, once per friend.
create or replace function public.finish_launch(p_launch bigint, p_result text, p_sig text) returns jsonb language plpgsql security definer as $$
declare l public.launches; r jsonb; pr public.profiles;
begin
  if not private.check_sig(p_launch::text || '|' || p_result, p_sig) then raise exception 'bad signature'; end if;
  r := p_result::jsonb;
  select * into l from public.launches where id = p_launch for update;
  if l.id is null then raise exception 'no launch'; end if;
  if l.status = 'done' then return jsonb_build_object('ok', true, 'already', true); end if;
  update public.launches set
    status = 'done', outcome = r->>'outcome', body = r->>'body',
    fuel_used = (r->>'fuelUsed')::numeric, fuel_left = (r->>'fuelLeft')::numeric,
    landing_speed = (r->>'landingSpeed')::numeric, flights = (r->>'flights')::int,
    think_ms = (r->>'thinkMs')::int, error = r->>'error', samples = r->'samples', finished_at = now()
    where id = p_launch;
  update public.games set busy_until = now() where busy_launch = p_launch;
  select * into pr from public.profiles where user_id = l.user_id for update;
  if pr.referred_by is not null and not pr.referral_rewarded then
    update public.profiles set referral_rewarded = true where user_id = l.user_id;
    update public.profiles set bonus_shots = bonus_shots + 3, referrals_rewarded = referrals_rewarded + 1 where user_id = pr.referred_by;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Everything a "beat my flight" link needs, including the sharer's referral code.
create or replace function public.beat_info(p_launch bigint) returns jsonb language plpgsql stable security definer as $$
declare l public.launches; p public.profiles; g public.games;
begin
  select * into l from public.launches where id = p_launch and status = 'done';
  if l.id is null then return null; end if;
  select * into p from public.profiles where user_id = l.user_id;
  select * into g from public.games where id = l.game_id;
  return jsonb_build_object('id', l.id, 'game_id', l.game_id, 'day', g.day, 'game_name', g.name, 'system', g.world->>'name',
    'pilot', split_part(coalesce(p.email, ''), '@', 1), 'ref', p.referral_code,
    'outcome', l.outcome, 'body', l.body, 'fuel_left', l.fuel_left, 'landing_speed', l.landing_speed, 'samples', l.samples, 'plan', l.code);
end $$;
grant execute on function public.beat_info(bigint) to anon, authenticated;

-- All-time: each day's best landing scores fuel left as a percentage of that day's budget; points add up.
create or replace function public.alltime() returns jsonb language sql stable security definer as $$
  select coalesce(jsonb_agg(row_to_json(t) order by t.points desc, t.days desc), '[]'::jsonb) from (
    select split_part(coalesce(p.email, ''), '@', 1) as pilot, round(sum(best.pct)::numeric, 1) as points, count(*) as days
    from (
      select l.user_id, l.game_id, max(l.fuel_left / nullif((g.world->'rocket'->>'fuel')::numeric, 0) * 100) as pct
      from public.launches l join public.games g on g.id = l.game_id
      where l.status = 'done' and l.outcome = 'landed' group by l.user_id, l.game_id
    ) best join public.profiles p on p.user_id = best.user_id
    group by best.user_id, p.email order by points desc limit 25
  ) t
$$;
grant execute on function public.alltime() to anon, authenticated;

-- Game #1 (the ten-day round) ends now; the daily systems take over.
update public.games set ends_at = now() where number = 1 and ends_at > now();

-- Applied later the same day as migration "lander_ten_shots_ranked_board":
-- ten shots a day, no referral reward, closest_approach stored, board ranks landings > crashes on target > nearest misses.
-- (see the function bodies in the Supabase project; this file records the intent)

-- Applied later as migration "lander_flights_start_from_now": launches.t_start, get_launch_code returns
-- created_at and the game's started_at, finish_launch stores tStart, get_replay returns t_start.
-- A flight starts from the sky as it looked when the launch was claimed (see lib/plan.js liveRate/worldAt).

-- Applied as "lander_day_exists" (day_exists(p_day) helper for api/today) and "lander_current_game_started":
-- game_state only treats a game as current once its started_at has passed, since tomorrow's system is made a day ahead.

-- Applied as "lander_unlimited_launches": no cap on launches per day; shots_left returns left = null; claim_launch also
-- refuses games whose day has not started.

-- 2026-10-23: the share card shares the pilot's best launch of the day (same ranking as the leaderboard)
create or replace function public.my_best_launch(p_game integer) returns jsonb language sql stable security definer as $$
  select to_jsonb(t) from (
    select l.id, l.bot_name, l.status, l.outcome, l.body, l.fuel_left, l.closest_approach, l.created_at
    from public.launches l join public.games g on g.id = l.game_id
    where l.user_id = auth.uid() and l.game_id = p_game and l.status = 'done' and l.outcome <> 'error'
    order by case when l.outcome = 'landed' then 0 when l.outcome = 'crashed' and l.body = g.world->'bodies'->(g.world->>'target')::int->>'name' then 1 else 2 end,
      case when l.outcome = 'landed' or (l.outcome = 'crashed' and l.body = g.world->'bodies'->(g.world->>'target')::int->>'name') then -coalesce(l.fuel_left, 0) else coalesce(l.closest_approach, 1e9) end,
      l.created_at desc
    limit 1
  ) t
$$;
grant execute on function public.my_best_launch(integer) to authenticated;

-- 2026-10-23 evening: the live sky. claim_launch no longer holds the pad (everyone may launch at once; api/launch stamps
-- t_start five real seconds after the claim so viewers see the countdown). One replay per pilot per day: keep_best_replay /
-- sweep_replays null the samples of a pilot's other flights once they are ten minutes old (called from finish_launch and
-- claim_launch); leaderboard breaks ties by newest flight to match. game_list() and game_world(p_game) feed the board's
-- day picker and replays from past days. Definitions live in the database (created via the Supabase MCP); see pg_get_functiondef.

-- 2026-10-23: days are Pacific-time calendar days. ensure_game sets started_at/ends_at to midnight America/Los_Angeles;
-- api/today computes the day in that zone; the cron runs at 07:02 and 08:02 UTC (PDT/PST midnight). Games relabelled:
-- id 2 = 2026-10-21 (Day 1), id 10 = 2026-10-22 (Day 2), id 8 = 2026-10-23 (Day 3).

-- 2026-10-23: the physics is hidden from the browser. public_world(w) strips a game's world to what the page draws
-- (no masses, thrust, hints; hill -> zone rounded to one significant figure; floor = hints.stage1, the departure burn's
-- minimum). game_state and game_world(p_game) return the public world; game_world_full(p_game, p_sig) returns the real
-- one to the server (signed 'world|<id>'). api/today stores hints.stage1 when it creates a day.

-- 2026-10-23: Abort. abort_launch(p_launch, p_tau) lets the pilot end their own in-flight launch at flight time p_tau:
-- samples and burns are cut there, outcome = 'aborted', closest_approach recomputed over the kept samples, fuel_left from
-- the last kept sample, lands_at = now() so the pad frees at once. launches.abort_t (also in launch_feed) tells viewers.
