/**
 * 국내 주식 — 최근 1개월 누적 거래량 TOP10 수집기
 *
 *   실행: npm run collect:domestic
 *   결과: src/data/domestic/top10.json  (git에 커밋됨)
 *
 * 이 스크립트는 로컬에서 수동으로만 실행한다. 사이트 빌드는 이 스크립트를 호출하지
 * 않으며, 커밋된 JSON만 읽는다. 덕분에 Cloudflare 배포가 외부 사이트 상태에
 * 영향받지 않는다.
 *
 * 왜 네이버인가:
 *   - data.krx.co.kr JSON 엔드포인트는 모든 요청에 LOGOUT을 반환한다(회원제 전환).
 *   - 브라우저에서 직접 부르는 건 불가능하다. 네이버는 Origin 헤더가 붙으면 403.
 *   따라서 "로컬에서 수집 → JSON 커밋 → 빌드타임 import"가 유일한 경로다.
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
const CACHE_DIR = path.join(ROOT, ".cache");

const CONCURRENCY = 6;
const MAX_RETRIES = 3;
const TOP_N = 10;
/** 기간 결정용 기준 종목 — 삼성전자는 거래정지가 사실상 없다. */
const REFERENCE_SYMBOL = "005930";

/** 검증 기준: 이보다 못 미치면 기존 JSON을 건드리지 않고 실패시킨다. */
const MIN_TRADING_DAYS = 15;
const MIN_SUCCESS_RATE = 0.95;

const HEADERS = {
  // 이 두 헤더가 없으면 네이버가 응답을 거부한다.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: "https://finance.naver.com",
};

type Market = "KOSPI" | "KOSDAQ";
type Kind = "주식" | "ETF" | "ETN";

interface Listing {
  code: string;
  name: string;
  market: Market;
  kind: Kind;
}

/** [날짜, 종가, 거래량] — 캐시를 작게 유지하려고 필요한 3개만 남긴다. */
type DailyTuple = [string, number, number];

interface CacheFile {
  window: { from: string; to: string };
  listings: Listing[];
  daily: Record<string, DailyTuple[]>;
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

interface Aggregate extends Listing {
  volume: number;
  value: number;
  lastClose: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

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

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(300 * 2 ** attempt); // 300 → 600 → 1200ms
    }
  }
  throw lastError;
}

/**
 * siseJson 응답은 유효한 JSON이 아니다. 헤더 행이 홑따옴표로 되어 있어
 * JSON.parse가 바로 터진다:
 *   [['날짜', '시가', ...],
 *    ["20260810", 291000, ...]]
 * 홑따옴표를 전부 큰따옴표로 바꾸면 유효해진다. 응답에 종목명 같은
 * 자유 텍스트가 없어서 이 치환이 안전하다 (4,294종목 전수 검증 완료).
 */
