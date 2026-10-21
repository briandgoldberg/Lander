-- Applied to the Supabase project as migration "lander_starting_credits_3".
-- New profiles start with 3 launch credits; existing profiles are topped up to at least 3.
alter table public.profiles alter column credits set default 3;
update public.profiles set credits = greatest(credits, 3);
