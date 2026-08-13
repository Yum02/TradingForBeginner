/**
 * 기술적 신호 — "지금 이 종목의 분위기가 매수 쪽인가 매도 쪽인가"를 재는 계산기.
 *
 * 여기서 다루는 것은 전부 주가와 거래량뿐이다. 회사가 돈을 얼마나 버는지, 무슨 뉴스가
 * 있었는지는 하나도 들어가지 않는다. 그래서 이 파일이 내놓는 결과는 "판단"이 아니라
 * "지금 차트가 어떤 모양인지 읽어준 것"에 가깝다. 화면에서도 그렇게 표현해야 한다.
 *
 * 지표 구성은 인베스팅닷컴·트레이딩뷰의 '기술적 요약'과 토스증권이 초보자에게 권하는
 * 기본 지표(이동평균선·MACD·RSI)를 따랐다. 여기서 익힌 이름이 실제 증권사 앱에서
 * 그대로 통하게 하려는 의도다. 지표를 더 넣을수록 정확해지지는 않고, 서로 비슷한
 * 지표가 같은 신호를 여러 번 세면 오히려 한쪽으로 쏠린다. 그래서 성격이 겹치지 않는
 * 다섯 개(추세 3 + 오실레이터 2)만 점수에 넣는다.
 *
 * 모든 계산은 빌드 타임에 한 번 돌고 결과가 HTML로 굳는다. 브라우저에서는 자바스크립트가
 * 한 줄도 돌지 않는다.
 */
import type { DayBar, StockSeries } from "./index";

export const SHORT_MA = 5;
export const MID_MA = 20;
export const LONG_MA = 60;
export const RSI_PERIOD = 14;
/** 교차를 "최근에 일어났다"고 볼 영업일 수. 2주쯤 지나면 새 소식이라 하기 어렵다. */
export const CROSS_WINDOW = 10;
/**
 * 두 선이 사실상 붙어 있는데 소수점 차이로 방향을 단정하지 않도록 두는 무시 구간.
 * 이만큼 안쪽이면 중립으로 본다.
 */
const FLAT_BAND = 0.005;
/** 이 개수보다 적게 계산되면(상장 직후 등) 종합 판정을 내리지 않는다. */
const MIN_SIGNALS = 3;

// ── 지표 계산 ───────────────────────────────────────────────────────────────
// 모든 함수는 입력과 길이가 같은 배열을 돌려주고, 아직 계산할 수 없는 앞부분은 null이다.
// 인덱스를 그대로 맞춰 두면 "며칠 전에 교차했는지" 같은 걸 세기 쉽다.

/** 단순이동평균 — 최근 period일 종가의 산술평균. 흔히 말하는 '20일선'이 이것이다. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/**
 * 지수이동평균 — 최근 값에 더 큰 가중치를 준다. MACD가 이 방식을 쓴다.
 * 첫 값은 앞 period개의 단순평균으로 시작하는 게 관행이다.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let prev = acc / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

const toRsi = (avgGain: number, avgLoss: number) =>
  avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

/**
 * RSI — 최근 period일 동안 오른 날의 상승폭과 내린 날의 하락폭을 견줘 0~100으로 나타낸다.
 * 원안(Wilder)대로 첫 값만 단순평균으로 잡고 이후는 지수적으로 누적한다.
 */
export function rsi(closes: number[], period = RSI_PERIOD): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface Macd {
  /** 12일 EMA − 26일 EMA */
  line: (number | null)[];
  /** MACD선의 9일 EMA */
  signal: (number | null)[];
  /** line − signal. 부호가 바뀌는 지점이 교차다. */
  hist: (number | null)[];
}

/** MACD(12, 26, 9) — 짧은 평균과 긴 평균의 벌어진 정도로 추세 전환을 본다. */
export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f !== null && s !== null ? f - s : null;
  });

  // 시그널선은 MACD선의 EMA다. 앞쪽 null을 잘라내고 계산한 뒤 원래 자리에 돌려놓는다.
  const start = line.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  if (start >= 0) {
    const dense = line.slice(start) as number[];
    const smoothed = ema(dense, signalPeriod);
    for (let i = 0; i < smoothed.length; i++) signal[start + i] = smoothed[i];
  }

  const hist = line.map((v, i) => {
    const s = signal[i];
    return v !== null && s !== null ? v - s : null;
  });
  return { line, signal, hist };
}

