import raw from "./top10.json";

export type Market = "KOSPI" | "KOSDAQ";
export type Kind = "주식" | "ETF" | "ETN";

export interface VolumeRow {
  rank: number;
  code: string;
  name: string;
  market: Market;
  /** 개별 기업 주식인지, 여러 종목을 묶은 상품(ETF·ETN)인지 */
  kind: Kind;
  /** 기간 내 일별 거래량 합계 (주) — 정확값 */
  volume: number;
  /** 기간 내 Σ(종가 × 거래량) (원) — 종가 기준 추정값 */
  value: number;
  /** 기간 마지막 영업일 종가 (원) */
  lastClose: number;
}

export interface DomesticTop10 {
  generatedAt: string;
  window: { from: string; to: string; tradingDays: number };
  /** ETF·ETN을 제외한 개별 종목 TOP10 */
  stocks: VolumeRow[];
  /** ETF·ETN을 포함한 전체 TOP10 */
  all: VolumeRow[];
}

/**
 * top10.json은 `npm run collect:domestic`이 만드는 생성물이다. 손으로 고치지 않는다.
 * JSON을 import하면 TypeScript가 문자열 리터럴을 넓은 string으로 추론하기 때문에
 * market·kind 유니온을 붙이려면 한 번 거쳐 캐스팅해야 한다.
 */
export const top10 = raw as unknown as DomesticTop10;

const KO = "ko-KR";

/** 634076580 → "6.3억" · 206049121452 → "2,060.5억" */
export function formatVolume(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toLocaleString(KO, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}억`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString(KO)}만`;
  return n.toLocaleString(KO);
}

/** 154263400725500 → "154.3조" · 189380619862 → "1,894억" */
export function formatValue(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toLocaleString(KO, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조`;
  if (n >= 1e8) return `${Math.round(n / 1e8).toLocaleString(KO)}억`;
  return `${Math.round(n / 1e4).toLocaleString(KO)}만`;
}

/** 230000 → "230,000" */
export function formatPrice(n: number): string {
  return n.toLocaleString(KO);
}

/** "20260810" → "2026-08-10" */
export function formatDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 표에 마우스를 올렸을 때 보여줄 정확한 원 숫자 */
export function exact(n: number, unit: string): string {
  return `${n.toLocaleString(KO)}${unit}`;
}
