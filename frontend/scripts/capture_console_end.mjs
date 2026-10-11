// 협상 로그 하단부(안전 → 종합 결론) 컷
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), '보고서_시각자료');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage();
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(7000);
await page.getByRole('button', { name: /에이전트 협상 로그/ }).click();
await page.waitForTimeout(1500);
const sel = page.locator('select').last();
const opts = await sel.locator('option').allInnerTexts();
let pick = opts.findIndex(t => /프로페인|부탄|원유|가솔린|나프타|메틸/.test(t));
if (pick < 0) pick = 0;
await sel.selectOption({ index: pick });
console.log('대상: ' + opts[pick].trim());
await page.waitForTimeout(800);
await page.getByRole('button', { name: /종합 판정/ }).click();
for (let w = 0; w < 45; w++) {
  await page.waitForTimeout(2000);
  if (!(await page.getByText('판단 중').count())) break;
}
await page.waitForTimeout(2500);
// 마지막 메시지(종합)로 스크롤
const last = page.getByText(/종합|오케스트레이터/).last();
await last.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(800);
const clip = { x: 1150, y: 408, width: 440, height: 574 };
await page.screenshot({ path: path.join(OUT, '05b_협상로그_종합판정.png'), clip });
await page.screenshot({ path: path.join(OUT, '05b_협상로그_종합판정.jpg'), type: 'jpeg', quality: 80, clip });
console.log('✓ 05b (' + (fs.statSync(path.join(OUT,'05b_협상로그_종합판정.png')).size/1024).toFixed(0) + 'KB)');
await browser.close();
