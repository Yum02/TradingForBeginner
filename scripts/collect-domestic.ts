/**
 * 국내 주식 — 최근 1개월 누적 거래량 TOP10 수집기 (KRX Open API)
 *
 *   실행: npm run collect:domestic
 *   결과: src/data/domestic/top10.json  (순위표)      ← 둘 다 git에 커밋됨
 *         src/data/domestic/daily.json  (종목 상세용 일별 시세)
 *
 * 두 파일은 반드시 같은 실행에서 함께 갱신된다. 순위표에만 있고 시계열에는 없는
 * 종목이 생기면 상세 페이지 링크가 깨지기 때문이다.
 *
 * 수집은 두 단계다. 창(window)이 서로 다르기 때문이다.
 *   1단계  최근 1개월 × 전 종목  → 누적 거래량 순위(TOP10)와 차트용 일별 시세
 *   2단계  그 이전 5개월 × TOP10 종목만 → 기술적 지표 계산용 과거 시세
 * 순위는 "최근 1개월 거래량"이라는 정의를 지켜야 하므로 1단계 창에서만 집계하고,
 * 60일 이동평균·MACD처럼 긴 과거가 필요한 지표 때문에 시세만 6개월로 늘린다.
 * 2단계는 순위가 정해진 뒤에야 어떤 종목이 필요한지 알 수 있어 순서를 바꿀 수 없다.
 *
 * 이 스크립트는 로컬에서 수동으로만 실행한다. 사이트 빌드는 이 스크립트를 호출하지
 * 않으며 커밋된 JSON만 읽는다. 덕분에 Cloudflare 배포가 외부 API 상태와 무관하다.
 *
 * 인증키:
 *   저장소 루트 .env 에 KRX_AUTH_KEY=... 형태로 넣어둔다(.gitignore 등록되어 있음).
 *   https://openapi.krx.co.kr 에서 회원가입 후 인증키를 발급받고,
 *   추가로 아래 4개 서비스에 대해 "API 활용 신청"을 넣어 승인을 받아야 한다.
 *   인증키만 있고 서비스 승인이 없으면 401 "Unauthorized API Call"이 돌아온다.
 *
 * 데이터 지연:
 *   KRX는 당일 데이터를 즉시 공개하지 않는다(약 1영업일 지연). 그래서 오늘부터
 *   거꾸로 훑어 실제로 데이터가 있는 가장 최근 영업일을 기준일로 잡는다.
 *
 * Node 22.18+ 또는 24+ 필요 (타입 스트리핑으로 .ts를 직접 실행).
 * 타입 스트리핑은 지울 수 있는 문법만 허용한다 — enum, namespace,
 * 생성자 파라미터 프로퍼티를 쓰면 안 된다.
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = path.join(ROOT, "src", "data", "domestic", "top10.json");
const DAILY_FILE = path.join(ROOT, "src", "data", "domestic", "daily.json");
const CACHE_DIR = path.join(ROOT, ".cache");

const API_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const CONCURRENCY = 5;
const MAX_RETRIES = 3;
const TOP_N = 10;
/** 최신 영업일을 찾을 때 오늘부터 거꾸로 최대 며칠까지 훑을지 (연휴 대비) */
const LOOKBACK_DAYS = 14;

/**
 * 기술적 지표용 시세를 몇 개월치 모을지. 60일 이동평균과 MACD(26일 EMA + 9일 시그널)를
 * 계산하려면 최소 90영업일쯤이 필요하고, 골든크로스가 "최근에" 일어났는지 보려면
 * 지표값 자체도 여러 날 이어져야 한다. 6개월(약 120영업일)이면 둘 다 여유 있게 된다.
 */
const HISTORY_MONTHS = 6;

/** 검증 기준: 이보다 못 미치면 기존 JSON을 건드리지 않고 실패시킨다. */
const MIN_TRADING_DAYS = 15;
/**
 * 1개월 창에 영업일이 25일을 넘을 수는 없다. 이 상한이 깨진다면 휴장일을
 * 영업일로 세고 있다는 뜻이므로 조용히 넘어가지 말고 실패시킨다.
 */