// ── 신호 ────────────────────────────────────────────────────────────────────

/** 한 지표가 가리키는 방향. unknown은 데이터가 모자라 계산 자체를 못 한 경우다. */
export type Stance = "buy" | "sell" | "neutral" | "unknown";

export interface Signal {
  id: string;
  /** 지표 이름 — 증권사 앱에서 쓰는 말 그대로 */
  name: string;
  /** 지금 상태를 짧게 — "20일 평균보다 3.2% 위" */
  headline: string;
  /** 그렇게 본 근거가 되는 실제 숫자 */
  detail: string;
  /** 이 지표가 대체 무엇을 보는 것인지 — 초보자에게는 이쪽이 결론보다 중요하다 */
  meaning: string;
  stance: Stance;
  /** 종합 점수에 더할 값. buy +1, sell −1, 나머지 0 */
  score: number;
}

/** 점수에는 넣지 않지만 함께 봐야 하는 숫자들 */
export interface Fact {
  label: string;
  value: string;
  note: string;
}

export type VerdictKey = "strong-buy" | "buy" | "neutral" | "sell" | "strong-sell" | "unknown";

export interface Verdict {
  key: VerdictKey;
  /** 상세 페이지에 크게 나가는 문구 */
  label: string;
  /** 순위표 배지처럼 좁은 자리에 쓰는 짧은 문구 */
  short: string;
  /** 왜 그렇게 나왔는지 한 문장 */
  summary: string;
  /** 게이지 눈금 위치 0(매도 끝) ~ 100(매수 끝) */
  position: number;
}

export interface Analysis {
  signals: Signal[];
  facts: Fact[];
  /** 매수 신호 개수 − 매도 신호 개수 */
  score: number;
  /** 실제로 계산된 지표 수 (unknown 제외) */
  counted: number;
  buyCount: number;
  sellCount: number;
  verdict: Verdict;
  /** 지표 계산에 실제로 쓴 영업일 수 */
  bars: number;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const round = (n: number) => Math.round(n).toLocaleString("ko-KR");
const won = (n: number) => `${round(n)}원`;

/** 두 값의 차이를 %로. 기준값이 0이면 비교 자체가 무의미하므로 0으로 본다. */
const gap = (value: number, base: number) => (base === 0 ? 0 : (value - base) / base);

/** 무시 구간(FLAT_BAND) 밖으로 벌어졌을 때만 방향을 단정한다. */
function stanceFromGap(ratio: number, band = FLAT_BAND): Stance {
  if (ratio > band) return "buy";
  if (ratio < -band) return "sell";
  return "neutral";
}

const scoreOf = (stance: Stance) => (stance === "buy" ? 1 : stance === "sell" ? -1 : 0);

function unknown(id: string, name: string, meaning: string, need: string): Signal {
  return {
    id,
    name,
    headline: "계산할 수 없음",
    detail: `${need} 상장한 지 얼마 되지 않았거나 거래가 없던 날이 많은 종목입니다.`,
    meaning,
    stance: "unknown",
    score: 0,
  };
}

/**
 * 마지막으로 두 선의 위아래가 뒤바뀐 시점을 찾는다.
 * 돌려주는 값은 "며칠 전이었나"(0이면 오늘)이고, 기간 안에 교차가 없으면 null이다.
 */
function lastCrossAgo(a: (number | null)[], b: (number | null)[]): number | null {
  const end = a.length - 1;
  const sign = (i: number) => {
    const x = a[i];
    const y = b[i];
    return x === null || y === null ? null : Math.sign(x - y);
  };
  const now = sign(end);
  if (now === null || now === 0) return null;
  for (let i = end - 1; i >= 0; i--) {
    const s = sign(i);
    if (s === null) return null; // 지표가 시작되기 전까지 왔다 = 이 구간에 교차 없음
    if (s !== 0 && s !== now) return end - i;
  }
  return null;
}

/** 배열의 마지막 유효값 */
const lastOf = (values: (number | null)[]): number | null => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i];
  return null;
};

const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

// ── 다섯 개 신호 ────────────────────────────────────────────────────────────

