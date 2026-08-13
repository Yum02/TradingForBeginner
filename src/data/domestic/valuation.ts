/**
 * 기업 가치 지표 — "이 회사가 얼마짜리이고, 지금 값이 그 실력에 비해 어떤가".
 *
 * 앞선 기술적 신호가 '가격이 어떻게 움직였나'를 봤다면 여기는 '값어치가 얼마인가'를 본다.
 * 파는 이유 중 하나가 "값이 너무 비싸졌을 때"인데, 그 판단은 차트로는 절대 할 수 없다.
 *
 * 재료가 두 군데서 온다.
 *   시가총액·상장주식수·순자산가치 → KRX (daily.json)
 *   당기순이익·자본총계            → DART 사업보고서 (fundamentals.json)
 * 두 자료의 기준일이 다르다는 점이 중요하다. 시가총액은 어제 종가 기준이고 순이익은
 * 작년 한 해 실적이다. 그래서 화면에는 반드시 "몇 년 실적 기준"인지 함께 적는다.
 *
 * 설계에서 가장 신경 쓴 것은 **숫자만 던져놓지 않는 것**이다. 초보자가 가장 흔히 하는
 * 실수가 "PER 10이면 싸고 25면 비싸다"고 외우는 것인데, 비교 기준이 없는 배수는 아무
 * 뜻이 없다. 평소 30배에 거래되던 회사의 25배는 싼 것이고, 평소 8배이던 회사의 10배는
 * 비싼 것이다. 그래서 이 파일은 값을 계산하되 좋다·나쁘다로 색칠하지 않고, 무엇과
 * 비교해야 하는지를 문장으로 알려주는 데 무게를 둔다.
 */
import type { Kind, StockSeries } from "./index";
import rawFundamentals from "./fundamentals.json";

/** 한 해치 재무 숫자 */
export interface YearFigure {
  year: string;
  netIncome: number | null;
  equity: number | null;
}

export interface Company {
  code: string;
  name: string;
  corpCode: string;
  fiscalYear: string;
  basis: "연결" | "별도";
  netIncome: number | null;
  equity: number | null;
  history: YearFigure[];
}

export interface Fundamentals {
  generatedAt: string | null;
  source: string;
  companies: Record<string, Company>;
  /** 종목코드 → 자료를 얻지 못한 이유 */
  missing: Record<string, string>;
}

export const fundamentals = rawFundamentals as unknown as Fundamentals;

/** 재무 자료가 하나라도 모였는지. 아직 수집 전이면 밸류에이션 화면을 접어둔다. */
export const hasFundamentals = Object.keys(fundamentals.companies).length > 0;

export function getCompany(code: string): Company | undefined {
  return fundamentals.companies[code];
}

// ── 표시용 숫자 ─────────────────────────────────────────────────────────────

const KO = "ko-KR";

/**
 * 큰 금액을 조·억 단위로. 1,493,724,184,344,000 → "1,493조 7,242억"
 * 초보자가 "몇 조인지" 바로 읽을 수 있게 조와 억을 같이 적는다.
 */
export function formatMoney(won: number): string {
  const negative = won < 0;
  const abs = Math.abs(won);
  const jo = Math.floor(abs / 1e12);
  const eok = Math.floor((abs % 1e12) / 1e8);
  const sign = negative ? "-" : "";
  if (jo > 0) return `${sign}${jo.toLocaleString(KO)}조${eok > 0 ? ` ${eok.toLocaleString(KO)}억` : ""}`;
  if (eok > 0) return `${sign}${eok.toLocaleString(KO)}억`;
  return `${sign}${Math.round(abs).toLocaleString(KO)}`;
}

const ratio = (n: number) => `${n.toFixed(2)}배`;

// ── 지표 ────────────────────────────────────────────────────────────────────