const MAX_TRADING_DAYS = 25;
/** 6개월이면 영업일이 대략 118~125일이다. 상·하한을 넉넉히 잡되 벗어나면 실패시킨다. */
const MIN_HISTORY_DAYS = 100;
const MAX_HISTORY_DAYS = 135;

type Market = "KOSPI" | "KOSDAQ";
type Kind = "주식" | "ETF" | "ETN";

interface Source {
  endpoint: string;
  kind: Kind;
  /**
   * ETF·ETN 응답에는 MKT_NM 필드가 아예 없다. 국내 ETF·ETN은 전부
   * 유가증권시장(KOSPI)에 상장되므로 그 값으로 채운다.
   */
  market: Market | null;
  label: string;
  /**
   * "이 상품 한 장의 진짜 값어치"가 담긴 필드 이름. ETF는 순자산가치(NAV),
   * ETN은 증권당 지표가치라 이름이 다르다. 개별 주식에는 그런 값이 없다
   * (그 자리를 PER·PBR이 대신하며, 그쪽은 DART에서 따로 받는다).
   */
  navField: "NAV" | "PER1SECU_INDIC_VAL" | null;
}

const SOURCES: Source[] = [
  { endpoint: "sto/stk_bydd_trd", kind: "주식", market: null, label: "유가증권", navField: null },
  { endpoint: "sto/ksq_bydd_trd", kind: "주식", market: null, label: "코스닥", navField: null },
  { endpoint: "etp/etf_bydd_trd", kind: "ETF", market: "KOSPI", label: "ETF", navField: "NAV" },
  { endpoint: "etp/etn_bydd_trd", kind: "ETN", market: "KOSPI", label: "ETN", navField: "PER1SECU_INDIC_VAL" },
];

interface KrxRow {
  ISU_CD?: string;
  ISU_NM?: string;
  MKT_NM?: string;
  TDD_CLSPRC?: string;
  TDD_OPNPRC?: string;
  TDD_HGPRC?: string;
  TDD_LWPRC?: string;
  CMPPREVDD_PRC?: string;
  FLUC_RT?: string;
  ACC_TRDVOL?: string;
  ACC_TRDVAL?: string;
  /** 시가총액·상장주식수 — 네 엔드포인트 모두 준다. 우리가 곱하지 않고 그대로 쓴다. */
  MKTCAP?: string;
  LIST_SHRS?: string;
  /** ETF 순자산가치 */
  NAV?: string;
  /** ETN 증권당 지표가치 */
  PER1SECU_INDIC_VAL?: string;
}

/** 하루치 시세 한 줄 — 상세 페이지의 캔들 하나에 대응한다. */
interface DayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 전일 대비 등락폭·등락률. 직접 계산하지 않고 거래소가 준 값을 그대로 쓴다. */
  change: number;
  changeRate: number;
  volume: number;
  value: number;
}

/**
 * 기준일의 규모 정보. 시세와 달리 하루치만 있으면 되고, 거래소가 계산해 준 값을
 * 그대로 쓴다(종가 × 상장주식수를 우리가 직접 곱하면 우선주·자기주식 처리에서 어긋난다).
 */
interface Snapshot {
  /** 상장주식수 (주) */
  listedShares: number;
  /** 시가총액 (원) */
  marketCap: number;
  /** ETF 순자산가치 / ETN 증권당 지표가치 (원). 개별 주식은 0 */
  nav: number;
}

/** daily.json에 실리는 종목 한 개 — 기본 정보 + 기간 내 일별 시세 */
interface StockSeries {
  code: string;
  name: string;
  market: Market;
  kind: Kind;
  listedShares: number;
  marketCap: number;
  nav: number;
  days: DayBar[];
}

interface Top10Row {
  rank: number;
  code: string;
  name: string;
  market: Market;
  kind: Kind;
  volume: number;
  value: number;
  lastClose: number;
}

interface Aggregate extends Snapshot {
  code: string;
  name: string;
  market: Market;
  kind: Kind;
  volume: number;
  value: number;
  lastClose: number;
  lastDate: string;
}