function trendSignal(close: number, ma20: number | null): Signal {
  const meaning =
    "20일 평균선은 최근 한 달 동안 이 종목을 산 사람들의 평균 매입가에 가깝습니다. " +
    "주가가 그 위에 있으면 최근 한 달 사이 산 사람 대부분이 이익 구간이라 팔려는 압박이 약하고, " +
    "아래에 있으면 반대로 본전을 기다리는 물량이 위에 쌓여 있다고 봅니다.";
  if (ma20 === null) return unknown("trend", "주가와 20일 평균선", meaning, `20일치 시세가 필요합니다.`);

  const ratio = gap(close, ma20);
  const stance = stanceFromGap(ratio);
  return {
    id: "trend",
    name: "주가와 20일 평균선",
    headline:
      stance === "buy"
        ? `20일 평균선 위 (${pct(ratio * 100)})`
        : stance === "sell"
          ? `20일 평균선 아래 (${pct(ratio * 100)})`
          : "20일 평균선에 딱 붙어 있음",
    detail: `현재가 ${won(close)} · 20일 평균 ${won(ma20)}`,
    meaning,
    stance,
    score: scoreOf(stance),
  };
}

function alignmentSignal(ma20: number | null, ma60: number | null): Signal {
  const meaning =
    "짧은 평균선이 긴 평균선보다 위에 있는 상태를 정배열, 그 반대를 역배열이라고 부릅니다. " +
    "정배열은 최근 한 달의 가격대가 지난 석 달 평균보다 높다는 뜻이라 오름세가 이어지는 중이라고 읽고, " +
    "역배열은 내림세가 자리 잡았다고 읽습니다.";
  if (ma20 === null || ma60 === null)
    return unknown("alignment", "20일선과 60일선의 배열", meaning, "60일치 시세가 필요합니다.");

  const ratio = gap(ma20, ma60);
  const stance = stanceFromGap(ratio);
  return {
    id: "alignment",
    name: "20일선과 60일선의 배열",
    headline: stance === "buy" ? "정배열 (20일선이 위)" : stance === "sell" ? "역배열 (60일선이 위)" : "두 선이 엉켜 있음",
    detail: `20일 평균 ${won(ma20)} · 60일 평균 ${won(ma60)} · 차이 ${pct(ratio * 100)}`,
    meaning,
    stance,
    score: scoreOf(stance),
  };
}

function crossSignal(ma5: (number | null)[], ma20: (number | null)[]): Signal {
  const meaning =
    "5일 평균선이 20일 평균선을 아래에서 위로 뚫는 것을 골든크로스, 위에서 아래로 뚫는 것을 데드크로스라고 합니다. " +
    "짧은 흐름이 긴 흐름을 앞질렀다는 뜻이라 방향이 바뀌는 자리로 자주 인용되지만, " +
    "이미 오르고 난 뒤에 나타나는 경우도 많아 이것 하나만 보고 들어가면 늦습니다.";
  const a = lastOf(ma5);
  const b = lastOf(ma20);
  if (a === null || b === null)
    return unknown("cross", "골든크로스 · 데드크로스", meaning, "20일치 시세가 필요합니다.");

  const ratio = gap(a, b);
  const stance = stanceFromGap(ratio, FLAT_BAND / 2);
  const ago = lastCrossAgo(ma5, ma20);
  const fresh = ago !== null && ago <= CROSS_WINDOW;
  const crossName = stance === "buy" ? "골든크로스" : "데드크로스";

  return {
    id: "cross",
    name: "골든크로스 · 데드크로스",
    headline: fresh
      ? `${ago}영업일 전 ${crossName} 발생`
      : stance === "buy"
        ? "5일선이 20일선 위에 자리 잡음"
        : stance === "sell"
          ? "5일선이 20일선 아래에 자리 잡음"
          : "5일선과 20일선이 겹쳐 있음",
    detail:
      `5일 평균 ${won(a)} · 20일 평균 ${won(b)}` +
      (ago === null ? " · 최근에 교차한 적 없음" : ` · 마지막 교차 ${ago}영업일 전`),
    meaning,
    stance,
    score: scoreOf(stance),
  };
}

