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

-- Appka (anon kľúč) smie vložiť/aktualizovať subscription. Identita = token
-- zariadenia; žiadne citlivé dáta. (Čítať anon nesmie.)
drop policy if exists "anon insert subscription" on public.watchdog_subscriptions;
create policy "anon insert subscription" on public.watchdog_subscriptions
  for insert to anon with check (true);

drop policy if exists "anon update subscription" on public.watchdog_subscriptions;
create policy "anon update subscription" on public.watchdog_subscriptions
  for update to anon using (true) with check (true);

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
