-- ===========================================================================
-- Naplánované notifikácie — „nastav a zabudni".
-- Editor sem zapíše notifikáciu s časom odoslania (send_at). Supabase (pg_cron)
-- každú minútu spustí Edge Function `scheduled-push`, ktorá pošle tie, ktorých
-- čas už nastal, a označí ich ako odoslané. PC/editor môže byť medzitým vypnuté.
--
-- Spusti v Supabase → SQL Editor. Vyžaduje pg_cron + pg_net (rovnako ako watchdog).
-- ===========================================================================

create table if not exists public.scheduled_notifications (
  id          uuid primary key default gen_random_uuid(),
  country     text not null,                 -- sk / cz / pl (edge fn si zmapuje cz→cs)
  title       text not null default '',
  message     text not null default '',
  data        jsonb not null default '{}'::jsonb,  -- deep-link: category/subcategory/placement/product/shop
  token       text,                          -- nepovinné: test len na 1 zariadenie
  send_at     timestamptz not null,          -- kedy sa má odoslať
  sent        boolean not null default false,
  sent_at     timestamptz,
  error       text,
  created_at  timestamptz not null default now()
);

-- Rýchle vyhľadanie „čo treba poslať teraz".
create index if not exists scheduled_notifications_due_idx
  on public.scheduled_notifications (send_at)
  where sent = false;

alter table public.scheduled_notifications enable row level security;

-- Zápis/čítanie/mazanie robí LEN editor cez service role (ktorý RLS obchádza).
-- Žiadne anon policy → appka ani nikto s anon kľúčom sem nemá prístup.

-- ---------------------------------------------------------------------------
-- pg_cron: každú minútu spusti Edge Function scheduled-push.
--   NAHRAĎ <PROJECT_REF> a <ANON_KEY> svojimi hodnotami.
-- select cron.unschedule('scheduled-push-minutely');  -- ak chceš prehodiť
-- ---------------------------------------------------------------------------
select cron.schedule(
  'scheduled-push-minutely',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.functions.supabase.co/scheduled-push',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer <ANON_KEY>'
               ),
    body    := '{}'::jsonb
  );
  $$
);

-- Voliteľné upratovanie: staré odoslané záznamy po 30 dňoch zmaž.
select cron.schedule(
  'scheduled-cleanup-weekly',
  '0 3 * * 0',
  $$
  delete from public.scheduled_notifications
    where sent = true and sent_at < now() - interval '30 days';
  $$
);
