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