/** 화면에 한 칸씩 놓이는 지표 하나 */
export interface Metric {
  key: string;
  label: string;
  /** 계산된 값. 계산이 불가능하면 null이고 note에 이유를 적는다. */
  value: string | null;
  /** 값 아래 붙는 근거 — 어떤 숫자를 어떻게 나눴는지 */
  detail: string;
  /** 이 지표가 무엇을 뜻하는지, 어떻게 읽어야 하는지 */
  meaning: string;
}

export interface Valuation {
  kind: Kind;
  /** 개별 주식이면 PER·PBR, ETF·ETN이면 괴리율이 들어간다 */
  metrics: Metric[];
  /** 3개년 순이익 흐름. 개별 주식이고 자료가 있을 때만 */
  trend: ProfitTrend | null;
  /** 재무 자료를 못 받았을 때의 이유 */
  unavailable: string | null;
  /** 어느 사업연도 실적을 썼는지 — 출처 표기용 */
  fiscalYear: string | null;
  basis: "연결" | "별도" | null;
}

export interface ProfitTrend {
  years: YearFigure[];
  /** "3년째 늘고 있습니다" 같은 한 줄 판정 */
  headline: string;
  direction: "up" | "down" | "mixed" | "loss";
  note: string;
}

/** 시가총액은 종목 종류와 무관하게 늘 보여준다 — "이 회사가 통째로 얼마인가" */
function marketCapMetric(series: StockSeries): Metric {
  const isFund = series.kind !== "주식";
  return {
    key: "cap",
    label: "시가총액",
    value: `${formatMoney(series.marketCap)}원`,
    detail: `상장주식수 ${series.listedShares.toLocaleString(KO)}주 × 기준일 종가`,
    meaning: isFund
      ? "이 상품에 모여 있는 돈의 크기입니다. 클수록 사고팔 때 원하는 가격에 체결되기 쉽습니다."
      : "이 회사를 통째로 사려면 치러야 하는 값입니다. 주가가 비싸 보여도 시가총액이 작으면 작은 회사이고, " +
        "주가가 싸 보여도 시가총액이 크면 큰 회사입니다. 주가 하나만으로 회사 크기를 짐작하면 안 되는 이유입니다.",
  };
}

function perMetric(series: StockSeries, company: Company | undefined): Metric {
  const meaning =
    "지금 값으로 이 회사를 사면, 회사가 지금처럼 벌어서 원금을 되돌려주는 데 몇 해가 걸리는지를 나타냅니다. " +
    "PER 10배면 열 해치 이익에 해당하는 값이 붙어 있다는 뜻입니다. " +
    "다만 낮다고 싼 것이 아닙니다. 앞으로 이익이 줄어들 회사는 원래 낮게 거래되고, 빠르게 크는 회사는 높게 거래됩니다. " +
    "같은 업종의 다른 회사, 그리고 이 회사가 예전에 몇 배에 거래됐는지와 견줘야 뜻이 생깁니다.";
  const eps = company?.netIncome != null && series.listedShares > 0 ? company.netIncome / series.listedShares : null;

  if (!company || company.netIncome == null) {
    return { key: "per", label: "PER (주가수익비율)", value: null, detail: "순이익 자료가 없습니다.", meaning };
  }
  if (company.netIncome <= 0) {
    return {
      key: "per",
      label: "PER (주가수익비율)",
      value: null,
      detail: `${company.fiscalYear}년 당기순이익이 ${formatMoney(company.netIncome)}원으로 적자입니다.`,
      meaning:
        meaning +
        " 적자인 회사는 나눌 이익이 없어 PER 자체가 나오지 않습니다. 이럴 때는 이익 대신 매출이나 자본을 봅니다.",
    };
  }

  const per = series.marketCap / company.netIncome;
  return {
    key: "per",
    label: "PER (주가수익비율)",
    value: ratio(per),
    detail:
      `시가총액 ${formatMoney(series.marketCap)}원 ÷ ${company.fiscalYear}년 순이익 ${formatMoney(company.netIncome)}원` +
      (eps ? ` · 한 주당 순이익(EPS) ${Math.round(eps).toLocaleString(KO)}원` : ""),
    meaning,
  };
}

