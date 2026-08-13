/**
 * 캔들 한 개 읽기 — 몸통과 꼬리의 비율로 그날 무슨 일이 있었는지 이름 붙이기.
 *
 * 캔들 하나에는 시가·고가·저가·종가 네 값이 들어 있고, 그 넷의 배치가 그날의 심리
 * 싸움을 보여준다. 몸통이 길면 한쪽이 이긴 날이고, 꼬리가 길면 밀고 당기다 되돌아온
 * 날이다. 이름(장대양봉·도지·망치형…)은 증권사 앱과 입문 자료가 공통으로 쓰는 것을
 * 그대로 따랐다. 여기서 익힌 말이 다른 곳에서도 통해야 쓸모가 있기 때문이다.
 *
 * 주의해서 다룬 것이 두 가지 있다.
 *
 * 첫째, 같은 모양이라도 **어디서 나왔는지에 따라 이름이 달라진다.** 몸통 위에 긴
 * 아래꼬리가 달린 모양은 하락 끝에 나오면 망치형(반등 신호로 읽음), 상승 끝에 나오면
 * 교수형(하락 전환 신호로 읽음)이다. 그래서 직전 흐름을 함께 본다.
 *
 * 둘째, **캔들 색과 전일 대비 등락은 다른 것을 잰다.** 색은 그날 시가와 견준 것이고,
 * 등락률은 전날 종가와 견준 것이다. 전날보다 훨씬 낮게 출발해 조금 회복하면 빨간 캔들인데
 * 전일 대비는 마이너스가 된다. 실제로 이 사이트가 담은 시세에서도 다섯 날 중 하루꼴로
 * 이런 일이 생긴다. 헷갈리기 딱 좋은 지점이라 판독 결과에 함께 표시한다.
 */
import type { DayBar } from "./index";

export type CandleColor = "up" | "down" | "flat";

export interface CandleRead {
  /** 모양 이름 — "장대양봉", "도지" 등 */
  name: string;
  /** 그날 무슨 일이 있었는지 한 문장 */
  summary: string;
  color: CandleColor;
  /** 전체 폭에서 몸통·윗꼬리·아래꼬리가 차지하는 비율 (0~1) */
  bodyPct: number;
  upperPct: number;
  lowerPct: number;
  /** 이 캔들이 나온 자리 — 직전 흐름이 오름세였는지 내림세였는지 */
  context: CandleColor;
  /**
   * 캔들 색과 전일 대비 부호가 어긋나는가. 어긋나면 "빨간 캔들인데 어제보다 싸다"가 되어
   * 초보자가 가장 자주 혼란스러워하는 상황이 된다.
   */
  mismatch: boolean;
}

/** 직전 흐름 판정에 쓸 영업일 수 */
const CONTEXT_DAYS = 5;
/** 이만큼 움직였을 때만 오름세·내림세라고 부른다 */
const CONTEXT_BAND = 0.02;

/** 몸통이 이보다 작으면 사실상 없는 것으로 본다 = 도지 */
const DOJI = 0.1;
/** 몸통이 이보다 크면 장대 */
const LONG_BODY = 0.6;
/** 한쪽 꼬리가 이보다 길고 반대쪽이 짧으면 망치·유성 계열 */
const LONG_TAIL = 0.5;
const SHORT_TAIL = 0.15;
/** 망치·유성으로 부르려면 몸통이 이보다 작아야 한다 */
const SMALL_BODY = 0.35;

/** 직전 흐름 — 이 캔들 앞의 며칠이 오름세였는지 내림세였는지 */
function readContext(prior: DayBar[]): CandleColor {
  const window = prior.slice(-CONTEXT_DAYS);
  if (window.length < 2) return "flat";
  const first = window[0].close;
  const last = window[window.length - 1].close;
  if (first === 0) return "flat";
  const change = (last - first) / first;
  if (change > CONTEXT_BAND) return "up";
  if (change < -CONTEXT_BAND) return "down";
  return "flat";
}

/**
 * 캔들 하나를 읽는다.
 * @param bar   읽을 캔들
 * @param prior 그 앞의 캔들들 (직전 흐름 판정용). 오름차순이어야 한다.
 */
