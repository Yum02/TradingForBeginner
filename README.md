# TradingForBeginner

주식을 처음 시작하는 입문자를 위한 사이트를 바이브코딩을 통해 제작

## 기술 스택

- [Astro](https://astro.build/) (정적 사이트 생성)
- Cloudflare Pages 배포 예정

## 진행 방식

한 번에 모든 기능을 만들지 않고, 아래 순서로 단계별로 콘텐츠를 추가합니다.

1. ✅ 기본 사이트 골격 — 홈, 헤더/푸터, `/concepts` `/domestic` `/us` 자리표시자 페이지
2. 🚧 기본 개념 콘텐츠 (`/concepts`) — 주식 기초 용어 100개 + 실전 보충 용어 8개(총 108개)를
   "용어가 설명하는 대상"을 기준으로 13개 주제 영역(소유 구조, 실전 매매, 자금조달, 상장 절차,
   주주환원, 공시, 투자자 유형, 매매 전략, 재무제표, ETF, 기술적 지표, 매매 심리 등)으로 정리한
   초안까지 완료. 실제 `/concepts` 페이지 반영은 다음 단계에서 진행
3. ⬜ 국내 주식 현황·분석 (`/domestic`)
4. ⬜ 미국 주식 현황·분석 (`/us`)

## 개발

```bash
npm install
npm run dev       # http://localhost:4321 개발 서버
npm run build     # dist/ 에 정적 파일 빌드
npm run preview   # 빌드 결과 로컬 미리보기
```

## Cloudflare Pages 배포

이 프로젝트는 정적 사이트(Astro `output: "static"`, 기본값)이므로 Cloudflare Pages에 바로 배포할 수 있습니다.

### 방법 1: Cloudflare 대시보드에서 Git 연동 (권장)

1. Cloudflare 대시보드 → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. 이 저장소 선택
3. 빌드 설정
   - Framework preset: `Astro`
   - Build command: `npm run build`
   - Build output directory: `dist`
4. 배포 후 main 브랜치에 푸시하면 자동으로 재배포됩니다.

### 방법 2: Wrangler CLI로 수동 배포

```bash
npm install -D wrangler
npm run build
npx wrangler pages deploy dist
```

> 현재는 정적 페이지만 사용하지만, 이후 실시간 시세·로그인 등 서버 기능이 필요해지면
> Astro의 [Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)를 추가해
> SSR/Workers 기반으로 전환할 수 있습니다.
