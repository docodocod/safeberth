// 추가 컷: 챗봇 질의응답 · 안전 페이지 · 선석 기상 판정 · 계류 패널
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), '보고서_시각자료');
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })).newPage();
async function shoot(name, target, clip) {
  const o = clip ? { clip } : {};
  await (target || page).screenshot({ path: path.join(OUT, `${name}.png`), ...o });
  await (target || page).screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80, ...o });
  console.log(`✓ ${name} (${(fs.statSync(path.join(OUT, `${name}.png`)).size/1024).toFixed(0)}KB)`);
}

// ── 챗봇 질의응답 ────────────────────────────────────────────────
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(7000);
const launcher = page.getByRole('button', { name: /에이전트 협상 로그/ });
if (await launcher.count()) {
  await launcher.click(); await page.waitForTimeout(1200);
  await page.getByText('질의응답', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(800);
  const input = page.locator('div[style*="fixed"] input, div[style*="fixed"] textarea').last();
  if (await input.count()) {
    await input.fill('메탄올과 황산을 인접 선석에서 동시에 하역해도 되나요?');
    await input.press('Enter');
    for (let w = 0; w < 30; w++) {
      await page.waitForTimeout(2000);
      const busy = await page.getByText(/찾는 중|생각 중|답변 중|판단 중/).count();
      if (!busy && w > 6) break;
    }
    await shoot('11_챗봇_질의응답', null, { x: 1150, y: 408, width: 440, height: 574 });
  } else console.log('! 챗봇 입력창 못 찾음');
}

// ── 안전/환경 페이지 ─────────────────────────────────────────────
await page.goto('http://localhost:3000/safety', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(9000);
await shoot('12_안전환경_관제');

// ── 선석 기상 판정 (지도의 선석 원 클릭) ─────────────────────────
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(7000);
const circles = page.locator('.leaflet-interactive');
const n = await circles.count();
let gotWeather = false;
for (let i = 0; i < Math.min(n, 25) && !gotWeather; i++) {
  await circles.nth(i).click({ force: true }).catch(() => {});
  await page.waitForTimeout(2500);
  const panel = page.getByText(/하역 판정|하역중단 임계|이안 임계|호스분리/).first();
  if (await panel.count()) {
    const box = page.locator('.vessel-detail-panel, aside').filter({ hasText: /하역 판정|임계/ }).first();
    if (await box.count()) { await shoot('13_선석_기상판정', box); gotWeather = true; }
    else { await shoot('13_선석_기상판정'); gotWeather = true; }
  }
}
if (!gotWeather) console.log('! 기상 판정 패널 캡처 실패 — 수동 캡처 필요');
await browser.close();