export function readCandle(bar: DayBar, prior: DayBar[]): CandleRead {
  const color: CandleColor = bar.close > bar.open ? "up" : bar.close < bar.open ? "down" : "flat";
  const context = readContext(prior);
  const mismatch = (color === "up" && bar.change < 0) || (color === "down" && bar.change > 0);

  const range = bar.high - bar.low;
  const body = Math.abs(bar.close - bar.open);
  const upper = bar.high - Math.max(bar.open, bar.close);
  const lower = Math.min(bar.open, bar.close) - bar.low;

  // 하루 종일 한 가격에만 머문 날. 나누기 전에 반드시 막아야 한다.
  if (range === 0) {
    return {
      name: "움직임 없음",
      summary: "하루 종일 값이 한 자리에 머물렀습니다. 거래가 거의 없었거나 거래가 정지된 날입니다.",
      color: "flat",
      bodyPct: 0,
      upperPct: 0,
      lowerPct: 0,
      context,
      mismatch,
    };
  }

  const bodyPct = body / range;
  const upperPct = upper / range;
  const lowerPct = lower / range;
  const shape = { bodyPct, upperPct, lowerPct, color, context, mismatch };

  // 구체적인 모양부터 차례로 걸러낸다. 위쪽 조건이 더 좁다.
  if (bodyPct <= DOJI) {
    return {
      ...shape,
      name: "도지",
      summary:
        "시작한 값과 끝난 값이 거의 같습니다. 사려는 쪽과 팔려는 쪽이 팽팽히 맞선 날이라, " +
        "이어지던 흐름이 한 번 멈춰 서는 자리로 자주 인용됩니다.",
    };
  }

  if (lowerPct >= LONG_TAIL && upperPct <= SHORT_TAIL && bodyPct <= SMALL_BODY) {
    return context === "up"
      ? {
          ...shape,
          name: "교수형",
          summary:
            "장중에 크게 밀렸다가 되돌아와 마감했습니다. 모양은 망치형과 같지만 오름세 끝에서 나왔다는 점이 다릅니다. " +
            "여기서는 오히려 흐름이 꺾일 수 있다는 신호로 읽습니다.",
        }
      : {
          ...shape,
          name: "망치형",
          summary:
            "장중에 크게 밀렸지만 결국 되돌아와 마감했습니다. 내림세 끝에서 나오면 " +
            "하락이 멈추고 반등이 시작될 수 있다는 신호로 읽습니다.",
        };
  }

  if (upperPct >= LONG_TAIL && lowerPct <= SHORT_TAIL && bodyPct <= SMALL_BODY) {
    return context === "up"
      ? {
          ...shape,
          name: "유성형",
          summary:
            "장중에 크게 올랐다가 결국 다 반납하고 마감했습니다. 오름세 끝에서 나오면 " +
            "위쪽에서 파는 힘이 세다는 뜻이라 방향이 바뀔 수 있다는 신호로 읽습니다.",
        }
      : {
          ...shape,
          name: "역망치형",
          summary:
            "장중에 위로 크게 올려봤다가 되밀렸습니다. 내림세 끝에서 나오면 " +
            "바닥에서 올라가려는 시도로 읽지만, 다음 날 실제로 올라야 뜻이 생깁니다.",
        };
  }

  if (bodyPct >= LONG_BODY) {
    return color === "up"
      ? {
          ...shape,
          name: "장대양봉",
          summary:
            "시작하자마자 끝까지 밀어올린 날입니다. 하루 내내 사려는 힘이 셌다는 뜻이라, " +
            "내림세가 이어지던 끝에 나오면 흐름이 바뀌는 자리일 수 있습니다.",
        }
      : {
          ...shape,
          name: "장대음봉",
          summary:
            "시작부터 끝까지 밀린 날입니다. 하루 내내 파는 힘이 셌다는 뜻이라, " +
            "오름세가 이어지던 끝에 나오면 조정이 시작되는 자리일 수 있습니다.",
        };
  }

  if (upperPct >= 0.35) {
    return color === "up"
      ? {
          ...shape,
          name: "윗꼬리 긴 양봉",
          summary:
            "장중에 더 높이 올라갔다가 눌려 마감했습니다. 오르긴 했지만 위쪽에 파는 힘이 " +
            "기다리고 있다는 뜻이라, 상승세가 약해지는 신호로 보기도 합니다.",
        }
      : {
          ...shape,
          name: "윗꼬리 긴 음봉",
          summary: "장중에 올려봤지만 못 버티고 시작가보다 낮게 마감했습니다. 위에서 파는 힘이 셌던 날입니다.",
        };
  }

  if (lowerPct >= 0.35) {
    return color === "up"
      ? {
          ...shape,
          name: "아래꼬리 긴 양봉",
          summary: "장중에 밀렸다가 되살아나 오름으로 마감했습니다. 아래쪽에서 받아주는 힘이 있었던 날입니다.",
        }
      : {
          ...shape,
          name: "아래꼬리 긴 음봉",
          summary: "장중에 크게 빠졌다가 일부 회복했지만 시작가는 되찾지 못했습니다.",
        };
  }

  return color === "up"
    ? { ...shape, name: "짧은 양봉", summary: "조금 오른 채 마감했습니다. 하루 동안 큰 다툼 없이 지나간 날입니다." }
    : color === "down"
      ? { ...shape, name: "짧은 음봉", summary: "조금 내린 채 마감했습니다. 하루 동안 큰 다툼 없이 지나간 날입니다." }
      : { ...shape, name: "보합", summary: "시작한 값 그대로 마감했습니다." };
}

/** 색과 전일 대비가 어긋난 날이 이 종목에 며칠이나 있었는지 — 설명에 실제 숫자를 쓰려고 센다. */
export function countMismatch(days: DayBar[]): number {
  return days.filter((bar) => (bar.close > bar.open && bar.change < 0) || (bar.close < bar.open && bar.change > 0))
    .length;
}