function parseDaily(text: string): DailyTuple[] {
  const rows = JSON.parse(text.replace(/'/g, '"')) as unknown[][];
  const out: DailyTuple[] = [];
  // rows[0]은 헤더 행. 이후 각 행은 [날짜, 시가, 고가, 저가, 종가, 거래량, 외국인소진율]
  for (const row of rows.slice(1)) {
    const date = row[0];
    const close = row[4];
    const volume = row[5];
    if (typeof date !== "string" || typeof close !== "number" || typeof volume !== "number") continue;
    out.push([date, close, volume]);
  }
  return out;
}

const dailyUrl = (code: string, from: string, to: string) =>
  `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(code)}` +
  `&requestType=1&startTime=${from}&endTime=${to}&timeframe=day`;

async function fetchDaily(code: string, from: string, to: string): Promise<DailyTuple[]> {
  return parseDaily(await fetchText(dailyUrl(code, from, to)));
}

/** 코스피·코스닥 전 종목 목록. pageSize 상한이 있어 페이징이 필요하다. */
async function fetchListings(): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const [sosok, market] of [[0, "KOSPI"], [1, "KOSDAQ"]] as [number, Market][]) {
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    let seen = 0;
    while (seen < total && page <= 10) {
      const url =
        `https://m.stock.naver.com/api/json/sise/siseListJson.nhn` +
        `?menu=quant&sosok=${sosok}&pageSize=1000&page=${page}`;
      const body = JSON.parse(await fetchText(url));
      const items = body?.result?.itemList ?? [];
      total = body?.result?.totCnt ?? items.length;
      if (items.length === 0) break;
      for (const item of items) {
        out.push({
          // 종목코드에 영문자가 섞인 게 373개 있다(0193T0 등). 숫자로 바꾸면 안 된다.
          code: String(item.cd),
          name: String(item.nm),
          market,
          kind: item.etf ? "ETF" : item.etn ? "ETN" : "주식",
        });
      }
      seen += items.length;
      page++;
    }
    console.log(`  ${market}: ${seen}종목`);
  }
  return out;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const results = new Array<R | null>(items.length);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index]);
      } catch {
        results[index] = null;
      }
      done++;
      if (done % 500 === 0) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readCache(from: string, to: string): Promise<CacheFile | null> {
  try {
    const raw = await readFile(path.join(CACHE_DIR, `naver-daily-${from}-${to}.json`), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `naver-daily-${cache.window.from}-${cache.window.to}.json`);
  await writeFile(file, JSON.stringify(cache), "utf8");
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const started = Date.now();

  // 1. 기간 결정 — 데이터상 마지막 영업일에서 거꾸로 1개월.
  console.log("기간 확인 중...");
  const today = new Date();
  const probe = await fetchDaily(REFERENCE_SYMBOL, ymd(new Date(today.getTime() - 40 * 86400000)), ymd(today));
  assert(probe.length > 0, "기준 종목의 일별 시세를 가져오지 못했습니다.");
  const to = probe[probe.length - 1][0];
  const from = ymd(minusOneMonth(new Date(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)))));
  console.log(`  요청 기간: ${from} ~ ${to}`);

  // 2. 캐시 확인 — 같은 기간이면 네트워크를 아예 타지 않는다.
  //    기간이 바뀌면 파일명이 달라져 자동으로 캐시 미스가 난다.
  let cache = await readCache(from, to);
  if (cache) {
    console.log(`캐시 사용: .cache/naver-daily-${from}-${to}.json`);
  } else {
    console.log("종목 목록 수집 중...");
    const listings = await fetchListings();
    assert(listings.length > 1000, `종목 목록이 너무 적습니다 (${listings.length}종목).`);

    console.log(`일별 시세 수집 중... (${listings.length}종목, 동시성 ${CONCURRENCY})`);
    const daily: Record<string, DailyTuple[]> = {};
    const fetched = await mapLimit(listings, CONCURRENCY, async (listing) => {
      const rows = await fetchDaily(listing.code, from, to);
      if (rows.length > 0) daily[listing.code] = rows;
      return true;
    });

    const successRate = fetched.filter(Boolean).length / listings.length;
    console.log(`  성공률 ${(successRate * 100).toFixed(1)}%`);
    assert(
      successRate >= MIN_SUCCESS_RATE,
      `수집 성공률이 너무 낮습니다 (${(successRate * 100).toFixed(1)}% < ${MIN_SUCCESS_RATE * 100}%).`,
    );

    cache = { window: { from, to }, listings, daily };
    await writeCache(cache);
  }

  // 3. 집계
  const dates = new Set<string>();
  const aggregates: Aggregate[] = [];
  for (const listing of cache.listings) {
    const rows = cache.daily[listing.code];
    if (!rows || rows.length === 0) continue;
    let volume = 0;
    let value = 0;
    for (const [date, close, dayVolume] of rows) {
      dates.add(date);
      volume += dayVolume;
      // 실제 거래대금은 체결가 기준이라 키 없는 소스로는 얻을 수 없다.
      // 종가 × 거래량으로 근사하고, UI에 "종가 기준 추정"이라고 표기한다.
      value += close * dayVolume;
    }
    aggregates.push({
      ...listing,
      volume,
      value: Math.round(value),
      lastClose: rows[rows.length - 1][1],
    });
  }

  const sortedDates = [...dates].sort();
  const stocks = toTop10(aggregates.filter((row) => row.kind === "주식"));
  const all = toTop10(aggregates);

  // 4. 검증 — 여기까지 통과해야만 기존 JSON을 교체한다.
  assert(sortedDates.length >= MIN_TRADING_DAYS, `영업일이 너무 적습니다 (${sortedDates.length}일).`);
  assert(stocks.length === TOP_N, `개별 종목이 ${TOP_N}건이 아닙니다 (${stocks.length}건).`);
  assert(all.length === TOP_N, `전체 목록이 ${TOP_N}건이 아닙니다 (${all.length}건).`);
  for (const list of [stocks, all]) {
    for (let i = 1; i < list.length; i++) {
      assert(list[i - 1].volume >= list[i].volume, "거래량 내림차순 정렬이 깨졌습니다.");
    }
  }
  assert(stocks.every((row) => row.kind === "주식"), "개별 종목 목록에 ETF·ETN이 섞였습니다.");

  const payload = {
    generatedAt: kstNowIso(),
    window: {
      from: sortedDates[0],
      to: sortedDates[sortedDates.length - 1],
      tradingDays: sortedDates.length,
    },
    stocks,
    all,
  };

  // 5. 원자적 교체 — 중간에 죽어도 기존 파일이 깨지지 않는다.
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, OUT_FILE);

  console.log(`\n기간: ${payload.window.from} ~ ${payload.window.to} (${payload.window.tradingDays}영업일)`);
  console.log(`집계 종목: ${aggregates.length}`);
  console.log("\n개별 종목 TOP10");
  for (const row of stocks) {
    console.log(`  ${String(row.rank).padStart(2)} ${row.name.padEnd(20)} ${(row.volume / 1e8).toFixed(1)}억주`);
  }
  console.log("\nETF·ETN 포함 TOP10");
  for (const row of all) {
    console.log(`  ${String(row.rank).padStart(2)} ${row.name.padEnd(20)} ${(row.volume / 1e8).toFixed(1)}억주`);
  }
  console.log(`\n→ ${path.relative(ROOT, OUT_FILE)} 갱신 완료 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
}

main().catch((err) => {
  console.error(`\n수집 실패: ${err instanceof Error ? err.message : String(err)}`);
  console.error("기존 top10.json은 그대로 두었습니다.");
  process.exit(1);
});