function pbrMetric(series: StockSeries, company: Company | undefined): Metric {
  const meaning =
    "회사가 지금 당장 문을 닫고 빚을 다 갚았을 때 주주에게 남는 몫에 견줘, 지금 값이 몇 배인지를 나타냅니다. " +
    "1배면 남는 몫만큼의 값이 붙어 있다는 뜻이고, 1배 아래면 장부상 남는 것보다 싸게 거래된다는 뜻입니다. " +
    "다만 공장과 땅이 많은 회사는 원래 높게 나오기 어렵고, 사람과 기술이 자산인 회사는 장부에 잡히는 것이 적어 " +
    "높게 나옵니다. 업종이 다르면 아예 비교가 되지 않습니다.";
  const bps = company?.equity != null && series.listedShares > 0 ? company.equity / series.listedShares : null;

  if (!company || company.equity == null || company.equity <= 0) {
    return { key: "pbr", label: "PBR (주가순자산비율)", value: null, detail: "자본총계 자료가 없습니다.", meaning };
  }

  const pbr = series.marketCap / company.equity;
  return {
    key: "pbr",
    label: "PBR (주가순자산비율)",
    value: ratio(pbr),
    detail:
      `시가총액 ${formatMoney(series.marketCap)}원 ÷ ${company.fiscalYear}년 자본총계 ${formatMoney(company.equity)}원` +
      (bps ? ` · 한 주당 순자산(BPS) ${Math.round(bps).toLocaleString(KO)}원` : ""),
    meaning,
  };
}

/**
 * ETF·ETN에는 PER·PBR이 없다. 회사가 아니라 여러 종목을 담은 그릇이기 때문이다.
 * 대신 "담긴 것의 값어치(순자산가치)"와 시장에서 붙은 값을 견주는 괴리율이 같은 자리를
 * 대신한다. 사실 초보자에게는 이쪽이 더 직접적이다 — 만 원짜리를 만 오백 원에 사는지
 * 바로 보이기 때문이다.
 */
function navMetrics(series: StockSeries): Metric[] {
  const last = series.days[series.days.length - 1];
  const navLabel = series.kind === "ETF" ? "순자산가치(NAV)" : "증권당 지표가치";
  const meaningBase =
    series.kind === "ETF"
      ? "이 ETF가 담고 있는 주식들을 다 팔면 한 주당 얼마가 되는지를 나타낸 값입니다."
      : "이 ETN이 약속한 지수를 그대로 따라갔을 때 한 증권이 가져야 할 값입니다.";

  if (!(series.nav > 0)) {
    return [
      {
        key: "nav",
        label: navLabel,
        value: null,
        detail: "거래소가 이 종목의 값을 제공하지 않았습니다.",
        meaning: meaningBase,
      },
    ];
  }

  const gap = ((last.close - series.nav) / series.nav) * 100;
  const rich = gap > 0;
  return [
    {
      key: "nav",
      label: navLabel,
      value: `${Math.round(series.nav).toLocaleString(KO)}원`,
      detail: `기준일 종가는 ${last.close.toLocaleString(KO)}원입니다.`,
      meaning: `${meaningBase} 개별 주식의 PER·PBR이 하는 역할을 ETF·ETN에서는 이 값이 대신합니다.`,
    },
    {
      key: "gap",
      label: "괴리율",
      value: `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}%`,
      detail: rich
        ? `실제 값어치보다 ${Math.abs(gap).toFixed(2)}% 비싸게 거래되고 있습니다.`
        : `실제 값어치보다 ${Math.abs(gap).toFixed(2)}% 싸게 거래되고 있습니다.`,
      meaning:
        "담긴 것의 값어치와 시장에서 붙은 값의 차이입니다. 0에 가까울수록 제값에 거래되는 것이고, " +
        "플러스가 크면 그만큼 웃돈을 주고 사는 셈이라 그 웃돈이 사라질 때 손해를 봅니다. " +
        "보통 ±1% 안쪽이면 정상으로 보고, 거래가 뜸한 종목일수록 크게 벌어집니다.",
    },
  ];
}

