"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Farby podľa appky (lib/ui_constants.dart), tmavý režim.
const GREEN = "#739B7B"; // darkPrimary
const GREEN_BRIGHT = "#53B175"; // lightMainGreen — na zvýraznenie
const BG = "#0F1412";
const CARD = "#18201C";
const BORDER = "#26312B";
const INK = "#E8EFEA";
const MUTED = "#8FA398";

type Day = {
  date: string;
  activeUsers: number;
  newUsers: number;
  impressions: number;
  revenue: number;
  ecpm: number;
  ctr: number;
  arpdau: number | null;
};

type Payload = {
  ok: boolean;
  from: string;
  to: string;
  days: Day[];
  totals: {
    newUsers: number;
    impressions: number;
    revenue: number;
    avgActiveUsers: number;
  };
  warnings: string[];
};

const fmt = (n: number, digits = 0) =>
  n.toLocaleString("sk-SK", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.`;
};

export default function PrehladPage() {
  const [days, setDays] = useState(28);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (range: number) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/prehlad?days=${range}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        setError(json?.error || "Údaje sa nepodarilo načítať.");
        return;
      }
      setData(json);
    } catch {
      setError("Údaje sa nepodarilo načítať.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  // Posledných 7 dní oproti predchádzajúcim 7 — či to ide hore alebo dole.
  const trend = useMemo(() => {
    if (!data || data.days.length < 14) return null;
    const tail = data.days.slice(-7);
    const prev = data.days.slice(-14, -7);
    const sum = (rows: Day[], pick: (d: Day) => number) =>
      rows.reduce((a, d) => a + pick(d), 0);
    const now = sum(tail, (d) => d.newUsers);
    const before = sum(prev, (d) => d.newUsers);
    if (before === 0) return null;
    return Math.round(((now - before) / before) * 100);
  }, [data]);

  const maxActive = useMemo(
    () => Math.max(1, ...(data?.days ?? []).map((d) => d.activeUsers)),
    [data],
  );

  return (
    <div style={{ background: BG, minHeight: "100vh", color: INK }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 64px" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>
              Prehľad <span style={{ color: GREEN_BRIGHT }}>CAP</span>
            </h1>
            <p style={{ margin: "6px 0 0", color: MUTED, fontSize: 14 }}>
              {data ? `${data.from} — ${data.to}` : "Načítavam…"}
            </p>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            {[7, 28, 90].map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                style={{
                  background: r === days ? GREEN : "transparent",
                  color: r === days ? "#0F1412" : MUTED,
                  border: `1px solid ${r === days ? GREEN : BORDER}`,
                  borderRadius: 10,
                  padding: "8px 16px",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {r} dní
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div
            style={{
              background: "#2A1A1A",
              border: "1px solid #5A2A2A",
              color: "#F0B0B0",
              borderRadius: 12,
              padding: "12px 16px",
              marginBottom: 20,
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        {/* Hlavné čísla */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
            gap: 16,
            marginBottom: 28,
          }}
        >
          <Stat
            label="Noví používatelia"
            value={data ? fmt(data.totals.newUsers) : "—"}
            note={
              trend === null
                ? "za zvolené obdobie"
                : `${trend >= 0 ? "▲" : "▼"} ${Math.abs(trend)} % oproti predošlému týždňu`
            }
            noteColor={trend === null ? MUTED : trend >= 0 ? GREEN_BRIGHT : "#D98A8A"}
          />
          <Stat
            label="Aktívni denne (priemer)"
            value={data ? fmt(data.totals.avgActiveUsers) : "—"}
            note="koľko ľudí appku otvorí za deň"
          />
          <Stat
            label="Impresie reklám"
            value={data ? fmt(data.totals.impressions) : "—"}
            note="reklamy sú momentálne vypnuté"
          />
          <Stat
            label="Príjem z reklám"
            value={data ? `$${fmt(data.totals.revenue, 2)}` : "—"}
            note="za zvolené obdobie"
          />
        </div>

        {/* Graf aktívnych a nových */}
        <Card title="Používatelia po dňoch">
          {loading && !data ? (
            <p style={{ color: MUTED, fontSize: 14 }}>Načítavam…</p>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 3,
                  height: 180,
                  marginBottom: 10,
                }}
              >
                {(data?.days ?? []).map((d) => (
                  <div
                    key={d.date}
                    title={`${d.date}\naktívni: ${d.activeUsers}\nnoví: ${d.newUsers}`}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      height: "100%",
                      cursor: "default",
                    }}
                  >
                    <div
                      style={{
                        height: `${(d.activeUsers / maxActive) * 100}%`,
                        background: GREEN,
                        borderRadius: "4px 4px 0 0",
                        position: "relative",
                        minHeight: d.activeUsers > 0 ? 2 : 0,
                      }}
                    >
                      {/* Noví sú podmnožinou aktívnych — svetlejší pás naspodku. */}
                      <div
                        style={{
                          position: "absolute",
                          bottom: 0,
                          left: 0,
                          right: 0,
                          height: `${d.activeUsers > 0 ? (d.newUsers / d.activeUsers) * 100 : 0}%`,
                          background: GREEN_BRIGHT,
                          borderRadius: "0 0 0 0",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 20, fontSize: 12, color: MUTED }}>
                <Legend color={GREEN} label="aktívni" />
                <Legend color={GREEN_BRIGHT} label="z toho noví" />
              </div>
            </>
          )}
        </Card>

        {/* Tabuľka */}
        <Card title="Po dňoch">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: "right" }}>
                  <Th align="left">Dátum</Th>
                  <Th>Aktívni</Th>
                  <Th>Noví</Th>
                  <Th>Impresie</Th>
                  <Th>Príjem</Th>
                  <Th>eCPM</Th>
                  <Th>CTR</Th>
                </tr>
              </thead>
              <tbody>
                {(data?.days ?? [])
                  .slice()
                  .reverse()
                  .map((d) => (
                    <tr key={d.date} style={{ borderTop: `1px solid ${BORDER}` }}>
                      <Td align="left">{shortDate(d.date)}</Td>
                      <Td>{fmt(d.activeUsers)}</Td>
                      <Td strong={d.newUsers > 0}>{fmt(d.newUsers)}</Td>
                      <Td>{d.impressions ? fmt(d.impressions) : "–"}</Td>
                      <Td>{d.revenue ? `$${fmt(d.revenue, 2)}` : "–"}</Td>
                      <Td>{d.ecpm ? `$${fmt(d.ecpm, 2)}` : "–"}</Td>
                      <Td
                        // CTR nad 2 % je podozrivé — pri reálnej prevádzke
                        // je to cesta k banu, nech to bije do očí.
                        color={d.ctr > 2 ? "#E0A060" : undefined}
                      >
                        {d.ctr ? `${fmt(d.ctr, 2)} %` : "–"}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>

        {(data?.warnings ?? []).length > 0 && (
          <div style={{ marginTop: 20, fontSize: 13, color: MUTED }}>
            {data!.warnings.map((w, i) => (
              <div key={i} style={{ marginTop: 4 }}>
                • {w}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  noteColor,
}: {
  label: string;
  value: string;
  note: string;
  noteColor?: string;
}) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        padding: "18px 20px",
      }}
    >
      <div style={{ color: MUTED, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, margin: "8px 0 4px" }}>{value}</div>
      <div style={{ fontSize: 12, color: noteColor ?? MUTED }}>{note}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        padding: "20px 22px",
        marginBottom: 20,
      }}
    >
      <h2 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: INK }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span
        style={{ width: 10, height: 10, borderRadius: 3, background: color, display: "inline-block" }}
      />
      {label}
    </span>
  );
}

function Th({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{ textAlign: align, padding: "8px 10px", fontWeight: 500, fontSize: 12 }}>
      {children}
    </th>
  );
}

function Td({
  children,
  align = "right",
  strong,
  color,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  strong?: boolean;
  color?: string;
}) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "9px 10px",
        fontWeight: strong ? 600 : 400,
        color: color ?? INK,
      }}
    >
      {children}
    </td>
  );
}
