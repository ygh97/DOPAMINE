// 개미 계급(10단계)과 순위 테두리 (2026-10-24, SPEC 계급·LP). 서버(LP 정산)와 화면(배지·닉네임 색·전광판)이 같이 쓴다.
// LP는 매일 시즌 마감 때 사람끼리의 순위로 오르내리고, 시즌이 바뀌어도 남는다.

export interface AntTier {
  tier: number;
  id: string;
  name: string;
  /** 이 계급이 되는 누적 LP */
  minLp: number;
  /** 51위 밖·손실로 마감한 날 바뀌는 LP (0 또는 음수) */
  deduction: number;
  /** 비활동이 이 날수 이상 이어지면 그날부터 idlePenalty씩 깎는다 (0이면 휴면 감점 없음) */
  idleDays: number;
  idlePenalty: number;
  color: string;
  /** 닉네임을 계급 색으로 칠한다 */
  nameColor: boolean;
  /** 채팅 말풍선 강조: 테두리(border) 또는 배경(fill) */
  bubble: "" | "border" | "fill";
  /** 접속하면 전광판에 계급 색으로 알린다 (시즌에 한 번) */
  entryBanner: boolean;
}

export const ANT_TIERS: readonly AntTier[] = [
  { tier: 1, id: "egg", name: "알개미", minLp: 0, deduction: 0, idleDays: 0, idlePenalty: 0, color: "#e2e8f0", nameColor: false, bubble: "", entryBanner: false },
  { tier: 2, id: "larva", name: "애벌레개미", minLp: 50, deduction: 0, idleDays: 0, idlePenalty: 0, color: "#93c5fd", nameColor: false, bubble: "", entryBanner: false },
  { tier: 3, id: "baby", name: "아기개미", minLp: 120, deduction: 0, idleDays: 0, idlePenalty: 0, color: "#cbd5e1", nameColor: false, bubble: "", entryBanner: false },
  { tier: 4, id: "worker", name: "일개미", minLp: 220, deduction: -10, idleDays: 0, idlePenalty: 0, color: "#d97706", nameColor: false, bubble: "", entryBanner: false },
  { tier: 5, id: "scout", name: "정찰개미", minLp: 350, deduction: -15, idleDays: 0, idlePenalty: 0, color: "#38bdf8", nameColor: false, bubble: "", entryBanner: false },
  { tier: 6, id: "soldier", name: "병정개미", minLp: 500, deduction: -20, idleDays: 0, idlePenalty: 0, color: "#94a3b8", nameColor: false, bubble: "", entryBanner: false },
  { tier: 7, id: "venom", name: "독침개미", minLp: 700, deduction: -25, idleDays: 3, idlePenalty: -15, color: "#4ade80", nameColor: true, bubble: "", entryBanner: false },
  { tier: 8, id: "fire", name: "불개미", minLp: 950, deduction: -30, idleDays: 3, idlePenalty: -20, color: "#f97316", nameColor: true, bubble: "border", entryBanner: true },
  { tier: 9, id: "commander", name: "군단장개미", minLp: 1250, deduction: -35, idleDays: 3, idlePenalty: -25, color: "#c084fc", nameColor: true, bubble: "fill", entryBanner: true },
  { tier: 10, id: "queen", name: "황금여왕개미", minLp: 1600, deduction: -45, idleDays: 2, idlePenalty: -35, color: "#facc15", nameColor: true, bubble: "fill", entryBanner: true },
];

/** 강등 보호선: 한 번 넘으면 그 아래로 내려가지 않는다 (애벌레 50, 아기 120) */
export const LP_FLOORS = [50, 120] as const;

export function tierOf(lp: number): AntTier {
  for (let i = ANT_TIERS.length - 1; i >= 0; i--) if (lp >= ANT_TIERS[i].minLp) return ANT_TIERS[i];
  return ANT_TIERS[0];
}

/** 사람끼리 순위 → 마감 LP (수익 마감일 때만). 50위 밖은 0 */
export function rankLp(rank: number): number {
  if (rank === 1) return 120;
  if (rank === 2) return 95;
  if (rank === 3) return 75;
  if (rank <= 10) return 50;
  if (rank <= 30) return 25;
  if (rank <= 50) return 10;
  return 0;
}
/** 100배 전설로 마감하면 더 받는다 */
export const LEGEND_LP = 40;

export type RankFrame = "rank1" | "rank2" | "rank3" | "gold" | "silver" | "bronze" | "none";
/** 실시간 순위 테두리: 사람끼리 50위 안이고 원금($100,000)을 넘었을 때만 */
export function frameOf(rank: number | null | undefined, equity: number, start = 100_000): RankFrame {
  if (!rank || rank <= 0 || rank > 50 || !(equity > start)) return "none";
  if (rank <= 3) return `rank${rank}` as RankFrame;
  if (rank <= 10) return "gold";
  if (rank <= 30) return "silver";
  return "bronze";
}
