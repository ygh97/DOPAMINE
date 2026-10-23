// 개미 계급 LP 정산 (2026-10-24, SPEC 계급·LP). 매일 시즌 마감 때 한 번, 사람끼리의 순위로 LP가 오르내린다.
// 계급표·순위별 LP는 @dopamine/engine의 ranks.ts (화면과 같이 쓴다).
import { LEGEND_LP, LP_FLOORS, rankLp, tierOf } from "@dopamine/engine";
import { START_CASH, type RankRow } from "./broker.ts";
import type { Db } from "./db.ts";

/** 활동한 날: 그날 거래대금이 첫 체결 때 자산의 이 비율 이상 */
const ACTIVE_TURNOVER = 0.1;

/**
 * 사람 계정끼리의 순위 (봇·세력·고래 제외). 총자산이 같으면 같은 순위 = 둘 다 높은 순위 (1, 1, 3 ...).
 * ranking은 Broker.ranking() 그대로 (총자산 순)
 */
export function peopleRanks(ranking: RankRow[]): { name: string; rank: number; equity: number; legend: boolean }[] {
  const out: { name: string; rank: number; equity: number; legend: boolean }[] = [];
  let rank = 0, prev = NaN;
  for (const r of ranking) {
    if (r.kind !== "user") continue;
    const cents = Math.round(r.equity * 100);
    if (cents !== prev) { rank = out.length + 1; prev = cents; }
    out.push({ name: r.name, rank, equity: r.equity, legend: r.clearedTick != null });
  }
  return out;
}

/** 실시간 순위 테두리용: 사람끼리 50위 안이고 원금을 넘은 사람의 순위 (이름 → 순위) */
export function liveFrames(ranking: RankRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of peopleRanks(ranking)) if (p.rank <= 50 && p.equity > START_CASH) out[p.name] = p.rank;
  return out;
}

interface Activity { user_id: number; base_equity: number | null; turnover: number; peak_trade: number; late_reset: number }
interface UserLp { id: number; name: string; lp: number; lp_floor: number; idle_seasons: number }

/**
 * 시즌 LP 정산. 시즌마다 한 번만 (lp_log에 기록이 있으면 넘어간다). finishSeason의 트랜잭션 안에서 부른다.
 * - 수익 마감(원금 초과)이고 사람끼리 50위 안: 순위별 + LP, 100배 전설이면 +40
 * - 그 밖(51위 밖·손실·마감 1시간 안 다시 시작): 활동한 날만 계급별 감점. 마감 4시간 안에 체결했으면 절반 (0 쪽으로 버림)
 * - 활동 안 한 날: 감점 없음. 휴면 감점이 있는 계급(7단계~)은 비활동이 이어진 날수가 기준을 넘으면 그날부터 깎는다
 * - 강등 보호선(50·120)을 한 번 넘으면 그 아래로 내려가지 않는다
 */
export function settleLp(db: Db, seasonId: number, ranking: RankRow[]) {
  if (db.prepare("SELECT 1 FROM lp_log WHERE season_id = ? LIMIT 1").get(seasonId)) return;
  const played = new Map(peopleRanks(ranking).map(p => [p.name.toLowerCase(), p]));
  const acts = new Map((db.prepare("SELECT user_id, base_equity, turnover, peak_trade, late_reset FROM accounts WHERE season_id = ?").all(seasonId) as unknown as Activity[]).map(a => [a.user_id, a]));
  const users = db.prepare("SELECT id, name, lp, lp_floor, idle_seasons FROM users WHERE kind = 'user'").all() as unknown as UserLp[];
  const upd = db.prepare("UPDATE users SET lp = ?, lp_floor = ?, idle_seasons = ?, last_equity = COALESCE(?, last_equity) WHERE id = ?");
  const log = db.prepare("INSERT OR IGNORE INTO lp_log (season_id, user_id, rank, equity, delta, lp, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const u of users) {
    const p = played.get(u.name.toLowerCase()), a = acts.get(u.id), tier = tierOf(u.lp);
    const active = !!a && a.base_equity != null && a.turnover >= ACTIVE_TURNOVER * a.base_equity;
    const late = !!a?.late_reset;
    let delta = 0, reason = p ? "out" : "absent";
    const gain = p && !late && p.equity > START_CASH ? rankLp(p.rank) : 0;
    if (gain > 0) { delta = gain + (p!.legend ? LEGEND_LP : 0); reason = "rank"; }
    else if (p && (active || late)) {
      delta = a!.peak_trade ? Math.trunc(tier.deduction / 2) : tier.deduction;
      reason = late ? "late-reset" : p.equity > START_CASH ? "out" : "loss";
    }
    const idle = active || gain > 0 ? 0 : u.idle_seasons + 1;
    if (!active && gain === 0 && !late && tier.idleDays && idle >= tier.idleDays) { delta += tier.idlePenalty; reason = "dormant"; }
    const lp = Math.max(0, u.lp_floor, u.lp + delta);
    const floor = Math.max(u.lp_floor, ...LP_FLOORS.filter(f => lp >= f));
    upd.run(lp, floor, idle, p ? p.equity : null, u.id);
    if (p || lp !== u.lp) log.run(seasonId, u.id, p?.rank ?? null, p?.equity ?? null, lp - u.lp, lp, reason);
  }
}

/** 이름별 LP (화면 배지용, 사람만) */
export function lpByName(db: Db): Map<string, number> {
  return new Map((db.prepare("SELECT name, lp FROM users WHERE kind = 'user'").all() as { name: string; lp: number }[]).map(r => [r.name, r.lp]));
}
