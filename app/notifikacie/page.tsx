"use client";

import { useState } from "react";

type Country = "sk" | "cz" | "pl";

const COUNTRY_LABELS: Record<Country, string> = {
  sk: "🇸🇰 Slovensko",
  cz: "🇨🇿 Česko",
  pl: "🇵🇱 Poľsko",
};

export default function NotifikaciePage() {
  const [country, setCountry] = useState<Country>("sk");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [product, setProduct] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    { ok: boolean; text: string } | null
  >(null);

  const send = async () => {
    if (!title.trim() && !message.trim()) {
      setResult({ ok: false, text: "Vyplň aspoň titul alebo text správy." });
      return;
    }
    const confirmed = window.confirm(
      `Naozaj poslať notifikáciu VŠETKÝM používateľom (${COUNTRY_LABELS[country]})?\n\n` +
        `Titul: ${title || "(prázdny)"}\nText: ${message || "(prázdny)"}`,
    );
    if (!confirmed) return;

    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/send-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country,
          title: title.trim(),
          message: message.trim(),
          product: product.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setResult({
          ok: true,
          text: `Odoslané ✅ (kanál ${json.topic}). Doručí sa aj na vypnuté telefóny.`,
        });
        setTitle("");
        setMessage("");
        setProduct("");
      } else {
        setResult({ ok: false, text: `Chyba: ${json.error}` });
      }
    } catch (e) {
      setResult({
        ok: false,
        text: `Chyba siete: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <div className="mx-auto max-w-xl">
        <a
          href="/"
          className="text-sm text-blue-400 hover:underline"
        >
          ← Späť do editora letákov
        </a>
        <h1 className="mt-4 text-2xl font-bold">📣 Poslať notifikáciu</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Notifikácia príde všetkým používateľom s vybraným jazykom appky —
          <strong> aj keď majú appku vypnutú</strong> (pípne + odznak).
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Krajina</label>
            <div className="flex gap-2">
              {(Object.keys(COUNTRY_LABELS) as Country[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCountry(c)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium border transition ${
                    country === c
                      ? "bg-blue-600 border-blue-500"
                      : "bg-neutral-900 border-neutral-700 hover:border-neutral-500"
                  }`}
                >
                  {COUNTRY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Titul</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={60}
              placeholder="napr. Najlacnejšie kuracie stehná! 🐔"
              className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 outline-none focus:border-blue-500"
            />
            <div className="text-right text-xs text-neutral-500">
              {title.length}/60
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Text správy</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={180}
              rows={3}
              placeholder="napr. Tento týždeň len za 2,99 €/kg v akcii. Pozri sa!"
              className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 outline-none focus:border-blue-500 resize-none"
            />
            <div className="text-right text-xs text-neutral-500">
              {message.length}/180
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Produkt na preklik <span className="text-neutral-500">(voliteľné)</span>
            </label>
            <input
              value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="napr. Kuracie stehná — po tapnutí hodí do produktu"
              className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 outline-none focus:border-blue-500"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Ak vyplníš názov produktu, tapnutie na notifikáciu otvorí appku
              rovno pri tomto produkte (ak ho appka nájde v aktuálnych letákoch).
            </p>
          </div>

          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-3 font-semibold"
          >
            {sending ? "Odosielam…" : "📣 Poslať notifikáciu"}
          </button>

          {result && (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                result.ok
                  ? "bg-green-900/40 border border-green-700 text-green-200"
                  : "bg-red-900/40 border border-red-700 text-red-200"
              }`}
            >
              {result.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
