import type { GameDate, NewsItem } from "@dopamine/engine";

export const money = (v: number) =>
  "$" + (v >= 1000 ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(v < 1 ? 4 : 2));
export const big = (v: number | null) =>
  v == null ? "-" : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(0)}M`;
export const pct = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
export const change = (price: number, prev: number) => (price / prev - 1) * 100;
export const dateText = (d: GameDate) => (d.year ? `${d.year}년차 ${d.month}월 ${d.day}일` : "시즌 준비 중");
export const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 5);

export const badgeText = (n: NewsItem) => (n.event ? `${n.kind} ${n.event.index + 1}/${n.event.total} · ${n.event.label}` : n.kind);
export const badgeClass = (n: NewsItem) => ["badge", n.event ? "warn" : n.kind === "잡담" ? "muted-badge" : ""];
