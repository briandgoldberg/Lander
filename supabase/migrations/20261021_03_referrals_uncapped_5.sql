-- Applied to the Supabase project as migration "lander_referrals_uncapped_5".
-- Referral bonus: 5 launches per friend, no limit on friends. Still once per friend, still granted only here.
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
    update public.profiles set credits = credits + 5, referrals_rewarded = referrals_rewarded + 1 where user_id = pr.referred_by;
  end if;
  return jsonb_build_object('ok', true);
end $$;
