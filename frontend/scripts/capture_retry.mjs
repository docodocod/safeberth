// 빠진 컷 재촬영: 07 판정 체인(화물 확인 선박) · 05 협상 로그 완주 · 08b 승인 목록
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(path.dirname(ROOT), '보고서_시각자료');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function shoot(name, target, clip) {
  const opts = clip ? { clip } : {};
  await (target || page).screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  await (target || page).screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 80, ...opts });
  console.log(`  ✓ ${name} (${(fs.statSync(path.join(OUT,`${name}.png`)).size/1024).toFixed(0)}KB)`);
}

// ── 07 재촬영: 화물이 확인된 액체화물선의 판정 체인 ─────────────
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);
await page.getByRole('button', { name: /액체화물선/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);

let got07 = false;
outer:
for (let pageNo = 0; pageNo < 3 && !got07; pageNo++) {
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await rows.nth(i).click().catch(() => {});
    await page.waitForTimeout(6000);
    const panel = page.locator('.vessel-detail-panel').first();
    if (!(await panel.count())) continue;
    let txt = await panel.innerText().catch(() => '');
    if (/화물 미신고|미확인/.test(txt) && !/후보/.test(txt)) continue; // 화물 없으면 다음 배
    const btn = page.getByRole('button', { name: /접안 가능한 선석 조회/ });
    if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(6000); }
    txt = await panel.innerText().catch(() => '');
    if (/후보 1|전용|대체/.test(txt) && !/조회 불가/.test(txt)) {
      await shoot('07_선박상세_판정체인', panel);
      console.log('    대상: ' + txt.split('\n')[0]);
      got07 = true;
      break outer;
    }
  }
  const next = page.getByRole('button', { name: '다음' });
  if (!(await next.count()) || await next.isDisabled().catch(() => true)) break;
  await next.click(); await page.waitForTimeout(1500);
}
if (!got07) console.log('  ! 07: 화물 확인 선박을 못 찾음');

// ── 05: 협상 로그 완주 (새 페이지 — 선박 미선택이라 런처가 보인다) ──
await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(7000);
const launcher = page.getByRole('button', { name: /에이전트 협상 로그/ });
if (await launcher.count()) {
  await launcher.click();
  await page.waitForTimeout(1500);
  // 화물명이 있는 선박 선택 (프로페인·부탄·원유 등 우선)
  const sel = page.locator('select').last();
  const opts = await sel.locator('option').allInnerTexts();
  let pick = opts.findIndex(t => /프로페인|프로판|부탄|원유|가솔린|나프타|자일렌|메틸/.test(t));
  if (pick < 0) pick = opts.findIndex(t => /·\s*\S/.test(t) && !/undefined/.test(t));
  if (pick >= 0) {
    await sel.selectOption({ index: pick });
    console.log('    콘솔 대상: ' + opts[pick].trim());
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /종합 판정/ }).click();
    // 완주 대기: '판단 중'이 사라질 때까지 최대 90초
    for (let w = 0; w < 45; w++) {
      await page.waitForTimeout(2000);
      const busy = await page.getByText('판단 중').count();
      if (!busy) break;
    }
    await page.waitForTimeout(2500);
    await shoot('05_협상로그_완주', null, { x: 1150, y: 408, width: 440, height: 574 });
  } else console.log('  ! 05: 화물 있는 선박 옵션 없음');
} else console.log('  ! 05: 런처 버튼 없음');

// ── 08b: 배정 목록(승인자 컬럼) ─────────────────────────────────
await page.goto('http://localhost:3000/berth-assignments', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);
const listHead = page.getByText('선석 점유 목록');
if (await listHead.count()) {
  await listHead.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shoot('08b_배정목록_승인');
}

await browser.close();
console.log('끝');
