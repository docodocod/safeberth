import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'path';
import fs from 'fs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.dirname(ROOT);
const OUT = path.join(BASE, '보고서_시각자료');
const b = await chromium.launch();
const p = await (await b.newContext({ deviceScaleFactor: 2 })).newPage();
await p.goto(pathToFileURL(path.join(BASE, 'scratch_build', 'diagrams.html')).href);
await p.waitForTimeout(900);
const MAP = { d01: '01_전체구성도', d03: '03_데이터흐름', d04: '04_판정시퀀스', d10: '10_교차검증차트',
              d21: '21_그래프스키마', d22: '22_배정게이트', d23: '23_안전3축', d24: '24_챗봇검색', d25: '25_계류모델' };
for (const [id, name] of Object.entries(MAP)) {
  const el = p.locator(`#${id}`);
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`✓ ${name} (${(fs.statSync(path.join(OUT, `${name}.png`)).size/1024).toFixed(0)}KB)`);
}
await b.close();