/** 3개년 순이익 흐름 — "이익이 늘고 있나 줄고 있나"는 PER 한 숫자보다 중요하다. */
function profitTrend(company: Company): ProfitTrend | null {
  const years = company.history.filter((y) => y.netIncome !== null);
  if (years.length < 2) return null;

  const values = years.map((y) => y.netIncome as number);
  const anyLoss = values.some((v) => v <= 0);
  const rising = values.every((v, i) => i === 0 || v > values[i - 1]);
  const falling = values.every((v, i) => i === 0 || v < values[i - 1]);

  const first = values[0];
  const last = values[values.length - 1];
  const direction: ProfitTrend["direction"] = anyLoss ? "loss" : rising ? "up" : falling ? "down" : "mixed";

  const headline = anyLoss
    ? "적자였던 해가 있습니다"
    : rising
      ? `${years.length}년째 이익이 늘고 있습니다`
      : falling
        ? `${years.length}년째 이익이 줄고 있습니다`
        : "이익이 늘었다 줄었다 합니다";

  const note = anyLoss
    ? "적자와 흑자를 오가는 회사는 PER이 해마다 크게 흔들려 그 숫자만으로는 비싼지 싼지 알기 어렵습니다."
    : direction === "down"
      ? "이익이 계속 줄고 있다면 지금의 PER은 앞으로 더 높아진다는 뜻입니다. 값이 싸 보이는 이유가 여기 있을 수 있습니다."
      : direction === "up"
        ? `${years[0].year}년 ${formatMoney(first)}원에서 ${years[years.length - 1].year}년 ${formatMoney(last)}원이 됐습니다. ` +
          "이익이 늘고 있는 회사는 높은 PER이 정당화되기도 합니다."
        : "한두 해 실적이 들쭉날쭉한 것은 흔한 일입니다. 중요한 것은 몇 년에 걸친 방향입니다.";

  return { years, headline, direction, note };
}

export function analyzeValuation(series: StockSeries): Valuation {
  const company = getCompany(series.code);

  if (series.kind !== "주식") {
    return {
      kind: series.kind,
      metrics: [marketCapMetric(series), ...navMetrics(series)],
      trend: null,
      unavailable: null,
      fiscalYear: null,
      basis: null,
    };
  }

  // 재무 자료를 한 건도 받지 못한 상태(수집 전)라면 "계산 불가" 카드를 두 장 늘어놓는
  // 대신 아예 접어둔다. 고장 난 화면처럼 보이지 않게 하려는 것이다.
  if (!hasFundamentals) {
    return {
      kind: series.kind,
      metrics: [marketCapMetric(series)],
      trend: null,
      unavailable:
        "PER·PBR은 회사가 한 해 얼마를 벌었는지(당기순이익)와 회사에 남은 몫이 얼마인지(자본총계)를 알아야 " +
        "계산할 수 있는데, 그 숫자는 거래소가 아니라 전자공시(DART)에 있습니다. 아직 그 자료를 수집하지 않았습니다.",
      fiscalYear: null,
      basis: null,
    };
  }

  const missingReason = fundamentals.missing[series.code] ?? null;
  return {
    kind: series.kind,
    metrics: [marketCapMetric(series), perMetric(series, company), pbrMetric(series, company)],
    trend: company ? profitTrend(company) : null,
    unavailable: company ? null : (missingReason ?? "아직 재무 자료를 수집하지 않았습니다."),
    fiscalYear: company?.fiscalYear ?? null,
    basis: company?.basis ?? null,
  };
}
