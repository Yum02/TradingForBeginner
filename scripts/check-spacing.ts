/**
 * 줄바꿈에 먹힌 공백 찾기
 *
 *   실행: npm run check
 *
 * Astro(JSX)는 **태그에 붙어 있는 줄바꿈을 지운다.** 그래서 이렇게 쓰면
 *
 *     종목을 고르기 전에
 *     <strong>무엇이 다른지</strong>부터 짚습니다.
 *
 * 화면에는 "종목을 고르기 전에무엇이 다른지부터"로 나온다. 글자 사이 공백 하나가
 * 사라지는 것이라 소스만 봐서는 멀쩡해 보이고, 빌드된 문장을 한 줄씩 읽기 전에는
 * 알아채기 어렵다. 실제로 이 저장소에서 여덟 군데가 이렇게 붙어 있었다.
 *
 * 고치는 법은 줄 끝에 {" "}를 붙이거나, 태그와 글자를 같은 줄에 두는 것이다.
 *
 * 줄바꿈이 지워져도 괜찮은 경우(<p>와 </p> 사이처럼 블록 태그끼리 만나는 자리)는
 * 걸러내려고, 글자 사이에 끼는 인라인 태그만 검사한다.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** 글자 사이에 끼어드는 태그들. 이들 옆의 줄바꿈이 사라지면 단어가 붙어버린다. */
const INLINE = "strong|em|a|code|span|b|i|small";

const ENDS_WITH_INLINE_TAG = new RegExp(`(<(${INLINE})\\b[^>]*>|</(${INLINE})>)$`);
const STARTS_WITH_INLINE_TAG = new RegExp(`^<(${INLINE})\\b`);
/** 줄이 글자로 끝나는가 — 태그로 끝나면 여기 해당하지 않는다 */
const ENDS_WITH_TEXT = /[가-힣A-Za-z0-9.,)\]”"%]$/;
const STARTS_WITH_TEXT = /^[가-힣A-Za-z0-9([“"]/;

interface Finding {
  file: string;
  line: number;
  before: string;
  after: string;
}

async function astroFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return astroFiles(full);
      return Promise.resolve(entry.name.endsWith(".astro") ? [full] : []);
    }),
  );
  return found.flat();
}

async function scan(file: string): Promise<Finding[]> {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const before = lines[i].trim();
    const after = lines[i + 1].trim();
    if (!before || !after) continue;

    // 태그로 끝나고 글자로 시작하거나, 글자로 끝나고 태그로 시작하는 두 경우만
    // 공백이 사라진다. 둘 다 태그이거나 둘 다 글자면 문제가 없다.
    const tagThenText = ENDS_WITH_INLINE_TAG.test(before) && STARTS_WITH_TEXT.test(after);
    const textThenTag =
      ENDS_WITH_TEXT.test(before) && !before.endsWith(">") && STARTS_WITH_INLINE_TAG.test(after);

    if (tagThenText || textThenTag) {
      findings.push({ file, line: i + 1, before, after });
    }
  }
  return findings;
}

const files = await astroFiles(SRC);
const findings = (await Promise.all(files.map(scan))).flat();

if (findings.length === 0) {
  console.log(`.astro ${files.length}개 검사 — 줄바꿈에 먹힌 공백 없음`);
} else {
  console.error(`줄바꿈에 먹힌 공백 ${findings.length}곳:\n`);
  for (const f of findings) {
    console.error(`${path.relative(ROOT, f.file)}:${f.line}`);
    console.error(`   …${f.before.slice(-52)}`);
    console.error(`   ${f.after.slice(0, 52)}…`);
    console.error("");
  }
  console.error('줄 끝에 {" "}를 붙이거나 태그와 글자를 같은 줄에 두세요.');
  process.exitCode = 1;
}