/**
 * 캐시: 기간이 바뀌면 파일명이 달라져 자동으로 미스가 난다.
 * 파일명의 v2는 스키마 버전이다. series가 없던 v1 캐시를 재사용하지 않으려고 올렸다.
 */
interface CacheFile {
  window: { from: string; to: string };
  rows: Record<string, Aggregate>;
  /** 종목코드 → 일별 시세. 병렬 수집이라 날짜 순서가 섞여 있으므로 쓸 때 정렬한다. */
  series: Record<string, DayBar[]>;
  dates: string[];
}

/** 2단계(과거 5개월) 캐시. 필요한 종목만 담기므로 어떤 종목을 담았는지 함께 적어둔다. */
interface HistCacheFile {
  codes: string[];
  series: Record<string, DayBar[]>;
  dates: string[];
}

/**
 * 캐시 스키마 버전은 단계별로 따로 매긴다. 1단계 집계에 항목이 하나 늘었다고 해서
 * 5개월치 과거 시세(450요청)까지 다시 받을 이유는 없기 때문이다.
 */
const RANK_CACHE_VERSION = "v3";
const HIST_CACHE_VERSION = "v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

const parseYmd = (s: string) =>
  new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

/** setMonth의 날짜 넘침(3/31 → 3/3)을 막고 월말로 클램프한다. */
function minusMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/** "20260710" → "20260709" — 2단계 수집 구간의 끝(1단계 시작 하루 전)을 구한다. */
function previousDay(yyyymmdd: string): string {
  return ymd(new Date(parseYmd(yyyymmdd).getTime() - 86400000));
}

/** 날짜 문자열을 오름차순으로 담은 배열 — from·to 모두 포함한다. */
function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (const d = parseYmd(from); ymd(d) <= to; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  return days;
}