function rsiSignal(value: number | null): Signal {
  const meaning =
    "최근 14일 동안 오른 날의 힘과 내린 날의 힘을 견줘 0~100으로 나타낸 값입니다. " +
    "70을 넘으면 짧은 사이에 너무 많이 올라 한 번 쉬어갈 수 있다고 보고, 30 밑이면 너무 많이 빠졌다고 봅니다. " +
    "다만 세게 오르는 종목은 70 위에 몇 주씩 머물기도 하므로, 70이 넘었다고 곧 떨어진다는 뜻은 아닙니다.";
  if (value === null) return unknown("rsi", `RSI (${RSI_PERIOD}일)`, meaning, "15일치 시세가 필요합니다.");

  const stance: Stance = value >= 70 ? "sell" : value <= 30 ? "buy" : "neutral";
  return {
    id: "rsi",
    name: `RSI (${RSI_PERIOD}일)`,
    headline:
      value >= 70
        ? `${value.toFixed(1)} · 과매수 구간`
        : value <= 30
          ? `${value.toFixed(1)} · 과매도 구간`
          : `${value.toFixed(1)} · 중립 구간`,
    detail: `${value.toFixed(1)} / 100 · 30 이하 과매도 · 70 이상 과매수`,
    meaning,
    stance,
    score: scoreOf(stance),
  };
}

function macdSignal(line: number | null, signal: number | null, hist: number | null): Signal {
  const meaning =
    "12일 평균과 26일 평균의 벌어진 정도(MACD선)를 그리고, 다시 그것의 9일 평균(시그널선)과 견줍니다. " +
    "MACD선이 시그널선 위로 올라오면 오르는 힘이 붙는 중, 아래로 내려가면 힘이 빠지는 중으로 읽습니다. " +
    "이동평균선보다 방향 전환을 조금 빨리 알려주는 대신 헛신호도 그만큼 잦습니다.";
  if (line === null || signal === null || hist === null)
    return unknown("macd", "MACD (12·26·9)", meaning, "35일치 시세가 필요합니다.");

  const stance: Stance = hist > 0 ? "buy" : hist < 0 ? "sell" : "neutral";
  return {
    id: "macd",
    name: "MACD (12·26·9)",
    headline: stance === "buy" ? "MACD선이 시그널선 위" : stance === "sell" ? "MACD선이 시그널선 아래" : "두 선이 겹침",
    // 주가 단위를 그대로 물려받아 값이 커진다. 소수점보다 자릿수 구분이 읽기 쉽다.
    detail: `MACD ${round(line)} · 시그널 ${round(signal)} · 차이 ${hist >= 0 ? "+" : ""}${round(hist)}`,
    meaning,
    stance,
    score: scoreOf(stance),
  };
}

// ── 참고 수치 ───────────────────────────────────────────────────────────────

function buildFacts(days: DayBar[]): Fact[] {
  const facts: Fact[] = [];
  const last = days[days.length - 1];
  const recent = days.slice(-SHORT_MA);
  const base = days.slice(-LONG_MA);

  // 거래량이 평소보다 많다는 건 뭔가 벌어지고 있다는 뜻이다. 방향까지 알려주지는 않는다.
  const recentVol = mean(recent.map((d) => d.volume));
  const baseVol = mean(base.map((d) => d.volume));
  if (baseVol > 0) {
    // 화면에 "0.7배"라고 적어놓고 문구는 "비슷합니다"가 되지 않도록, 반올림해서
    // 보여줄 바로 그 값으로 판정한다.
    const times = Number((recentVol / baseVol).toFixed(1));
    facts.push({
      label: "거래량",
      value: `평소의 ${times.toFixed(1)}배`,
      note:
        times >= 1.5
          ? `최근 ${SHORT_MA}영업일 거래량이 ${base.length}영업일 평균보다 눈에 띄게 많습니다. 관심이 몰렸다는 뜻이지 오른다는 뜻은 아닙니다.`
          : times <= 0.7
            ? `최근 ${SHORT_MA}영업일 거래량이 평소보다 적습니다. 사람들의 관심이 식은 구간입니다.`
            : `최근 ${SHORT_MA}영업일 거래량이 ${base.length}영업일 평균과 비슷합니다.`,
    });
  }

  // 지금 가격이 6개월 박스의 어디쯤인지. 고점 근처면 비싸게 사는 것이고, 저점 근처면
  // 싼 것일 수도 있고 그럴 만한 이유가 있는 것일 수도 있다.
  const high = Math.max(...days.map((d) => d.high));
  const low = Math.min(...days.map((d) => d.low));
  const span = high - low;
  facts.push({
    label: `최근 ${Math.round(days.length / 21)}개월 가격대에서의 위치`,
    value: span === 0 ? "변동 없음" : `${Math.round(((last.close - low) / span) * 100)}%`,
    note: `가장 낮았던 ${won(low)}을 0%, 가장 높았던 ${won(high)}을 100%로 놓았을 때의 자리입니다.`,
  });

  const swing = mean(days.map((d) => Math.abs(d.changeRate)));
  facts.push({
    label: "하루 평균 등락폭",
    value: `${swing.toFixed(2)}%`,
    note:
      swing >= 3
        ? "하루에도 크게 출렁이는 종목입니다. 같은 금액을 넣어도 마음고생이 훨씬 큽니다."
        : "이 정도가 이 종목의 평소 하루 변동폭입니다. 이보다 크게 움직인 날에는 이유가 있었다는 뜻입니다.",
  });

  const first = days[0].close;
  facts.push({
    label: "수집 기간 전체 등락률",
    value: pct(first === 0 ? 0 : ((last.close - first) / first) * 100),
    note: `${days.length}영업일 전 ${won(first)}에서 ${won(last.close)}이 됐습니다.`,
  });

  return facts;
}

