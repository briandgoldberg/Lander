-- Applied to the Supabase project as migration "lander_referrals".
-- Referrals: credits only, granted server-side when a referred player's first official launch finishes.
alter table public.profiles add column if not exists referral_code text;
alter table public.profiles add column if not exists referred_by uuid references auth.users(id);
alter table public.profiles add column if not exists referral_rewarded boolean not null default false;
alter table public.profiles add column if not exists referrals_rewarded int not null default 0;

create or replace function private.gen_ref_code() returns text language plpgsql security definer as $$
declare chars text := 'abcdefghjkmnpqrstuvwxyz23456789'; code text; i int;
begin
  loop
    code := '';
    for i in 1..8 loop code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1); end loop;
    exit when not exists (select 1 from public.profiles where referral_code = code);
  end loop;
  return code;
end $$;

update public.profiles set referral_code = private.gen_ref_code() where referral_code is null;
alter table public.profiles alter column referral_code set not null;
create unique index if not exists profiles_referral_code_key on public.profiles(referral_code);

drop function if exists public.ensure_profile();
create or replace function public.ensure_profile(p_ref text default null) returns jsonb language plpgsql security definer as $$
declare r public.profiles; ref_owner uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into r from public.profiles where user_id = auth.uid();
  if r.user_id is null then
    -- only a brand-new profile can be referred; self-referrals and unknown codes are ignored
    if p_ref is not null then
      select user_id into ref_owner from public.profiles where referral_code = lower(trim(p_ref)) and user_id <> auth.uid();
    end if;
    insert into public.profiles(user_id, email, referral_code, referred_by)
      values (auth.uid(), auth.jwt() ->> 'email', private.gen_ref_code(), ref_owner)
      returning * into r;
  else
    update public.profiles set email = auth.jwt() ->> 'email' where user_id = auth.uid() returning * into r;
  end if;
  return jsonb_build_object('user_id', r.user_id, 'email', r.email, 'credits', r.credits,
    'referral_code', r.referral_code, 'referrals_rewarded', r.referrals_rewarded, 'referred', r.referred_by is not null);
end $$;
grant execute on function public.ensure_profile(text) to anon, authenticated;

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
  -- referral bonus: a referred player's first finished official launch, whatever the outcome,
  -- gives the referrer +3 credits, once per friend, for at most 5 friends
  select * into pr from public.profiles where user_id = l.user_id for update;
  if pr.referred_by is not null and not pr.referral_rewarded then
    update public.profiles set referral_rewarded = true where user_id = l.user_id;
    update public.profiles set credits = credits + 3, referrals_rewarded = referrals_rewarded + 1
      where user_id = pr.referred_by and referrals_rewarded < 5;
  end if;
  return jsonb_build_object('ok', true);
end $$;
