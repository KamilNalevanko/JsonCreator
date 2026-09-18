"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Farby podľa appky (lib/ui_constants.dart), tmavý režim.
const GREEN = "#739B7B"; // darkPrimary — vracajúci sa
const GREEN_BRIGHT = "#53B175"; // lightMainGreen — noví
const GREEN_HOVER = "#8FB897";
const GREEN_BRIGHT_HOVER = "#6CC98D";
const BG = "#0F1412";
const CARD = "#18201C";
const BORDER = "#26312B";
const INK = "#E8EFEA";
const MUTED = "#8FA398";

type Day = {
  date: string;
  activeUsers: number;
  newUsers: number;
  returningUsers: number;
  avgSeconds: number;
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
    /** Unikátni ľudia za obdobie. null = GA4 súhrn zlyhal. */
    users: number | null;
    newUsers: number | null;
    returningUsers: number | null;
    avgActiveUsers: number;
    avgSeconds: number;
    impressions: number;
    revenue: number;
    platforms: { platform: string; users: number; newUsers: number }[];
  };
  warnings: string[];
};

const fmt = (n: number, digits = 0) =>
  n.toLocaleString("sk-SK", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** Sekundy na „4 min 25 s" — zákazník chce vidieť čas, nie číslo. */
const dur = (seconds: number) => {
  if (!seconds || seconds < 1) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
};

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.`;
};

const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString("sk-SK", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

// Miestny čas, nie `toISOString()` — ten prepína do UTC a tesne po polnoci
// by vrátil predvčerajšok (rovnaká chyba ako bola v API).
const yesterdayIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

export default function PrehladPage() {
  const [days, setDays] = useState(28);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [custom, setCustom] = useState(false);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<number | null>(null);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/prehlad?${query}`, { cache: "no-store" });
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

  // Vlastné obdobie sa načíta až po kliknutí na „Zobraziť", nech sa nesťahuje
  // pri každom ťuknutí do dátumu.
  useEffect(() => {
    if (!custom) void load(`days=${days}`);
  }, [days, custom, load]);

  const trend = useMemo(() => {
    if (!data || data.days.length < 14) return null;
    const sum = (rows: Day[]) => rows.reduce((a, d) => a + d.newUsers, 0);
    const now = sum(data.days.slice(-7));
    const before = sum(data.days.slice(-14, -7));
    if (before === 0) return null;
    return Math.round(((now - before) / before) * 100);
  }, [data]);

  const maxActive = useMemo(
    () => Math.max(1, ...(data?.days ?? []).map((d) => d.activeUsers)),
    [data],
  );

  const shown = data?.days ?? [];

  return (
    <div style={{ background: BG, minHeight: "100vh", color: INK }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 24px 64px" }}>
        <a
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            color: MUTED,
            fontSize: 14,
            textDecoration: "none",
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            padding: "7px 14px",
            marginBottom: 20,
          }}
        >
          ← Späť do editora
        </a>

        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>
              Prehľad <span style={{ color: GREEN_BRIGHT }}>CAP</span>
            </h1>
            <p style={{ margin: "6px 0 0", color: MUTED, fontSize: 14 }}>
              {loading ? "Načítavam…" : data ? `${data.from} — ${data.to}` : "—"}
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              alignItems: "flex-end",
            }}
          >
            <div style={{ display: "flex", gap: 8 }}>
              {[1, 7, 28, 90].map((r) => {
                const active = !custom && r === days;
                return (
                  <button
                    key={r}
                    disabled={loading}
                    onClick={() => {
                      setCustom(false);
                      setDays(r);
                    }}
                    style={{
                      background: active ? GREEN : "transparent",
                      color: active ? "#0F1412" : MUTED,
                      border: `1px solid ${active ? GREEN : BORDER}`,
                      borderRadius: 10,
                      padding: "8px 16px",
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: loading ? "wait" : "pointer",
                      opacity: loading && !active ? 0.5 : 1,
                      transition: "background 0.15s, color 0.15s",
                    }}
                  >
                    {r === 1 ? "Včera" : `${r} dní`}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="date"
                value={customFrom}
                max={customTo || yesterdayIso()}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={dateInput}
              />
              <span style={{ color: MUTED, fontSize: 13 }}>–</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                max={yesterdayIso()}
                onChange={(e) => setCustomTo(e.target.value)}
                style={dateInput}
              />
              <button
                disabled={loading || !customFrom || !customTo}
                onClick={() => {
                  setCustom(true);
                  void load(`from=${customFrom}&to=${customTo}`);
                }}
                style={{
                  background: custom ? GREEN : "transparent",
                  color: custom ? "#0F1412" : MUTED,
                  border: `1px solid ${custom ? GREEN : BORDER}`,
                  borderRadius: 10,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: !customFrom || !customTo || loading ? "not-allowed" : "pointer",
                  opacity: !customFrom || !customTo ? 0.45 : 1,
                }}
              >
                Zobraziť
              </button>
            </div>
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

        {/* Kým sa načítava, obsah sa stlmí a prekryje — inak by tam svietili
            staré čísla a vyzeralo by to, že sa nič nestalo. */}
        <div style={{ position: "relative" }}>
          {loading && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 5,
                background: "rgba(15,20,18,0.72)",
                borderRadius: 16,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: 90,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Spinner />
                <span style={{ color: INK, fontSize: 15, fontWeight: 600 }}>
                  Načítavam údaje…
                </span>
              </div>
            </div>
          )}

          <div
            style={{
              opacity: loading ? 0.3 : 1,
              transition: "opacity 0.2s",
              pointerEvents: loading ? "none" : "auto",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 16,
                marginBottom: 28,
              }}
            >
              <Stat
                label="Ľudia za obdobie"
                value={data?.totals.users != null ? fmt(data.totals.users) : "—"}
                note="unikátni — každý človek sa počíta raz"
              />
              <Stat
                label="Noví používatelia"
                value={data?.totals.newUsers != null ? fmt(data.totals.newUsers) : "—"}
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
                label="Čas v appke"
                value={data ? dur(data.totals.avgSeconds) : "—"}
                note="priemer na jedného používateľa za deň"
              />
              <Stat
                label="Vracajúci sa"
                value={
                  data?.totals.returningUsers != null
                    ? fmt(data.totals.returningUsers)
                    : "—"
                }
                note="ľudia, čo appku poznali už pred týmto obdobím"
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

            {(data?.totals.platforms ?? []).length > 0 && (
              <Card title="Podľa platformy">
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {data!.totals.platforms.map((p) => {
                    const share = data!.totals.users
                      ? (p.users / data!.totals.users) * 100
                      : 0;
                    return (
                      <div key={p.platform}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 14,
                            marginBottom: 6,
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>{p.platform}</span>
                          <span style={{ color: MUTED }}>
                            <span style={{ color: INK, fontWeight: 600 }}>
                              {fmt(p.users)}
                            </span>{" "}
                            ľudí · {fmt(p.newUsers)} nových · {fmt(share)} %
                          </span>
                        </div>
                        <div
                          style={{
                            height: 8,
                            background: BORDER,
                            borderRadius: 4,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${share}%`,
                              height: "100%",
                              background: p.platform === "iOS" ? GREEN : GREEN_BRIGHT,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <Card title="Používatelia po dňoch">
              <div style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-end",
                    gap: 3,
                    height: 190,
                    marginBottom: 10,
                  }}
                >
                  {shown.map((d, i) => {
                    const on = hover === i;
                    const newShare =
                      d.activeUsers > 0 ? (d.newUsers / d.activeUsers) * 100 : 0;
                    return (
                      <div
                        key={d.date}
                        onMouseEnter={() => setHover(i)}
                        style={{
                          flex: 1,
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "flex-end",
                          height: "100%",
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            height: `${(d.activeUsers / maxActive) * 100}%`,
                            minHeight: d.activeUsers > 0 ? 3 : 0,
                            background: on ? GREEN_HOVER : GREEN,
                            borderRadius: "5px 5px 0 0",
                            position: "relative",
                            // Jemné zdvihnutie a zvýraznenie pri ukázaní myšou.
                            transform: on ? "scaleY(1.05)" : "none",
                            transformOrigin: "bottom",
                            boxShadow: on ? `0 0 0 1px ${GREEN_BRIGHT_HOVER}` : "none",
                            transition:
                              "background 0.12s, transform 0.12s, box-shadow 0.12s",
                          }}
                        >
                          <div
                            style={{
                              position: "absolute",
                              bottom: 0,
                              left: 0,
                              right: 0,
                              height: `${newShare}%`,
                              background: on ? GREEN_BRIGHT_HOVER : GREEN_BRIGHT,
                              borderRadius: newShare >= 99 ? "5px 5px 0 0" : "0",
                              transition: "background 0.12s",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {hover !== null && shown[hover] && (
                  <Tooltip day={shown[hover]} index={hover} total={shown.length} />
                )}

                <div style={{ display: "flex", gap: 20, fontSize: 12, color: MUTED }}>
                  <Legend color={GREEN} label="vracajúci sa" />
                  <Legend color={GREEN_BRIGHT} label="noví" />
                </div>
              </div>
            </Card>

            <Card title="Po dňoch">
              <p style={{ margin: "-6px 0 14px", color: MUTED, fontSize: 12 }}>
                Čísla sú za každý deň zvlášť. Nesčítavaj ich — kto appku otvorí
                päť dní, je tu päťkrát, ale je to jeden človek.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ color: MUTED, textAlign: "right" }}>
                      <Th align="left">Dátum</Th>
                      <Th>Spolu</Th>
                      <Th>Noví</Th>
                      <Th>Vracajúci</Th>
                      <Th>Čas</Th>
                      <Th>Impresie</Th>
                      <Th>Príjem</Th>
                      <Th>eCPM</Th>
                      <Th>CTR</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown
                      .slice()
                      .reverse()
                      .map((d) => (
                        <tr key={d.date} style={{ borderTop: `1px solid ${BORDER}` }}>
                          <Td align="left">{shortDate(d.date)}</Td>
                          <Td>{fmt(d.activeUsers)}</Td>
                          <Td strong={d.newUsers > 0}>{fmt(d.newUsers)}</Td>
                          <Td>{fmt(d.returningUsers)}</Td>
                          <Td>{dur(d.avgSeconds)}</Td>
                          <Td>{d.impressions ? fmt(d.impressions) : "–"}</Td>
                          <Td>{d.revenue ? `$${fmt(d.revenue, 2)}` : "–"}</Td>
                          <Td>{d.ecpm ? `$${fmt(d.ecpm, 2)}` : "–"}</Td>
                          <Td color={d.ctr > 2 ? "#E0A060" : undefined}>
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
      </div>
    </div>
  );
}

const dateInput: React.CSSProperties = {
  background: CARD,
  color: INK,
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  padding: "7px 10px",
  fontSize: 13,
  colorScheme: "dark",
};

/** Bublina nad stĺpcom. Drží sa v šírke grafu, nech neutečie za okraj. */
function Tooltip({ day, index, total }: { day: Day; index: number; total: number }) {
  const pct = ((index + 0.5) / total) * 100;
  const nearLeft = pct < 18;
  const nearRight = pct > 82;
  return (
    <div
      style={{
        position: "absolute",
        left: `${pct}%`,
        bottom: 34,
        transform: `translateX(${nearLeft ? "-8%" : nearRight ? "-92%" : "-50%"})`,
        background: "#111917",
        border: `1px solid ${GREEN}`,
        borderRadius: 14,
        padding: "14px 16px",
        minWidth: 200,
        boxShadow: "0 12px 34px rgba(0,0,0,0.6)",
        pointerEvents: "none",
        zIndex: 3,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: GREEN_BRIGHT,
          marginBottom: 10,
          textTransform: "capitalize",
        }}
      >
        {longDate(day.date)}
      </div>
      <Row label="Spolu" value={fmt(day.activeUsers)} big />
      <Row label="Noví" value={fmt(day.newUsers)} dot={GREEN_BRIGHT} />
      <Row label="Vracajúci sa" value={fmt(day.returningUsers)} dot={GREEN} />
      <Row label="Čas v appke" value={dur(day.avgSeconds)} />
      {day.impressions > 0 && <Row label="Impresie" value={fmt(day.impressions)} />}
    </div>
  );
}

function Row({
  label,
  value,
  dot,
  big,
}: {
  label: string;
  value: string;
  dot?: string;
  big?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 18,
        marginTop: big ? 0 : 5,
      }}
    >
      <span
        style={{ color: MUTED, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
      >
        {dot && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 3,
              background: dot,
              display: "inline-block",
            }}
          />
        )}
        {label}
      </span>
      <span style={{ color: INK, fontSize: big ? 18 : 13, fontWeight: big ? 700 : 600 }}>
        {value}
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes cap-spin { to { transform: rotate(360deg) } }`}</style>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          border: `2.5px solid ${BORDER}`,
          borderTopColor: GREEN_BRIGHT,
          display: "inline-block",
          animation: "cap-spin 0.7s linear infinite",
        }}
      />
    </>
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
      <div
        style={{ color: MUTED, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}
      >
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
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: color,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

function Th({
  children,
  align = "right",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
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