// ── 종합 ────────────────────────────────────────────────────────────────────

const VERDICTS: Record<Exclude<VerdictKey, "unknown">, { label: string; short: string }> = {
  "strong-buy": { label: "매수 신호가 뚜렷하게 우세", short: "매수 우세" },
  buy: { label: "매수 쪽으로 조금 기울어 있음", short: "약한 매수" },
  neutral: { label: "어느 쪽도 아닌 중립", short: "중립" },
  sell: { label: "매도 쪽으로 조금 기울어 있음", short: "약한 매도" },
  "strong-sell": { label: "매도 신호가 뚜렷하게 우세", short: "매도 우세" },
};

/**
 * 다섯 신호를 합쳐 한 줄 결론을 만든다.
 *
 * 단순 합계가 아니라 "계산된 지표 수로 나눈 비율"을 쓴다. 상장 직후라 60일선이 없는
 * 종목은 지표가 셋뿐인데, 그때 합계 −2를 다섯 개짜리와 같은 잣대로 재면 실제보다
 * 약하게 나오기 때문이다.
 */
function toVerdict(score: number, counted: number, buyCount: number, sellCount: number): Verdict {
  if (counted < MIN_SIGNALS) {
    return {
      key: "unknown",
      label: "판단을 내리기에 자료가 모자람",
      short: "자료 부족",
      summary: `계산할 수 있는 지표가 ${counted}개뿐입니다. 상장한 지 얼마 되지 않은 종목은 과거 시세가 짧아 이런 계산이 잘 맞지 않습니다.`,
      position: 50,
    };
  }

  const ratio = score / counted;
  const key: Exclude<VerdictKey, "unknown"> =
    ratio >= 0.6 ? "strong-buy" : ratio >= 0.2 ? "buy" : ratio > -0.2 ? "neutral" : ratio > -0.6 ? "sell" : "strong-sell";

  return {
    ...VERDICTS[key],
    key,
    summary: `지표 ${counted}개 가운데 매수 쪽 ${buyCount}개, 매도 쪽 ${sellCount}개, 중립 ${counted - buyCount - sellCount}개입니다.`,
    position: Math.round(((ratio + 1) / 2) * 100),
  };
}

/** 종목 하나의 전체 분석. days는 반드시 날짜 오름차순이어야 한다. */
export function analyze(series: StockSeries): Analysis {
  const days = series.days;
  const closes = days.map((d) => d.close);
  const last = closes[closes.length - 1];

  const ma5 = sma(closes, SHORT_MA);
  const ma20 = sma(closes, MID_MA);
  const ma60 = sma(closes, LONG_MA);
  const rsiValues = rsi(closes);
  const { line, signal, hist } = macd(closes);

  const signals: Signal[] = [
    trendSignal(last, lastOf(ma20)),
    alignmentSignal(lastOf(ma20), lastOf(ma60)),
    crossSignal(ma5, ma20),
    rsiSignal(lastOf(rsiValues)),
    macdSignal(lastOf(line), lastOf(signal), lastOf(hist)),
  ];

  const scored = signals.filter((s) => s.stance !== "unknown");
  const score = scored.reduce((sum, s) => sum + s.score, 0);
  const buyCount = scored.filter((s) => s.stance === "buy").length;
  const sellCount = scored.filter((s) => s.stance === "sell").length;

  return {
    signals,
    facts: buildFacts(days),
    score,
    counted: scored.length,
    buyCount,
    sellCount,
    verdict: toVerdict(score, scored.length, buyCount, sellCount),
    bars: days.length,
  };
}
