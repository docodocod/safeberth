// 추가 컷 2차: 센서 페이지(HW 시뮬레이션) · 선석 기상 판정 패널
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), '보고서_시각자료');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage();
async function shoot(name, target) {
  await (target || page).screenshot({ path: path.join(OUT, `${name}.png`) });
  await (target || page).screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80 });
  console.log(`✓ ${name} (${(fs.statSync(path.join(OUT, `${name}.png`)).size/1024).toFixed(0)}KB)`);
}
// ── 센서/게이트 시뮬레이션 페이지 ──
await page.goto('http://localhost:3000/sensors', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(7000);
await shoot('14_센서_게이트_시뮬레이션');

// ── 선석 기상 판정 패널: 접안 중 선박 상세의 "기상 판정 실행" 버튼 경유 ──
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
await page.getByRole('button', { name: /액체화물선/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);
const rows = page.locator('table tbody tr');
const n = await rows.count();
let done = false;
for (let i = 0; i < Math.min(n, 12) && !done; i++) {
  await rows.nth(i).click().catch(() => {});
  await page.waitForTimeout(4000);
  const btn = page.getByRole('button', { name: /기상 판정 실행/ });
  if (await btn.count()) {
    await btn.first().click().catch(() => {});
    await page.waitForTimeout(5000);
    // 판정 패널: 4단계 텍스트가 있는 컨테이너
    const panel = page.locator('div,section').filter({ hasText: /하역중단 임계|호스분리/ }).last();
    if (await panel.count()) {
      const box = await panel.boundingBox();
      if (box && box.height > 150 && box.height < 900) { await shoot('15_선석_기상판정패널', panel); done = true; }
      else { await shoot('15_선석_기상판정패널'); done = true; }
    }
  }
}
if (!done) console.log('! 기상 판정 패널 미확보');
await browser.close();
