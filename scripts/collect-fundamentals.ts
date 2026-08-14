/**
 * 기업 가치 지표 원재료 수집기 — DART(전자공시) OpenAPI
 *
 *   실행: npm run collect:fundamentals
 *   결과: src/data/domestic/fundamentals.json   ← git에 커밋됨
 *
 * PER·PBR을 계산하려면 "회사가 한 해 얼마를 벌었나(당기순이익)"와 "회사에 남은 몫이
 * 얼마인가(자본총계)"가 필요하다. KRX OPEN API에는 이 두 값이 없다. 거래소는 시세를
 * 주는 곳이지 재무제표를 주는 곳이 아니기 때문이다. 그래서 금융감독원 전자공시(DART)의
 * 공식 OpenAPI에서 받아온다. 감사받은 정기보고서가 원천이라 출처가 분명하다.
 *
 * 시가총액·상장주식수는 KRX 쪽에 이미 있으므로 여기서 받지 않는다. 이 파일은 오직
 * 재무 숫자만 담고, 실제 PER·PBR 계산은 화면을 그릴 때 두 자료를 합쳐서 한다.
 *
 * 어떤 보고서를 쓰나:
 *   가장 최근에 확정된 **사업보고서(연간)** 하나만 쓴다. 분기·반기 실적을 섞으면
 *   "이 PER이 대체 몇 개월치 이익 기준인가"가 흐려져 초보자에게 설명할 수 없다.
 *   대신 화면에 "몇 년 실적 기준"인지 반드시 함께 적는다.
 *   DART 주요계정 응답은 당기·전기·전전기 3개년을 한 번에 주므로, 추가 요청 없이
 *   3년치 흐름(이익이 늘고 있나 줄고 있나)까지 그대로 얻는다.
 *
 * 인증키:
 *   저장소 루트 .env 에 DART_API_KEY=... 형태로 넣어둔다(.gitignore 등록되어 있음).
 *   https://opendart.fss.or.kr 회원가입 → 인증키 신청 → 이메일 인증이면 끝이고,
 *   KRX와 달리 서비스별 활용 신청 절차가 없다.
 *
 * Node 22.18+ 또는 24+ 필요 (타입 스트리핑으로 .ts를 직접 실행).
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAILY_FILE = path.join(ROOT, "src", "data", "domestic", "daily.json");
const OUT_FILE = path.join(ROOT, "src", "data", "domestic", "fundamentals.json");
const CACHE_DIR = path.join(ROOT, ".cache");
const CORP_CODE_CACHE = path.join(CACHE_DIR, "dart-corp-code.xml");

const API_BASE = "https://opendart.fss.or.kr/api";
/** 사업보고서(연간). 11012 반기, 11013 1분기, 11014 3분기 */
const ANNUAL = "11011";
/** 최근 사업연도부터 거꾸로 몇 해까지 찾아볼지. 결산·공시가 늦는 회사를 위한 여유다. */
const YEAR_LOOKBACK = 3;
const CONCURRENCY = 3;

const authKey = process.env.DART_API_KEY ?? "";

interface DartAccount {
  account_nm?: string;
  /** BS 재무상태표 · IS 손익계산서 · CIS 포괄손익계산서 · CF 현금흐름표 */
  sj_div?: string;
  /** CFS 연결 · OFS 별도 */
  fs_div?: string;
  thstrm_amount?: string;
  frmtrm_amount?: string;
  bfefrmtrm_amount?: string;
  thstrm_nm?: string;
  frmtrm_nm?: string;
  bfefrmtrm_nm?: string;
}

interface DartResponse {
  status?: string;
  message?: string;
  list?: DartAccount[];
}

/** 한 해치 재무 숫자 */
interface YearFigure {
  /** "2025" */
  year: string;
  /** 당기순이익 (원). 적자면 음수 */
  netIncome: number | null;
  /** 자본총계 (원) */
  equity: number | null;
}

interface Company {
  code: string;
  name: string;
  corpCode: string;
  /** 어느 사업연도 보고서에서 뽑았는지 */
  fiscalYear: string;
  /** 연결(CFS)인지 별도(OFS)인지 — 화면에 밝혀야 한다 */
  basis: "연결" | "별도";
  netIncome: number | null;
  equity: number | null;
  /** 오래된 해부터 순서대로. 3개년 흐름을 보여주는 데 쓴다. */
  history: YearFigure[];
}

