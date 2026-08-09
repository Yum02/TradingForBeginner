# TradingForBeginner

주식을 처음 시작하는 입문자를 위한 사이트를 바이브코딩을 통해 제작

## 기술 스택

- [Astro](https://astro.build/) (정적 사이트 생성)
- Cloudflare Pages 배포 예정

## 진행 방식

한 번에 모든 기능을 만들지 않고, 아래 순서로 단계별로 콘텐츠를 추가합니다.

1. ✅ 기본 사이트 골격 — 홈, 헤더/푸터, `/concepts` `/domestic` `/us` 자리표시자 페이지
2. ✅ 기본 개념 콘텐츠 (`/concepts`) — 주식 기초 용어 100개 + 실전 보충 용어 8개(총 108개)를
   "용어가 설명하는 대상"을 기준으로 13개 주제 영역(소유 구조, 실전 매매, 자금조달, 상장 절차,
   주주환원, 공시, 투자자 유형, 매매 전략, 재무제표, ETF, 기술적 지표, 매매 심리 등)으로 정리해
   페이지에 반영 완료
3. ⬜ 국내 주식 현황·분석 (`/domestic`)
4. ⬜ 미국 주식 현황·분석 (`/us`)

## 개발

```bash
npm install
npm run dev       # http://localhost:4321 개발 서버
npm run build     # dist/ 에 정적 파일 빌드
npm run preview   # 빌드 결과 로컬 미리보기
```

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
