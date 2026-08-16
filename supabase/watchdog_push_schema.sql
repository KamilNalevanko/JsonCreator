-- ===========================================================================
-- Strážny pes — push aj keď je appka vypnutá (Fáza 3)
-- Spusti v Supabase → SQL Editor. Vyžaduje rozšírenia pg_cron a pg_net
-- (Supabase → Database → Extensions → zapni "pg_cron" a "pg_net").
-- ===========================================================================

-- 1) Subscriptions: appka sem nahráva token zariadenia + sledované produkty.
create table if not exists public.watchdog_subscriptions (
  token       text primary key,
  country     text not null,
  watches     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.watchdog_subscriptions enable row level security;

-- Appka (anon kľúč) robí UPSERT (insert + on-conflict update) svojej subscription.
-- Upsert cez PostgREST potrebuje aj SELECT (kontrola konfliktu), preto sú všetky
-- tri policy. Dáta sú málo citlivé (FCM token + kľúče sledovaných produktov,
-- žiadne meno/email; token sa bez server-kľúča nedá zneužiť).
-- (Čistejšia alternatíva do budúcna: zápis cez Edge Function so service role
--  a anon bez prístupu k tabuľke.)
drop policy if exists "anon insert subscription" on public.watchdog_subscriptions;
drop policy if exists "anon update subscription" on public.watchdog_subscriptions;
drop policy if exists "sub insert" on public.watchdog_subscriptions;
drop policy if exists "sub update" on public.watchdog_subscriptions;
drop policy if exists "sub select" on public.watchdog_subscriptions;
create policy "sub insert" on public.watchdog_subscriptions
  for insert to public with check (true);
create policy "sub update" on public.watchdog_subscriptions
  for update to public using (true) with check (true);
create policy "sub select" on public.watchdog_subscriptions
  for select to public using (true);

-- 2) Log odoslaných pushov — aby sa tá istá akcia neposlala dvakrát.
create table if not exists public.watchdog_push_log (
  token      text not null,
  signature  text not null,
  sent_at    timestamptz not null default now(),
  primary key (token, signature)
);

alter table public.watchdog_push_log enable row level security;
-- Žiadny anon prístup — číta/píše len Edge Function (service role).

-- 3) Naplánuj denné spustenie Edge Function watchdog-push (o 08:00).
--    NAHRAĎ <PROJECT_REF> a <ANON_KEY> svojimi hodnotami.
-- select cron.unschedule('watchdog-push-daily');  -- ak chceš prehodiť
select cron.schedule(
  'watchdog-push-daily',
  '0 8 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/watchdog-push',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer <ANON_KEY>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- 4) Týždenné upratovanie (nedeľa 03:00) — nech DB nerastie donekonečna:
--    starý log + prázdne/neaktívne subscriptions. (Mŕtve tokeny maže priamo
--    Edge Function pri neúspešnom odoslaní.)
select cron.schedule(
  'watchdog-cleanup-weekly',
  '0 3 * * 0',
  $$
  delete from public.watchdog_push_log
    where sent_at < now() - interval '60 days';
  delete from public.watchdog_subscriptions
    where jsonb_array_length(watches) = 0
      and updated_at < now() - interval '7 days';
  $$
);
