# TradingForBeginner

주식을 처음 시작하는 입문자를 위한 사이트를 바이브코딩을 통해 제작

**배포 주소**: https://tradingforbeginner.chamch134.workers.dev/

## 기술 스택

- [Astro](https://astro.build/) (정적 사이트 생성)
- Cloudflare Workers (정적 자산 배포, GitHub 연동 자동 배포)

## 진행 방식

한 번에 모든 기능을 만들지 않고, 아래 순서로 단계별로 콘텐츠를 추가합니다.

1. ✅ 기본 사이트 골격 — 홈, 헤더/푸터, `/concepts` `/domestic` `/us` 자리표시자 페이지
2. ✅ 기본 개념 콘텐츠 (`/concepts`) — 주식 기초 용어 100개 + 실전 보충 용어 8개(총 108개)를
   "용어가 설명하는 대상"을 기준으로 13개 주제 영역(소유 구조, 실전 매매, 자금조달, 상장 절차,
   주주환원, 공시, 투자자 유형, 매매 전략, 재무제표, ETF, 기술적 지표, 매매 심리 등)으로 정리해
   페이지에 반영 완료
3. 🔄 국내 주식 현황·분석 (`/domestic`) — 진행 중
   - ✅ 최근 1개월 누적 거래량 TOP10 (개별 종목 / ETF·ETN 포함 2종)
   - ⬜ 코스피·코스닥 지수 현황, 기간 등락률, 종목 상세 페이지
4. ⬜ 미국 주식 현황·분석 (`/us`)

## 개발

```bash
npm install
npm run dev       # http://localhost:4321 개발 서버
npm run build     # dist/ 에 정적 파일 빌드
npm run preview   # 빌드 결과 로컬 미리보기
```

### 시세 데이터 갱신

`/domestic`의 거래량 TOP10은 **커밋된 JSON 파일**을 읽습니다. 빌드할 때 외부 사이트를
호출하지 않으므로, 네이버가 응답하지 않아도 배포는 절대 실패하지 않습니다.
숫자를 최신으로 바꾸려면 로컬에서 아래 명령을 실행한 뒤 커밋·푸시하면 됩니다.

```bash
npm run collect:domestic   # 약 16초 (Node 22.18+ 또는 24+ 필요)
```

- 수집 결과는 [`src/data/domestic/top10.json`](./src/data/domestic/top10.json)에 저장됩니다.
  **이 파일은 생성물이므로 손으로 수정하지 마세요.**
- 원본 응답은 `.cache/naver-daily-{시작일}-{종료일}.json`에 캐시됩니다(git 무시).
  같은 기간으로 다시 실행하면 네트워크를 타지 않고 즉시 끝납니다.
- 수집이 실패하면 **기존 `top10.json`을 건드리지 않고** 종료 코드 1로 끝납니다.
  사이트는 마지막으로 성공한 데이터를 계속 보여줍니다.

## Cloudflare 배포

이 프로젝트는 정적 사이트(Astro `output: "static"`, 기본값)입니다. 저장소 루트의
[`wrangler.jsonc`](./wrangler.jsonc)가 `dist/` 폴더를 정적 자산(assets)으로만 배포하도록
지정하고 있어서, Cloudflare Workers 런타임(Miniflare/workerd)이나 SSR 어댑터가 전혀 필요 없습니다.

### 방법 1: Cloudflare 대시보드에서 Git 연동 (권장)

1. Cloudflare 대시보드 → **Workers & Pages** → **Create application** → **Import a repository**
2. 이 저장소 선택
3. 빌드 설정
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
4. 배포 후 main 브랜치에 푸시하면 자동으로 재배포됩니다.

> 대시보드가 "Deploy command"를 요구하는 최신 Workers Git 연동 방식을 쓰는 경우, 저장소에
> `wrangler.jsonc`가 없으면 Cloudflare가 매 빌드마다 `astro add cloudflare`로 SSR 어댑터를
> 자동 설치하려고 시도합니다. 이때 자동 생성되는 `compatibility_date`가 항상 "오늘 날짜"로
> 잡히는데, 빌드 서버에 내장된 workerd 런타임 바이너리가 그 날짜를 아직 지원하지 않으면
> `MiniflareCoreError [ERR_RUNTIME_FAILURE]` 오류로 배포가 실패합니다. 저장소에 `wrangler.jsonc`를
> 미리 커밋해두면 이 자동 설정 자체가 실행되지 않아 문제가 재발하지 않습니다.

### 방법 2: Wrangler CLI로 수동 배포

```bash
npm run build
npx wrangler deploy
```

> 현재는 정적 자산만 배포하지만, 이후 실시간 시세·로그인 등 서버 기능이 필요해지면
> Astro의 [Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)를 추가해
> SSR/Workers 기반으로 전환할 수 있습니다.

## 변경 이력

### 사이트 골격 구성
- Astro 기반 정적 사이트로 초기 구성 (`npm run dev`/`build`/`preview`)
- 공용 `Layout`, `Header`(내비게이션), `Footer`(투자 유의 문구) 컴포넌트 작성
- 홈(`/`)과 `/concepts`, `/domestic`, `/us` 3개 섹션 페이지 골격 추가

### 디자인 리뉴얼 (클린 & 모던)
- 딥 네이비(`#1c3f73`) + 그로스 그린(`#0ea472`) 팔레트로 색상 정리, 라이트/다크 모드 대응
- 헤더에 로고 아이콘 마크 추가, 내비게이션에 pill 호버/active 스타일 적용
- 홈 히어로에 eyebrow 태그·CTA 버튼(`/concepts`로 유도)·"108개 용어 / 13개 영역 / 3단계 트랙" 통계 바 추가
- 각 섹션 카드에 아이콘(책·막대그래프·지구본) 추가, hover 시 그림자 효과로 입체감 부여
- 푸터를 디스클레이머 + 사이트명 2단 배치로 정리

### 기본 개념(`/concepts`) 콘텐츠
- 주식 기초 용어 100개 + 실전 보충 용어 8개(호가, 매수/매도, EPS 등) = 총 108개 정리
- 월급쟁이부자들 블로그, 토스피드, Speakable 3개 자료를 교차 확인해 PER/PBR 정의 등 오류 수정
- "용어가 설명하는 대상이 무엇인가"라는 명시적 기준으로 13개 주제 영역으로 분류
  (소유 구조, 실전 매매, 스타트업 자금조달, 채권, IPO·상장, 주주환원, 공시, 투자자 유형,
  매매·투자전략, 재무제표, 지수·ETF, 기술적 지표, 매매 심리)
- "초보가 특히 조심할 용어" 콜아웃(물타기, 공매도, 레버리지 ETF, PER·PBR 저평가 오해) 추가
- 초안 단계에서는 별도 Claude 아티팩트로만 존재했던 콘텐츠를 실제 `/concepts` 페이지 코드로 이전

### Cloudflare 배포
- Cloudflare 대시보드에서 GitHub 저장소 연동, Git 푸시 시 자동 빌드·배포되도록 구성
- 첫 배포 시 `MiniflareCoreError`(compatibility_date 불일치)로 실패 → 원인은 저장소에 wrangler
  설정이 없어 Cloudflare가 매 빌드마다 SSR 어댑터를 자동 설치하려 시도한 것
- `wrangler.jsonc`를 저장소에 커밋해 `dist/`를 정적 자산으로만 배포하도록 고정, 문제 해결
- **https://tradingforbeginner.chamch134.workers.dev/** 에서 정상 배포 확인

### 국내 주식(`/domestic`) — 1개월 누적 거래량 TOP10

- 코스피·코스닥 **전 종목 4,294개**(주식 2,764 / ETF 1,160 / ETN 370)의 일별 시세를 모아
  최근 1개월 누적 거래량 상위 10종목을 표로 정리
- 표를 2개로 분리: 메인은 **개별 기업 주식만**, 접이식 보조 표는 **ETF·ETN 포함**
  - 거래량은 "몇 주가 거래됐나"를 세는 지표라 주가가 낮을수록 유리하다. 96원짜리
    `KODEX 200선물인버스2X`가 2,060억 주로 삼성전자(6.3억 주)의 약 327배를 기록하는데,
    ETF를 함께 줄 세우면 TOP10에 개별 기업이 **한 종목도 남지 않아** 초보자에게 오해를 준다
  - 같은 이유로 거래량 옆에 **거래대금 열**을 함께 배치 (신일전자 1,894억 vs SK이터닉스 9.8조)

**데이터 소스 선정 과정** — 후보를 실제로 호출해 검증한 결과:

| 후보 | 결과 |
|---|---|
| 페이지에서 브라우저 직접 호출 | ❌ 네이버가 `Origin` 헤더가 붙으면 **403** (CORS 차단) |
| `data.krx.co.kr` JSON 엔드포인트 | ❌ 모든 요청에 **`LOGOUT`** 응답 (회원제로 전환됨) |
| 로컬 수집 → JSON 커밋 → 빌드타임 import | ✅ 채택 |

- 수집기 [`scripts/collect-domestic.ts`](./scripts/collect-domestic.ts) 추가 (`npm run collect:domestic`).
  의존성 없이 Node 내장 `fetch`만 사용, 동시성 6 + 지수 백오프 3회 재시도
- 네이버 `siseJson` 응답은 헤더 행이 홑따옴표라 `JSON.parse`가 그대로는 실패한다.
  `text.replace(/'/g, '"')`로 치환 후 파싱 (전 종목 대상으로 검증, 실패 0건)
- 종목코드에 영문자가 섞인 게 373개(`0193T0` 등) 있어 문자열로만 취급
- 거래대금은 일별 `종가 × 거래량` 합계로 계산한 **추정치**(실제 체결가 기준값은 무료 소스에
  없음). 페이지와 이 문서 양쪽에 추정임을 명시
- 표 스타일(`.rank-table`, `.table-wrap`)을 새로 추가. 모바일에서는 표만 가로 스크롤되고
  페이지 본문은 밀리지 않는다. 접기는 자바스크립트 없이 네이티브 `<details>` 사용
