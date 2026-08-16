# Push notifikácie (FCM) — návod na sprevádzkovanie

Appka aj editor sú hotové. Aby push naozaj chodil (aj na vypnuté telefóny),
treba spraviť tieto jednorazové kroky. Rozdelené na Android (funguje hneď) a
iOS (potrebuje APNs kľúč).

---

## 1) Firebase — service account kľúč (na odosielanie)
Firebase konzola → ⚙️ Project settings → **Service accounts** → **Generate new
private key** → stiahne sa JSON.

Použije sa na 2 miestach:
- **Editor** (broadcast) — vlož do `.env.local`:
  ```
  FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"cap-porovnavac-cien", ... celý JSON na jednom riadku ... }
  ```
- **Supabase Edge Function** (personalizovaný pes) — viď krok 4.

> ⚠️ Tento kľúč je tajný. Editor sa nenasadzuje (beží len lokálne), takže je to OK.
> `.env.local` NIKDY necommituj.

## 2) iOS — APNs kľúč (bez neho iOS push nefunguje)
1. [Apple Developer](https://developer.apple.com/account) → Certificates, IDs & Profiles →
   **Keys** → **+** → zaškrtni **Apple Push Notifications service (APNs)** → Continue →
   Register → stiahni `.p8` (dá sa stiahnuť len raz!). Poznač si **Key ID** a **Team ID**.
2. Firebase konzola → Project settings → **Cloud Messaging** → sekcia **Apple app
   configuration** → nahraj `.p8` + Key ID + Team ID.
3. V Apple Developer pri App ID `com.tarbaj.cap` zapni capability **Push Notifications**
   (Codemagic to pri automatickom podpise pridá do profilu).

Android nič nepotrebuje — funguje cez už nastavený `google-services.json`.

## 3) Broadcast z editora (vlastné notifikácie)
Spusti editor (`npm run dev`) a otvor **`/notifikacie`**. Vyplň krajinu + titul +
text (voliteľne názov produktu na preklik) a pošli. Doručí sa všetkým s daným
jazykom appky — aj na vypnuté telefóny (pípne + odznak).

Appka sa prihlasuje na kanál `deals_sk` / `deals_cs` / `deals_pl` podľa jazyka.

## 4) Personalizovaný strážny pes offline (Supabase)
1. **SQL:** Supabase → SQL Editor → spusti `watchdog_push_schema.sql`
   (najprv zapni rozšírenia **pg_cron** a **pg_net** v Database → Extensions).
   V SQL nahraď `<PROJECT_REF>` a `<ANON_KEY>`.
2. **Edge Function:** z tohto priečinka:
   ```bash
   supabase functions deploy watchdog-push --no-verify-jwt
   ```
3. **Secret:** Supabase → Edge Functions → watchdog-push → Secrets → pridaj
   `FIREBASE_SERVICE_ACCOUNT` = ten istý JSON ako v kroku 1.
4. **Test:** zavolaj funkciu ručne (alebo počkaj na cron o 08:00):
   ```bash
   curl -X POST 'https://<PROJECT_REF>.functions.supabase.co/watchdog-push' \
     -H 'Authorization: Bearer <ANON_KEY>'
   ```
   Odpoveď `{"ok":true,"sent":N}` = poslaných N notifikácií.

Ako to funguje: appka nahráva token + sledované produkty do
`watchdog_subscriptions`. Funkcia denne porovná s aktívnymi akciami v
`master_products_v2`, pošle každému jeho zhody a zaloguje ich do
`watchdog_push_log`, aby sa neopakovali.

---

## Poradie odporúčam
1. Krok 1 (service account) + krok 3 (broadcast) — otestuj na Androide hneď.
2. Krok 2 (APNs) — pridaj iOS.
3. Krok 4 (Supabase) — zapni personalizovaný offline strážny pes.