function kstNowIso(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** KRX는 숫자를 문자열로 준다. 빈 값·쉼표를 모두 흡수한다. */
function num(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * KRX 한 줄 → 캔들 하나. 휴장일에 오는 껍데기 행(전부 0)이면 null을 준다.
 *
 * 거래정지 종목은 종가만 있고 시·고·저가 칸이 비어 있을 수 있다. 그럴 때는 종가로
 * 채워 납작한 캔들이 되게 한다(0으로 두면 차트가 바닥까지 찌그러진다).
 */
function toBar(row: KrxRow, day: string): DayBar | null {
  const volume = num(row.ACC_TRDVOL);
  const value = num(row.ACC_TRDVAL);
  const close = num(row.TDD_CLSPRC);
  if (volume === 0 && value === 0 && close === 0) return null;
  const open = num(row.TDD_OPNPRC) || close;
  return {
    date: day,
    open,
    high: Math.max(num(row.TDD_HGPRC) || close, open, close),
    low: Math.min(num(row.TDD_LWPRC) || close, open, close),
    close,
    // 전일 대비 등락폭·등락률. 직접 계산하지 않고 거래소가 준 값을 그대로 쓴다.
    change: num(row.CMPPREVDD_PRC),
    changeRate: num(row.FLUC_RT),
    volume,
    value,
  };
}

const authKey = process.env.KRX_AUTH_KEY ?? "";

async function fetchRows(endpoint: string, basDd: string): Promise<KrxRow[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/${endpoint}?basDd=${basDd}`, {
        headers: { AUTH_KEY: authKey, Accept: "application/json" },
      });
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (res.status === 401) {
        const msg = (body as { respMsg?: string }).respMsg ?? "";
        // 이건 재시도해도 소용없으니 즉시 중단하고 원인을 알려준다.
        throw new Error(
          msg === "Unauthorized API Call"
            ? `[${endpoint}] 서비스 활용 신청이 승인되지 않았습니다. openapi.krx.co.kr에서 해당 API 활용 신청 후 승인을 받으세요.`
            : `[${endpoint}] 인증키가 유효하지 않습니다 (.env의 KRX_AUTH_KEY 확인).`,
        );
      }
      if (!res.ok) throw new Error(`[${endpoint}] HTTP ${res.status}`);
      return ((body as { OutBlock_1?: KrxRow[] }).OutBlock_1 ?? []);
    } catch (err) {
      if (err instanceof Error && err.message.includes("승인")) throw err;
      if (err instanceof Error && err.message.includes("인증키")) throw err;
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(300 * 2 ** attempt); // 300 → 600 → 1200ms
    }
  }
  throw lastError;
}

/** KRX는 당일 데이터를 바로 안 준다. 실제 데이터가 있는 가장 최근 영업일을 찾는다. */
async function findLatestDate(): Promise<string> {
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const day = ymd(new Date(Date.now() - i * 86400000));
    const rows = await fetchRows("sto/stk_bydd_trd", day);
    if (rows.length > 0) return day;
  }
  throw new Error(`최근 ${LOOKBACK_DAYS}일 안에 KRX 데이터가 있는 영업일을 찾지 못했습니다.`);
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    }),
  );
}

const cachePath = (from: string, to: string) =>
  path.join(CACHE_DIR, `krx-daily-${RANK_CACHE_VERSION}-${from}-${to}.json`);

async function readCache(from: string, to: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cachePath(from, to), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

const histCachePath = (from: string, to: string) =>
  path.join(CACHE_DIR, `krx-hist-${HIST_CACHE_VERSION}-${from}-${to}.json`);

/**
 * 2단계 캐시는 "요청했던 종목"까지 함께 저장한다. 순위가 바뀌어 새 종목이 들어오면
 * 그 종목의 과거 시세가 캐시에 없으므로, 필요한 종목이 전부 들어 있을 때만 재사용한다.
 */
async function readHistCache(from: string, to: string, codes: string[]): Promise<HistCacheFile | null> {
  try {
    const cache = JSON.parse(await readFile(histCachePath(from, to), "utf8")) as HistCacheFile;
    const covered = new Set(cache.codes);
    return codes.every((code) => covered.has(code)) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * TOP10 종목의 과거(1단계 창 이전) 일별 시세를 모은다.
 *
 * KRX Open API에는 "종목 하나의 기간 시세"를 주는 창구가 없고 날짜별 전 종목만 있어서,
 * 하루씩 전 종목을 받아 필요한 종목만 골라내는 수밖에 없다. 대신 어떤 엔드포인트가
 * 필요한지는 이미 알고 있으므로(TOP10에 코스닥 종목이 없으면 코스닥은 아예 안 부른다)
 * 그만큼 요청 수를 줄인다.
 */
async function fetchHistory(
  from: string,
  to: string,
  wanted: Map<string, Kind>,
  markets: Map<string, Market>,
): Promise<HistCacheFile> {
  const codes = [...wanted.keys()];
  const cached = await readHistCache(from, to, codes);
  if (cached) {
    console.log(`  과거 시세 캐시 사용: ${path.relative(ROOT, histCachePath(from, to))}`);
    return cached;
  }

  const needed = new Set<string>();
  for (const [code, kind] of wanted) {
    if (kind === "ETF") needed.add("etp/etf_bydd_trd");
    else if (kind === "ETN") needed.add("etp/etn_bydd_trd");
    else needed.add(markets.get(code) === "KOSDAQ" ? "sto/ksq_bydd_trd" : "sto/stk_bydd_trd");
  }
  const sources = SOURCES.filter((s) => needed.has(s.endpoint));
  assert(
    sources.some((s) => s.kind === "주식"),
    "과거 시세 수집에 주식 엔드포인트가 없습니다 — 영업일을 판정할 수 없습니다.",
  );

  const days = dateRange(from, to);
  const jobs: { day: string; source: Source }[] = [];
  for (const day of days) for (const source of sources) jobs.push({ day, source });
  console.log(
    `  과거 시세 수집 중... (${days.length}일 × ${sources.length}개 서비스 = ${jobs.length}요청, 몇 분 걸립니다)`,
  );

  const series: Record<string, DayBar[]> = {};
  const dates = new Set<string>();
  let done = 0;

  await mapLimit(jobs, CONCURRENCY, async ({ day, source }) => {
    const list = await fetchRows(source.endpoint, day);
    // 1단계와 같은 이유로 영업일 판정은 주식 엔드포인트로만 한다.
    if (list.length > 0 && source.kind === "주식") dates.add(day);
    for (const row of list) {
      const code = row.ISU_CD;
      if (!code || !wanted.has(code)) continue;
      const bar = toBar(row, day);
      if (bar) (series[code] ??= []).push(bar);
    }
    done++;
    if (done % 100 === 0) console.log(`    ${done}/${jobs.length}`);
  });

  const cache: HistCacheFile = { codes, series, dates: [...dates].sort() };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(histCachePath(from, to), JSON.stringify(cache), "utf8");
  return cache;
}

/** 임시 파일에 쓰고 rename — 도중에 죽어도 기존 파일이 반쯤 덮여 깨지지 않는다. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function toTop10(rows: Aggregate[]): Top10Row[] {
  return rows
    .slice()
    .sort((a, b) => b.volume - a.volume)
    .slice(0, TOP_N)
    .map((row, i) => ({
      rank: i + 1,
      code: row.code,
      name: row.name,
      market: row.market,
      kind: row.kind,
      volume: row.volume,
      value: row.value,
      lastClose: row.lastClose,
    }));
}

async function main(): Promise<void> {
  const started = Date.now();

  assert(
    authKey.length > 0,
    ".env 파일에 KRX_AUTH_KEY가 없습니다. openapi.krx.co.kr에서 인증키를 발급받아 넣으세요.",
  );

  // 1. 기간 결정 — KRX에 실제 데이터가 있는 마지막 영업일에서 거꾸로 1개월(순위)·6개월(시세).
  console.log("최신 영업일 확인 중...");
  const to = await findLatestDate();
  const from = ymd(minusMonths(parseYmd(to), 1));
  const histFrom = ymd(minusMonths(parseYmd(to), HISTORY_MONTHS));
  console.log(`  순위 집계 기간: ${from} ~ ${to}`);
  console.log(`  시세 수집 기간: ${histFrom} ~ ${to}`);

  let cache = await readCache(from, to);
  if (cache) {
    console.log(`캐시 사용: .cache/krx-daily-${from}-${to}.json`);
  } else {
    // 2. 기간 내 모든 날짜 × 4개 서비스를 훑는다. 휴장일은 빈 배열이 와서 자연히 걸러진다.
    const days = dateRange(from, to);

    const jobs: { day: string; source: Source }[] = [];
    for (const day of days) for (const source of SOURCES) jobs.push({ day, source });
    console.log(`수집 중... (${days.length}일 × ${SOURCES.length}개 서비스 = ${jobs.length}요청)`);

    const rows: Record<string, Aggregate> = {};
    const series: Record<string, DayBar[]> = {};
    const dates = new Set<string>();
    let done = 0;

    await mapLimit(jobs, CONCURRENCY, async ({ day, source }) => {
      const list = await fetchRows(source.endpoint, day);
      // 영업일 판정은 주식 엔드포인트로만 한다. ETF·ETN 엔드포인트는 휴장일에도
      // 거래량 0 / 종가 빈 값짜리 껍데기 행을 돌려주기 때문에, 그걸 기준으로 삼으면
      // 주말까지 영업일로 세어버린다.
      if (list.length > 0 && source.kind === "주식") dates.add(day);
      for (const row of list) {
        const code = row.ISU_CD;
        if (!code) continue;
        const bar = toBar(row, day);
        // 휴장일 껍데기 행은 통째로 건너뛴다.
        if (!bar) continue;
        const market: Market = source.market ?? (row.MKT_NM === "KOSDAQ" ? "KOSDAQ" : "KOSPI");
        (series[code] ??= []).push(bar);

        const snapshot: Snapshot = {
          listedShares: num(row.LIST_SHRS),
          marketCap: num(row.MKTCAP),
          nav: source.navField ? num(row[source.navField]) : 0,
        };

        const prev = rows[code];
        if (prev) {
          prev.volume += bar.volume;
          prev.value += bar.value;
          // 병렬로 도착하므로 날짜를 비교해 가장 최근 것만 남긴다. 시가총액·순자산가치도
          // 날마다 달라지므로 종가와 같은 날짜의 값이어야 짝이 맞는다.
          if (day > prev.lastDate && bar.close > 0) {
            prev.lastDate = day;
            prev.lastClose = bar.close;
            Object.assign(prev, snapshot);
          }
        } else {
          rows[code] = {
            code,
            name: (row.ISU_NM ?? "").trim(),
            market,
            kind: source.kind,
            volume: bar.volume,
            value: bar.value,
            lastClose: bar.close,
            lastDate: day,
            ...snapshot,
          };
        }
      }
      done++;
      if (done % 40 === 0) console.log(`  ${done}/${jobs.length}`);
    });

    cache = { window: { from, to }, rows, series, dates: [...dates].sort() };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(from, to), JSON.stringify(cache), "utf8");
  }

  // 3. 집계
  const aggregates = Object.values(cache.rows);
  const sortedDates = cache.dates;
  const stocks = toTop10(aggregates.filter((row) => row.kind === "주식"));
  const all = toTop10(aggregates);

  // 4. 검증 — 여기까지 통과해야만 기존 JSON을 교체한다.
  assert(sortedDates.length >= MIN_TRADING_DAYS, `영업일이 너무 적습니다 (${sortedDates.length}일).`);
  assert(
    sortedDates.length <= MAX_TRADING_DAYS,
    `영업일이 비정상적으로 많습니다 (${sortedDates.length}일). 휴장일이 섞였는지 확인하세요.`,
  );
  assert(aggregates.length > 3000, `집계 종목이 너무 적습니다 (${aggregates.length}종목).`);
  assert(stocks.length === TOP_N, `개별 종목이 ${TOP_N}건이 아닙니다 (${stocks.length}건).`);
  assert(all.length === TOP_N, `전체 목록이 ${TOP_N}건이 아닙니다 (${all.length}건).`);
  for (const list of [stocks, all]) {
    for (let i = 1; i < list.length; i++) {
      assert(list[i - 1].volume >= list[i].volume, "거래량 내림차순 정렬이 깨졌습니다.");
    }
    for (const row of list) {
      assert(row.volume > 0 && row.value > 0 && row.lastClose > 0, `${row.name}의 값이 비어 있습니다.`);
    }
    for (const row of list) {
      const agg = aggregates.find((a) => a.code === row.code)!;
      assert(agg.marketCap > 0, `${row.name}의 시가총액이 비어 있습니다.`);
      assert(agg.listedShares > 0, `${row.name}의 상장주식수가 비어 있습니다.`);
    }
  }
  assert(stocks.every((row) => row.kind === "주식"), "개별 종목 목록에 ETF·ETN이 섞였습니다.");

  // 5. 종목 상세 페이지용 일별 시세 — 두 순위표에 오른 종목만 추린다.
  //    전 종목(4,000개 이상)을 내보내면 저장소가 불필요하게 커진다.
  const detailCodes = [...new Set([...stocks, ...all].map((row) => row.code))];
  for (const code of detailCodes) {
    assert(cache.rows[code] !== undefined, `${code}의 집계 결과를 찾지 못했습니다.`);
  }

  // 5-1. 2단계 — 기술적 지표에 필요한 과거 5개월치를 TOP10 종목만 따로 받아 앞에 붙인다.
  console.log(`\n기술적 지표용 과거 시세 (${detailCodes.length}종목)`);
  const hist = await fetchHistory(
    histFrom,
    previousDay(from),
    new Map(detailCodes.map((code) => [code, cache!.rows[code].kind])),
    new Map(detailCodes.map((code) => [code, cache!.rows[code].market])),
  );

  const historyDates = [...new Set([...hist.dates, ...sortedDates])].sort();
  assert(
    historyDates.length >= MIN_HISTORY_DAYS && historyDates.length <= MAX_HISTORY_DAYS,
    `${HISTORY_MONTHS}개월 영업일이 ${historyDates.length}일입니다 (${MIN_HISTORY_DAYS}~${MAX_HISTORY_DAYS}일이어야 정상).`,
  );

  const seriesOut: Record<string, StockSeries> = {};
  for (const code of detailCodes) {
    const agg = cache.rows[code];
    // 병렬로 모았기 때문에 날짜가 뒤섞여 있다. 차트가 시간순으로 그려지도록 정렬한다.
    const days = [...(hist.series[code] ?? []), ...(cache.series[code] ?? [])]
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    assert(days.length >= 5, `${agg.name}의 일별 시세가 ${days.length}일뿐입니다 (최근 1주일 표에 5일이 필요).`);
    for (let i = 1; i < days.length; i++) {
      assert(days[i - 1].date < days[i].date, `${agg.name}의 일별 시세에 날짜가 중복됐습니다.`);
    }
    for (const bar of days) {
      assert(bar.close > 0, `${agg.name} ${bar.date}의 종가가 비어 있습니다.`);
      assert(bar.low <= bar.close && bar.close <= bar.high, `${agg.name} ${bar.date}의 종가가 고저 범위를 벗어났습니다.`);
    }
    seriesOut[code] = {
      code,
      name: agg.name,
      market: agg.market,
      kind: agg.kind,
      listedShares: agg.listedShares,
      marketCap: agg.marketCap,
      nav: agg.nav,
      days,
    };
  }

  const generatedAt = kstNowIso();
  const period = {
    from: sortedDates[0],
    to: sortedDates[sortedDates.length - 1],
    tradingDays: sortedDates.length,
  };
  const payload = { generatedAt, window: period, stocks, all };
  const dailyPayload = {
    generatedAt,
    // window는 차트·순위와 같은 최근 1개월. history는 지표 계산에 쓰는 6개월 전체.
    window: period,
    history: {
      from: historyDates[0],
      to: historyDates[historyDates.length - 1],
      tradingDays: historyDates.length,
    },
    dates: sortedDates,
    series: seriesOut,
  };

  // 6. 원자적 교체 — 중간에 죽어도 기존 파일이 깨지지 않는다. 두 파일은 반드시
  //    함께 갱신한다. 한쪽만 새것이면 상세 페이지 링크가 깨진다.
  await writeJson(OUT_FILE, payload);
  await writeJson(DAILY_FILE, dailyPayload);

  const 억 = (n: number) => `${(n / 1e8).toFixed(1)}억`;
  console.log(`\n기간: ${payload.window.from} ~ ${payload.window.to} (${payload.window.tradingDays}영업일)`);
  console.log(`집계 종목: ${aggregates.length}`);
  console.log("\n개별 종목 TOP10");
  for (const r of stocks) console.log(`  ${String(r.rank).padStart(2)} ${r.name.padEnd(20)} ${억(r.volume).padStart(10)}주  ${억(r.value).padStart(12)}원`);
  console.log("\nETF·ETN 포함 TOP10");
  for (const r of all) console.log(`  ${String(r.rank).padStart(2)} ${r.name.padEnd(20)} ${억(r.volume).padStart(10)}주  ${억(r.value).padStart(12)}원`);
  const barCount = Object.values(seriesOut).reduce((sum, s) => sum + s.days.length, 0);
  const shortest = Object.values(seriesOut).reduce((min, s) => Math.min(min, s.days.length), Infinity);
  console.log(`\n→ ${path.relative(ROOT, OUT_FILE)} 갱신 완료`);
  console.log(`→ ${path.relative(ROOT, DAILY_FILE)} 갱신 완료 (${detailCodes.length}종목 · 일별 시세 ${barCount}건)`);
  console.log(
    `   지표용 과거: ${dailyPayload.history.from} ~ ${dailyPayload.history.to} (${historyDates.length}영업일)` +
      ` · 가장 짧은 종목 ${shortest}일`,
  );
  console.log(`\n소요 ${((Date.now() - started) / 1000).toFixed(1)}초`);
}

main().catch((err) => {
  console.error(`\n수집 실패: ${err instanceof Error ? err.message : String(err)}`);
  console.error("기존 top10.json·daily.json은 그대로 두었습니다.");
  process.exitCode = 1;
});
