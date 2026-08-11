import raw from "./top10.json";
import rawDaily from "./daily.json";

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
  /** 기간 내 거래대금 합계 (원) — 거래소가 공시한 실제 집계값 */
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

/** 종목 상세 페이지용 하루치 시세 — 캔들 하나에 대응한다. */
export interface DayBar {
  /** "20260810" */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 전일 대비 등락폭(원)·등락률(%). 거래소가 공시한 값 그대로. */
  change: number;
  changeRate: number;
  volume: number;
  value: number;
}

export interface StockSeries {
  code: string;
  name: string;
  market: Market;
  kind: Kind;
  /** 날짜 오름차순. 가장 마지막이 기준일이다. */
  days: DayBar[];
}

export interface DomesticDaily {
  generatedAt: string;
  window: { from: string; to: string; tradingDays: number };
  /** 기간 내 영업일 달력 — 차트 x축을 종목과 무관하게 고정하는 데 쓴다. */
  dates: string[];
  series: Record<string, StockSeries>;
}

/**
 * top10.json·daily.json은 `npm run collect:domestic`이 만드는 생성물이다. 손으로 고치지 않는다.
 * JSON을 import하면 TypeScript가 문자열 리터럴을 넓은 string으로 추론하기 때문에
 * market·kind 유니온을 붙이려면 한 번 거쳐 캐스팅해야 한다.
 */
export const top10 = raw as unknown as DomesticTop10;
export const daily = rawDaily as unknown as DomesticDaily;

/**
 * 순위표에서 종목명에 링크를 걸기 전에 확인한다. 두 JSON은 항상 같은 실행에서
 * 함께 갱신되지만, 어긋난 상태로 커밋되더라도 404 링크가 생기지는 않게 한다.
 */
export function hasDetailPage(code: string): boolean {
  return code in daily.series;
}

export function getSeries(code: string): StockSeries | undefined {
  return daily.series[code];
}

/**
 * 매도할 때만 붙는 세금. 2026년 1월 1일 개정 세율 기준.
 *   코스피   증권거래세 0.05% + 농어촌특별세 0.15% = 0.20%
 *   코스닥   증권거래세 0.20% (농특세 없음)        = 0.20%
 *   ETF·ETN  증권거래세 면제                      = 0%
 * 세법이 바뀌면 이 값만 고치면 페이지 전체가 따라온다.
 */
export const SELL_TAX_RATE: Record<Kind, number> = { 주식: 0.002, ETF: 0, ETN: 0 };

export interface TradeCost {
  /** 한 주를 살 때 내는 돈 — 매수에는 세금이 없다 */
  buy: number;
  /** 매도 시 떼는 증권거래세 (1주 기준, 원 미만 절사) */
  tax: number;
  /** 한 주를 팔면 실제로 받는 돈 */
  sell: number;
  rate: number;
}

/** 사자마자 되팔면 얼마가 남는지 — 초보자가 가장 자주 놓치는 계산이다. */
export function tradeCost(price: number, kind: Kind): TradeCost {
  const rate = SELL_TAX_RATE[kind];
  const tax = Math.floor(price * rate);
  return { buy: price, tax, sell: price - tax, rate };
}

/** 기간 첫 종가 대비 마지막 종가 */
export function periodChange(days: DayBar[]): { diff: number; rate: number } {
  if (days.length < 2) return { diff: 0, rate: 0 };
  const first = days[0].close;
  const last = days[days.length - 1].close;
  return { diff: last - first, rate: first === 0 ? 0 : ((last - first) / first) * 100 };
}

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

/** "20260810" → "08-10" — 차트 축과 좁은 표에서 쓴다 */
export function shortDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 500 → "+500" · -46 → "-46" · 0 → "0" */
export function formatSigned(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString(KO)}`;
}

/** 0.22 → "+0.22%" · -4.16 → "-4.16%" */
export function formatSignedPercent(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** 등락 방향 — 색상 클래스(up/down/flat)를 고르는 데 쓴다 */
export function direction(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

/** 표에 마우스를 올렸을 때 보여줄 정확한 원 숫자 */
export function exact(n: number, unit: string): string {
  return `${n.toLocaleString(KO)}${unit}`;
}
