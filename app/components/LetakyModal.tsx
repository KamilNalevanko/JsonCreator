"use client";

import { useCallback, useEffect, useState } from "react";

type Country = "sk" | "cz" | "pl";

const COUNTRY_LABELS: Record<Country, string> = {
  sk: "🇸🇰 Slovensko",
  cz: "🇨🇿 Česko",
  pl: "🇵🇱 Poľsko",
};

type Flyer = {
  id: string;
  pages: number;
  dateFrom: string | null;
  dateTo: string | null;
  uploadedAt: string;
  cover: string;
};

type ShopFlyers = { country: string; shop: string; flyers: Flyer[] };

/** „2. 9. – 8. 9." alebo dátum nahratia, keď platnosť nie je zadaná. */
function validity(f: Flyer): string {
  const day = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : `${d.getDate()}. ${d.getMonth() + 1}.`;
  };
  const from = day(f.dateFrom);
  const to = day(f.dateTo);
  if (from && to) return `${from} – ${to}`;
  const up = day(f.uploadedAt);
  return up ? `nahraté ${up}` : "bez dátumu";
}

/** Leták, ktorého akcia už skončila — v appke sa nezobrazuje. */
function isExpired(f: Flyer): boolean {
  if (!f.dateTo) return false;
  return f.dateTo < new Date().toISOString().slice(0, 10);
}

function prettyShop(shop: string): string {
  return shop
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export default function LetakyModal({ onClose }: { onClose: () => void }) {
  const [country, setCountry] = useState<Country>("sk");
  const [shops, setShops] = useState<ShopFlyers[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/flyers?country=${country}`);
      const json = await res.json();
      if (json?.ok) setShops(json.shops ?? []);
      else setError(json?.error || "Nepodarilo sa načítať letáky.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [country]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (shop: string, flyer: Flyer) => {
    const label = `${prettyShop(shop)} — ${validity(flyer)} (${flyer.pages} strán)`;
    if (!window.confirm(`Naozaj zmazať leták?\n\n${label}\n\nZmaže sa aj z appky.`)) {
      return;
    }
    setBusyId(flyer.id);
    try {
      const res = await fetch("/api/flyers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country, shop, flyerId: flyer.id }),
      });
      const json = await res.json();
      if (!json?.ok) setError(json?.error || "Mazanie zlyhalo.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId("");
    }
  };

  const total = shops.reduce((n, s) => n + s.flyers.length, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <div className="my-8 w-full max-w-4xl rounded-2xl bg-[var(--surface)] p-5 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <h2 className="text-lg font-bold text-[color:var(--ink)]">
            📚 Letáky v aplikácii
          </h2>
          <select
            className="rounded-full border border-black/10 bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[color:var(--ink)]"
            value={country}
            onChange={(e) => setCountry(e.target.value as Country)}
          >
            {(Object.keys(COUNTRY_LABELS) as Country[]).map((c) => (
              <option key={c} value={c}>
                {COUNTRY_LABELS[c]}
              </option>
            ))}
          </select>
          <span className="text-xs text-[color:var(--muted)]">
            {loading ? "Načítavam…" : `${total} letákov`}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-full border border-[color:var(--line)] px-4 py-1.5 text-xs font-semibold text-[color:var(--ink)] hover:border-black/25"
          >
            Zavrieť
          </button>
        </div>

        {error ? (
          <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}

        {!loading && !shops.length ? (
          <div className="py-10 text-center text-sm text-[color:var(--muted)]">
            Pre túto krajinu zatiaľ nie je nahratý žiadny leták.
          </div>
        ) : null}

        <div className="flex flex-col gap-4">
          {shops.map((s) => (
            <div key={s.shop} className="rounded-xl border border-black/10 p-3">
              <div className="mb-2 text-sm font-bold text-[color:var(--ink)]">
                {prettyShop(s.shop)}
              </div>
              <div className="flex flex-wrap gap-3">
                {s.flyers.map((f) => (
                  <div
                    key={f.id}
                    className={`w-40 rounded-lg border p-2 ${
                      isExpired(f)
                        ? "border-black/10 opacity-60"
                        : "border-emerald-500/40"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={f.cover}
                      alt=""
                      className="mb-2 h-44 w-full rounded object-cover"
                    />
                    <div className="text-xs font-semibold text-[color:var(--ink)]">
                      {validity(f)}
                    </div>
                    <div className="mb-2 text-[11px] text-[color:var(--muted)]">
                      {f.pages} strán
                      {isExpired(f) ? " · po platnosti" : ""}
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(s.shop, f)}
                      disabled={busyId === f.id}
                      className="w-full rounded-full border border-red-300 px-2 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                    >
                      {busyId === f.id ? "Mažem…" : "🗑 Zmazať"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