interface Payload {
  generatedAt: string;
  source: string;
  companies: Record<string, Company>;
  /** 자료를 얻지 못한 종목과 그 이유 — 화면에서 "왜 없는지" 설명하는 데 쓴다 */
  missing: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function kstNowIso(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/**
 * DART 금액 문자열 → 숫자. "1,234,567" · "-1,234" · "" 를 모두 흡수한다.
 * 빈 값과 0은 구분해야 한다(0원 이익과 '자료 없음'은 다르다).
 */
function amount(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ── 고유번호(corp_code) 매핑 ────────────────────────────────────────────────
// DART는 종목코드가 아니라 자체 8자리 고유번호로 회사를 찾는다. 그 대응표는
// ZIP 파일 하나로만 제공된다.

/**
 * 단일 파일 ZIP에서 그 파일을 꺼낸다.
 *
 * 압축 라이브러리를 새로 붙이지 않으려고 직접 푼다. 중앙 디렉터리(End of Central
 * Directory)부터 읽는 이유는, 로컬 헤더 쪽 압축 크기가 0으로 비어 있고 실제 값이
 * 데이터 뒤에 따라오는 방식(data descriptor)으로 만들어진 ZIP도 있기 때문이다.
 */
function unzipSingleFile(buffer: Buffer): Buffer {
  // EOCD 시그니처(0x06054b50)를 뒤에서부터 찾는다.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "ZIP 형식이 아닙니다 (중앙 디렉터리를 찾지 못했습니다).");

  const centralOffset = buffer.readUInt32LE(eocd + 16);
  assert(buffer.readUInt32LE(centralOffset) === 0x02014b50, "ZIP 중앙 디렉터리가 손상됐습니다.");

  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const nameLen = buffer.readUInt16LE(centralOffset + 28);
  const extraLen = buffer.readUInt16LE(centralOffset + 30);
  const commentLen = buffer.readUInt16LE(centralOffset + 32);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  void nameLen;
  void extraLen;
  void commentLen;

  assert(buffer.readUInt32LE(localOffset) === 0x04034b50, "ZIP 로컬 헤더가 손상됐습니다.");
  const localNameLen = buffer.readUInt16LE(localOffset + 26);
  const localExtraLen = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLen + localExtraLen;
  const data = buffer.subarray(dataStart, dataStart + compressedSize);

  // 0 = 무압축, 8 = deflate. DART는 deflate로 준다.
  return method === 0 ? Buffer.from(data) : inflateRawSync(data);
}

/** 종목코드 → DART 고유번호. 파일이 20MB쯤 되므로 한 번 받아 캐시한다. */
async function loadCorpCodes(): Promise<Map<string, { corpCode: string; name: string }>> {
  let xml: string;
  try {
    xml = await readFile(CORP_CODE_CACHE, "utf8");
    console.log(`  고유번호 캐시 사용: ${path.relative(ROOT, CORP_CODE_CACHE)}`);
  } catch {
    console.log("  고유번호 대응표 내려받는 중... (약 20MB)");
    const res = await fetch(`${API_BASE}/corpCode.xml?crtfc_key=${authKey}`);
    assert(res.ok, `고유번호 대응표를 받지 못했습니다 (HTTP ${res.status}).`);
    const body = Buffer.from(await res.arrayBuffer());

    // 인증키가 틀리면 ZIP 대신 XML 오류 문서가 온다.
    if (body.subarray(0, 2).toString() !== "PK") {
      const text = body.toString("utf8");
      const status = text.match(/<status>(\d+)<\/status>/)?.[1] ?? "?";
      const message = text.match(/<message>([^<]*)<\/message>/)?.[1] ?? text.slice(0, 120);
      throw new Error(`DART가 오류를 돌려줬습니다 (status ${status}): ${message}`);
    }

    xml = unzipSingleFile(body).toString("utf8");
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CORP_CODE_CACHE, xml, "utf8");
  }

  // <list><corp_code>..</corp_code><corp_name>..</corp_name><stock_code>..</stock_code>...</list>
  const map = new Map<string, { corpCode: string; name: string }>();
  for (const [, block] of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const stock = block.match(/<stock_code>\s*([^<\s]*)\s*<\/stock_code>/)?.[1] ?? "";
    if (stock.length !== 6) continue; // 비상장사는 종목코드가 비어 있다
    const corpCode = block.match(/<corp_code>\s*(\d+)\s*<\/corp_code>/)?.[1] ?? "";
    const name = (block.match(/<corp_name>([^<]*)<\/corp_name>/)?.[1] ?? "").trim();
    if (corpCode) map.set(stock, { corpCode, name });
  }
  assert(map.size > 1000, `상장사 고유번호가 ${map.size}건뿐입니다. 대응표가 깨졌는지 확인하세요.`);
  return map;
}

// ── 재무제표 ────────────────────────────────────────────────────────────────

async function fetchAccounts(corpCode: string, year: string): Promise<DartResponse> {
  const url =
    `${API_BASE}/fnlttSinglAcnt.json?crtfc_key=${authKey}` +
    `&corp_code=${corpCode}&bsns_year=${year}&reprt_code=${ANNUAL}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as DartResponse;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(300 * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

/**
 * 계정 이름 표기 차이를 지운다. 같은 "당기순이익"이라도 회사마다 적는 방식이 달라서
 * 삼성전자는 "당기순이익(손실)", 다른 곳은 "당기순이익", 또 다른 곳은 공백을 끼워
 * "당기 순이익"으로 낸다. 괄호 안 설명과 공백을 떼고 비교해야 같은 계정으로 잡힌다.
 * ("법인세차감전 순이익"은 공백을 떼도 "당기순이익"과 달라서 섞이지 않는다.)
 */
function normalizeAccount(name: string | undefined): string {
  return (name ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
}

/**
 * 같은 계정이 연결(CFS)·별도(OFS) 두 벌로 온다. 연결을 먼저 쓰는 이유는 자회사까지
 * 합친 그림이 그 회사의 실제 규모에 가깝기 때문이고, 연결 재무제표를 만들지 않는
 * 회사(자회사가 없는 경우)만 별도로 떨어진다.
 */
function pick(list: DartAccount[], name: string, section: string): { row: DartAccount; basis: "연결" | "별도" } | null {
  const wanted = normalizeAccount(name);
  const matches = list.filter((row) => normalizeAccount(row.account_nm) === wanted && row.sj_div === section);
  const consolidated = matches.find((row) => row.fs_div === "CFS");
  if (consolidated) return { row: consolidated, basis: "연결" };
  const separate = matches.find((row) => row.fs_div === "OFS");
  return separate ? { row: separate, basis: "별도" } : null;
}

/** 응답 하나에서 3개년(당기·전기·전전기) 숫자를 뽑는다. */
function toCompany(code: string, name: string, corpCode: string, year: string, list: DartAccount[]): Company | null {
  const income = pick(list, "당기순이익", "IS");
  const equity = pick(list, "자본총계", "BS");
  // 손익계산서를 포괄손익계산서(CIS)로만 내는 회사도 있다.
  const incomeAlt = income ?? pick(list, "당기순이익", "CIS");
  if (!incomeAlt && !equity) return null;

  const basis = incomeAlt?.basis ?? equity?.basis ?? "연결";
  const y = Number(year);
  const history: YearFigure[] = [
    {
      year: String(y - 2),
      netIncome: amount(incomeAlt?.row.bfefrmtrm_amount),
      equity: amount(equity?.row.bfefrmtrm_amount),
    },
    {
      year: String(y - 1),
      netIncome: amount(incomeAlt?.row.frmtrm_amount),
      equity: amount(equity?.row.frmtrm_amount),
    },
    {
      year,
      netIncome: amount(incomeAlt?.row.thstrm_amount),
      equity: amount(equity?.row.thstrm_amount),
    },
  ];

  return {
    code,
    name,
    corpCode,
    fiscalYear: year,
    basis,
    netIncome: history[2].netIncome,
    equity: history[2].equity,
    history,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) await fn(items[cursor++]);
    }),
  );
}

/** 임시 파일에 쓰고 rename — 도중에 죽어도 기존 파일이 반쯤 덮여 깨지지 않는다. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

async function main(): Promise<void> {
  const started = Date.now();

  assert(
    authKey.length > 0,
    ".env 파일에 DART_API_KEY가 없습니다. opendart.fss.or.kr에서 인증키를 발급받아 넣으세요.",
  );

  // 1. 대상 추리기 — daily.json에 있는 종목 중 '주식'만. ETF·ETN은 회사가 아니라
  //    여러 종목을 담은 그릇이라 재무제표 자체가 없다.
  const daily = JSON.parse(await readFile(DAILY_FILE, "utf8")) as {
    series: Record<string, { code: string; name: string; kind: string }>;
  };
  const targets = Object.values(daily.series).filter((s) => s.kind === "주식");
  assert(targets.length > 0, "daily.json에 개별 종목이 없습니다. 먼저 npm run collect:domestic을 실행하세요.");
  console.log(`대상 ${targets.length}종목 (ETF·ETN은 재무제표가 없어 제외)`);

  // 2. 종목코드 → DART 고유번호
  const corpCodes = await loadCorpCodes();

  // 3. 가장 최근에 나온 사업보고서를 찾는다. 오늘이 3월 이전이면 작년 보고서가
  //    아직 안 나왔을 수 있으므로 한 해씩 거슬러 시도한다.
  const thisYear = new Date().getFullYear();
  const companies: Record<string, Company> = {};
  const missing: Record<string, string> = {};

  await mapLimit(targets, CONCURRENCY, async (target) => {
    const mapped = corpCodes.get(target.code);
    if (!mapped) {
      missing[target.code] = "DART 고유번호 대응표에 없는 종목입니다.";
      return;
    }

    for (let back = 1; back <= YEAR_LOOKBACK; back++) {
      const year = String(thisYear - back);
      const res = await fetchAccounts(mapped.corpCode, year);
      if (res.status === "013") continue; // 해당 연도 자료 없음
      if (res.status !== "000") {
        missing[target.code] = `DART 응답 오류 (${res.status}): ${res.message ?? ""}`.trim();
        return;
      }
      const company = toCompany(target.code, target.name, mapped.corpCode, year, res.list ?? []);
      if (company) {
        companies[target.code] = company;
        console.log(
          `  ${target.name.padEnd(12)} ${year}년 ${company.basis}` +
            ` · 순이익 ${company.netIncome === null ? "—" : (company.netIncome / 1e8).toFixed(0) + "억"}` +
            ` · 자본 ${company.equity === null ? "—" : (company.equity / 1e8).toFixed(0) + "억"}`,
        );
        return;
      }
      missing[target.code] =
        "정기보고서에서 당기순이익·자본총계를 찾지 못했습니다. " +
        "은행·보험·증권 등 금융회사는 계정 이름이 달라 주요계정 API로 잡히지 않습니다.";
      return;
    }
    missing[target.code] = `최근 ${YEAR_LOOKBACK}개 사업연도에 제출된 사업보고서를 찾지 못했습니다.`;
  });

  // 4. 검증 — 절반도 못 받았다면 뭔가 잘못된 것이므로 기존 파일을 지키고 실패시킨다.
  const got = Object.keys(companies).length;
  assert(
    got * 2 >= targets.length,
    `${targets.length}종목 중 ${got}종목만 받았습니다. 인증키와 DART 응답을 확인하세요.`,
  );

  // 계정 이름이 어긋나면 '자료는 받았는데 숫자만 전부 빈' 상태가 조용히 만들어진다.
  // 실제로 "당기순이익(손실)" 표기를 놓쳐 한 번 겪은 일이라, 값이 채워졌는지 따로 본다.
  const withIncome = Object.values(companies).filter((c) => c.netIncome !== null).length;
  const withEquity = Object.values(companies).filter((c) => c.equity !== null).length;
  assert(
    withIncome * 2 >= got,
    `${got}종목 중 당기순이익이 ${withIncome}종목뿐입니다. DART 계정 이름 표기가 바뀌었는지 확인하세요.`,
  );
  assert(
    withEquity * 2 >= got,
    `${got}종목 중 자본총계가 ${withEquity}종목뿐입니다. DART 계정 이름 표기가 바뀌었는지 확인하세요.`,
  );
  for (const company of Object.values(companies)) {
    assert(company.history.length === 3, `${company.name}의 3개년 자료가 어긋납니다.`);
    assert(
      company.equity === null || company.equity > 0,
      `${company.name}의 자본총계가 0 이하입니다 (자본잠식이면 PBR을 쓸 수 없습니다).`,
    );
  }

  const payload: Payload = {
    generatedAt: kstNowIso(),
    source: "금융감독원 전자공시시스템(DART) OpenAPI · 사업보고서 주요계정",
    companies,
    missing,
  };
  await writeJson(OUT_FILE, payload);

  console.log(`\n→ ${path.relative(ROOT, OUT_FILE)} 갱신 완료 (${got}/${targets.length}종목)`);
  for (const [code, reason] of Object.entries(missing)) console.log(`   못 받음 ${code}: ${reason}`);
  console.log(`\n소요 ${((Date.now() - started) / 1000).toFixed(1)}초`);
}

main().catch((err) => {
  console.error(`\n수집 실패: ${err instanceof Error ? err.message : String(err)}`);
  console.error("기존 fundamentals.json은 그대로 두었습니다.");
  process.exitCode = 1;
});
