-- Applied to the Supabase project as migration "lander_feedback".
-- Feedback from the site. Written only through send_feedback; nobody can read it from the client.
create table if not exists public.feedback (
  id bigserial primary key,
  user_id uuid references auth.users(id),
  email text,
  message text not null,
  page text,
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;

create or replace function public.send_feedback(p_message text, p_email text default null, p_page text default null) returns jsonb language plpgsql security definer as $$
declare uid uuid := auth.uid(); em text; recent int;
begin
  if p_message is null or length(trim(p_message)) < 2 then raise exception 'empty'; end if;
  if length(p_message) > 4000 then raise exception 'too long'; end if;
  if uid is not null then em := auth.jwt() ->> 'email'; else em := left(nullif(trim(p_email), ''), 200); end if;
  if uid is not null then
    select count(*) into recent from public.feedback where user_id = uid and created_at > now() - interval '1 hour';
    if recent >= 10 then raise exception 'slow down'; end if;
  else
    select count(*) into recent from public.feedback where user_id is null and created_at > now() - interval '1 hour';
    if recent >= 60 then raise exception 'slow down'; end if;
  end if;
  insert into public.feedback(user_id, email, message, page) values (uid, em, trim(p_message), left(p_page, 200));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.send_feedback(text, text, text) to anon, authenticated;
