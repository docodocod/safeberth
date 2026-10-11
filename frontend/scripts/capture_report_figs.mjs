// 개발보고서 시각자료 캡처 — 살아있는 화면에서 그대로 찍는다.
// 전제: 백엔드(8001)·개발서버(3000) 가동. 실행: node scripts/capture_report_figs.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), '보고서_시각자료');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function shoot(name, target) {
  const png = path.join(OUT, `${name}.png`);
  const jpg = path.join(OUT, `${name}.jpg`);
  const t = target || page;
  await t.screenshot({ path: png }).catch(e => console.log(`  ! ${name} png 실패: ${e.message.split('\n')[0]}`));
  await t.screenshot({ path: jpg, type: 'jpeg', quality: 80 }).catch(() => {});
  if (fs.existsSync(png)) console.log(`  ✓ ${name} (${(fs.statSync(png).size/1024).toFixed(0)}KB)`);
}

// ── 1. 대시보드 첫 화면 ─────────────────────────────────────────
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
await shoot('02_대시보드_첫화면');

// 지도만 (범례 포함)
const map = page.locator('.leaflet-container').first();
if (await map.count()) await shoot('06_온산지도_범례', map);

// ── 2. 선박 상세 — 액체화물선 선택 → 판정 체인 ──────────────────
await page.getByRole('button', { name: /액체화물선/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);
const rows = page.locator('table tbody tr');
const n = await rows.count();
let gotDetail = false;
for (let i = 0; i < Math.min(n, 8) && !gotDetail; i++) {
  await rows.nth(i).click().catch(() => {});
  await page.waitForTimeout(7000);
  const panel = page.locator('.vessel-detail-panel').first();
  if (!(await panel.count())) continue;
  const btn = page.getByRole('button', { name: /접안 가능한 선석 조회/ });
  if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(5000); }
  const txt = await panel.innerText().catch(() => '');
  if (/후보|위험|판정/.test(txt)) {
    await shoot('07_선박상세_판정체인', panel);
    gotDetail = true;
  }
}

// ── 3. 협상 로그 — 종합 판정 완주 ───────────────────────────────
const judge = page.getByRole('button', { name: /종합 판정/ }).first();
if (await judge.count()) {
  await judge.click().catch(() => {});
  await page.waitForTimeout(20000); // 기상→후보→재판정→안전→종합
  const consoleBox = page.locator('text=에이전트 협상 로그').last().locator('xpath=ancestor::*[self::section or self::aside or self::div][2]');
  if (await consoleBox.count()) await shoot('05_협상로그_완주', consoleBox.first());
  else await shoot('05_협상로그_완주');
}

// ── 4. 선석 배정현황 (신규 페이지) ──────────────────────────────
await page.goto('http://localhost:3000/berth-assignments', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);
await shoot('08_선석배정현황');

// ── 5. 3D 관제 ──────────────────────────────────────────────────
await page.goto('http://localhost:3000/twin', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(12000);
await shoot('09_3D관제화면');

await browser.close();
console.log(`\n저장 위치: ${OUT}`);
