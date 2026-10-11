// ─────────────────────────────────────────────────────────────────────────────
// 에이전트 판정 녹화 — 스냅샷 배포본에서도 안전 심사·선석 후보가 뜨게 한다.
//
// 왜 브라우저로 녹화하나.
//   이 두 API 는 POST 라서, GET 처럼 주소만으로 저장할 수 없다. 요청 본문이
//   무엇이냐에 따라 답이 달라진다 — 안전 심사는 '대상 화물 + 인접 선석 재항
//   화물' 조합이 입력이고, 그 조합은 화면(useVesselSafety)이 실AIS·화물 조인,
//   모호 호출부호 제외, 인접표 같은 규칙을 거쳐 만든다.
//
//   처음엔 그 규칙을 파이썬으로 한 벌 더 짜서 미리 받아두려 했는데, 조인 규칙이
//   두 군데로 갈리는 순간 키가 조용히 어긋난다(실제로 어긋났다 — 화면은 배 1척당
//   화물 1건인데 파이썬은 화물행 전체를 넣었다). 그러면 배포본에서 판정이 통째로
//   빠지고, 원인은 화면만 봐서는 알 수 없다.
//
//   그래서 규칙을 베끼지 않고, 살아있는 화면을 실제로 클릭해서 화면이 보내는
//   요청과 받은 답을 그대로 받아 적는다. 키는 화면이 만든 것이므로 어긋날 수 없다.
//
// 전제: 백엔드(8001)와 개발 서버(3000)가 떠 있을 것.
// 실행:  node scripts/record_agents.mjs [최대선박수]
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

// 경로에 한글이 있으면 URL 이 퍼센트 인코딩된다 — fileURLToPath 로 되돌린다
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SNAP = path.join(ROOT, 'public', 'snapshot', 'snapshot.json');
const LIMIT = Number(process.argv[2] || 40);

// snapshotMode.js 와 같은 규칙으로 키를 만든다 (두 곳이 갈리면 캐시가 안 맞는다)
const cargoId = (c) => c?.cas_no || c?.chem_id;
const safetyKey = (b) => {
  const parts = (b.adjacent_cargos || []).map((a) => `${a.berth_name}:${cargoId(a.cargo)}`).sort();
  return `${cargoId(b.target_cargo)}|${parts.join(',')}`;
};

const safety = {};
const candidates = {};
// 종합 판정(오케스트레이터) — 배포본에서 이게 없으면 우리 대표 기능이
// 통째로 "판단 보류"로 보인다. 호출부호로 갈라 저장한다.
const orchestrations = {};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

page.on('response', async (res) => {
  const url = res.url();
  if (!res.ok()) return;
  let body;
  try { body = JSON.parse(res.request().postData() || '{}'); } catch { return; }
  try {
    if (url.includes('/safety/assess')) safety[safetyKey(body)] = await res.json();
    else if (url.includes('/scheduling/candidates')) {
      const name = body.vessel?.name_hint;
      if (name) candidates[name] = await res.json();
    } else if (url.includes('/orchestrator/assess')) {
      const cs = body.vessel?.call_sign;
      if (cs) orchestrations[cs] = await res.json();
    }
  } catch { /* 본문 못 읽으면 건너뛴다 */ }
});

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);

// 액체화물선만 — 안전 심사·선석 후보가 실제로 도는 대상이다
await page.getByRole('button', { name: /액체화물선/ }).first().click().catch(() => {});
await page.waitForTimeout(1500);

// 입항 목록은 12척씩 나눠 보여준다 — '다음'을 눌러 가며 돈다.
let seen = 0;
for (let pageNo = 1; seen < LIMIT; pageNo += 1) {
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  if (n === 0) break;

  for (let i = 0; i < n && seen < LIMIT; i += 1) {
    await rows.nth(i).click().catch(() => {});
    // 안전 심사는 MSDS 조회 + LLM 설명까지 가므로 넉넉히 기다린다
    await page.waitForTimeout(7000);
    const btn = page.getByRole('button', { name: /접안 가능한 선석 조회/ });
    if (await btn.count()) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(4000);
    }
    seen += 1;
  }
  console.log(`  ${pageNo}쪽 (${seen}척) — 안전 ${Object.keys(safety).length}건 · 후보 ${Object.keys(candidates).length}건`);

  const next = page.getByRole('button', { name: '다음' });
  if (!(await next.count()) || await next.isDisabled().catch(() => true)) break;
  await next.click();
  await page.waitForTimeout(1200);
}

await browser.close();

const snap = JSON.parse(fs.readFileSync(SNAP, 'utf-8'));
snap['/api/v1/safety/assess'] = safety;
snap['/api/v1/scheduling/candidates'] = candidates;
if (Object.keys(orchestrations).length) snap['/api/v1/orchestrator/assess'] = orchestrations;
fs.writeFileSync(SNAP, JSON.stringify(snap), 'utf-8');
console.log(`\n녹화 완료 — 안전 심사 ${Object.keys(safety).length}건 · 선석 후보 ${Object.keys(candidates).length}건`);
console.log(`${SNAP} (${fs.statSync(SNAP).size.toLocaleString()} bytes)`);
console.log('녹화되지 않은 조합은 배포본에서 판단 보류로 표시됩니다 (없는 판정을 지어내지 않음)');
