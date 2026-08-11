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
const CONCURRENCY = 4;
const MAX_RETRIES = 3;
const TOP_N = 10;
/** 최신 영업일을 찾을 때 오늘부터 거꾸로 최대 며칠까지 훑을지 (연휴 대비) */
const LOOKBACK_DAYS = 14;

/** 검증 기준: 이보다 못 미치면 기존 JSON을 건드리지 않고 실패시킨다. */
const MIN_TRADING_DAYS = 15;
/**
 * 1개월 창에 영업일이 25일을 넘을 수는 없다. 이 상한이 깨진다면 휴장일을
 * 영업일로 세고 있다는 뜻이므로 조용히 넘어가지 말고 실패시킨다.
 */
const MAX_TRADING_DAYS = 25;

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
}

const SOURCES: Source[] = [
  { endpoint: "sto/stk_bydd_trd", kind: "주식", market: null, label: "유가증권" },
  { endpoint: "sto/ksq_bydd_trd", kind: "주식", market: null, label: "코스닥" },
  { endpoint: "etp/etf_bydd_trd", kind: "ETF", market: "KOSPI", label: "ETF" },
  { endpoint: "etp/etn_bydd_trd", kind: "ETN", market: "KOSPI", label: "ETN" },
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

/** daily.json에 실리는 종목 한 개 — 기본 정보 + 기간 내 일별 시세 */
interface StockSeries {
  code: string;
  name: string;
  market: Market;
  kind: Kind;
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

interface Aggregate {
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

const CACHE_VERSION = "v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

const parseYmd = (s: string) =>
  new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));

/** setMonth(-1)의 날짜 넘침(3/31 → 3/3)을 막고 월말로 클램프한다. */
function minusOneMonth(date: Date): Date {
  const d = new Date(date.getTime());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
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
  path.join(CACHE_DIR, `krx-daily-${CACHE_VERSION}-${from}-${to}.json`);

async function readCache(from: string, to: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cachePath(from, to), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
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

  // 1. 기간 결정 — KRX에 실제 데이터가 있는 마지막 영업일에서 거꾸로 1개월.
  console.log("최신 영업일 확인 중...");
  const to = await findLatestDate();
  const from = ymd(minusOneMonth(parseYmd(to)));
  console.log(`  기간: ${from} ~ ${to}`);

  let cache = await readCache(from, to);
  if (cache) {
    console.log(`캐시 사용: .cache/krx-daily-${from}-${to}.json`);
  } else {
    // 2. 기간 내 모든 날짜 × 4개 서비스를 훑는다. 휴장일은 빈 배열이 와서 자연히 걸러진다.
    const days: string[] = [];
    for (let d = parseYmd(from); ymd(d) <= to; d.setDate(d.getDate() + 1)) days.push(ymd(d));

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
        const volume = num(row.ACC_TRDVOL);
        const value = num(row.ACC_TRDVAL);
        const close = num(row.TDD_CLSPRC);
        // 휴장일 껍데기 행은 통째로 건너뛴다.
        if (volume === 0 && value === 0 && close === 0) continue;
        const market: Market = source.market ?? (row.MKT_NM === "KOSDAQ" ? "KOSDAQ" : "KOSPI");

        // 거래정지 종목은 종가만 있고 시·고·저가 칸이 비어 있을 수 있다. 그럴 때는
        // 종가로 채워 납작한 캔들이 되게 한다(0으로 두면 차트가 바닥까지 찌그러진다).
        const open = num(row.TDD_OPNPRC) || close;
        const high = Math.max(num(row.TDD_HGPRC) || close, open, close);
        const low = Math.min(num(row.TDD_LWPRC) || close, open, close);
        (series[code] ??= []).push({
          date: day,
          open,
          high,
          low,
          close,
          change: num(row.CMPPREVDD_PRC),
          changeRate: num(row.FLUC_RT),
          volume,
          value,
        });

        const prev = rows[code];
        if (prev) {
          prev.volume += volume;
          prev.value += value;
          // 병렬로 도착하므로 날짜를 비교해 가장 최근 종가만 남긴다.
          if (day > prev.lastDate && close > 0) {
            prev.lastDate = day;
            prev.lastClose = close;
          }
        } else {
          rows[code] = {
            code,
            name: (row.ISU_NM ?? "").trim(),
            market,
            kind: source.kind,
            volume,
            value,
            lastClose: close,
            lastDate: day,
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
  }
  assert(stocks.every((row) => row.kind === "주식"), "개별 종목 목록에 ETF·ETN이 섞였습니다.");

  // 5. 종목 상세 페이지용 일별 시세 — 두 순위표에 오른 종목만 추린다.
  //    전 종목(4,000개 이상)을 내보내면 저장소가 불필요하게 커진다.
  const detailCodes = [...new Set([...stocks, ...all].map((row) => row.code))];
  const seriesOut: Record<string, StockSeries> = {};
  for (const code of detailCodes) {
    const agg = cache.rows[code];
    assert(agg !== undefined, `${code}의 집계 결과를 찾지 못했습니다.`);
    // 병렬로 모았기 때문에 날짜가 뒤섞여 있다. 차트가 시간순으로 그려지도록 정렬한다.
    const days = (cache.series[code] ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
    assert(days.length >= 5, `${agg.name}의 일별 시세가 ${days.length}일뿐입니다 (최근 1주일 표에 5일이 필요).`);
    for (let i = 1; i < days.length; i++) {
      assert(days[i - 1].date < days[i].date, `${agg.name}의 일별 시세에 날짜가 중복됐습니다.`);
    }
    for (const bar of days) {
      assert(bar.close > 0, `${agg.name} ${bar.date}의 종가가 비어 있습니다.`);
      assert(bar.low <= bar.close && bar.close <= bar.high, `${agg.name} ${bar.date}의 종가가 고저 범위를 벗어났습니다.`);
    }
    seriesOut[code] = { code, name: agg.name, market: agg.market, kind: agg.kind, days };
  }

  const generatedAt = kstNowIso();
  const period = {
    from: sortedDates[0],
    to: sortedDates[sortedDates.length - 1],
    tradingDays: sortedDates.length,
  };
  const payload = { generatedAt, window: period, stocks, all };
  const dailyPayload = { generatedAt, window: period, dates: sortedDates, series: seriesOut };

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
  console.log(`\n→ ${path.relative(ROOT, OUT_FILE)} 갱신 완료`);
  console.log(`→ ${path.relative(ROOT, DAILY_FILE)} 갱신 완료 (${detailCodes.length}종목 · 일별 시세 ${barCount}건)`);
  console.log(`\n소요 ${((Date.now() - started) / 1000).toFixed(1)}초`);
}

main().catch((err) => {
  console.error(`\n수집 실패: ${err instanceof Error ? err.message : String(err)}`);
  console.error("기존 top10.json·daily.json은 그대로 두었습니다.");
  process.exitCode = 1;
});
