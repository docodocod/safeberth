/**
 * 시연 영상 자동 촬영 (2분) — 실제 브라우저를 조작하며 녹화한다.
 *
 * 무음 영상이다. 내레이션은 편집에서 얹으면 된다.
 * 대본: ../시연촬영_대본_2분.md 와 장면 구성이 같다.
 *
 * 실행: node scripts/record_demo.mjs [선박명]
 *       기본 GULF BAYNUNAH — 표와 콘솔이 같은 화물을 보는 배만 쓴다.
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const VESSEL = process.argv[2] || 'GULF BAYNUNAH';
const OUT = 'C:/Users/hwham/Documents/멀티 에이전트 기반 액체화물 하역 스케줄링 및 관제 시스템/울산항만_프로젝트_최종본/시연영상';
const W = 1920, H = 1080;

const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
});

// 커서 시각화 — Playwright 영상에는 마우스가 찍히지 않는다.
// 어디를 누르는지 보이지 않으면 조작 영상으로 읽히지 않으므로 직접 그린다.
await ctx.addInitScript(() => {
  const draw = () => {
    if (!document.body || document.getElementById('__cur')) return;
    const d = document.createElement('div');
    d.id = '__cur';
    d.style.cssText = 'position:fixed;left:-99px;top:-99px;width:20px;height:20px;'
      + 'border-radius:50%;background:rgba(220,38,38,.35);border:2px solid rgba(255,255,255,.95);'
      + 'box-shadow:0 2px 10px rgba(0,0,0,.4);z-index:2147483647;pointer-events:none;'
      + 'transform:translate(-50%,-50%);transition:width .1s,height .1s';
    document.body.appendChild(d);
    addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { d.style.width = '34px'; d.style.height = '34px'; }, true);
    addEventListener('mouseup', () => { d.style.width = '20px'; d.style.height = '20px'; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', draw);
  else draw();
  setTimeout(draw, 1200);
});

const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));

let cx = W / 2, cy = H / 2;
/** 사람처럼 부드럽게 이동 — 순간이동하면 영상이 튄다. */
async function glide(x, y, steps = 26) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);  // ease-in-out
    await page.mouse.move(cx + (x - cx) * e, cy + (y - cy) * e);
    await page.waitForTimeout(12);
  }
  cx = x; cy = y;
}
async function clickAt(loc, opts = {}) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('대상을 찾지 못했습니다');
  await glide(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(320);
  // 3D 관제 화면에서는 캔버스가 포인터를 가로채, 평범한 클릭이 actionable
  // 판정을 기다리다 38초까지 지연된 적이 있다(2026-08-24 실측). 그 사이가
  // 통째로 잘려나가 센서 화면이 영상에서 사라졌다.
  await loc.click({ force: Boolean(opts.force), timeout: 15000 });
}
const beat = (ms) => page.waitForTimeout(ms);
/** 화면을 내린다.
 *
 * page.mouse.wheel 을 쓰면 안 된다 — 커서가 지도 위에 있을 때 굴리면 Leaflet 이
 * 확대·이동을 먹어, 부두가 사라지고 내륙만 비치는 화면이 영상에 남는다
 * (2026-08-25 실측: 선석 배정현황이 학남리 산자락을 보여주고 있었다).
 * 스크롤 컨테이너를 직접 움직이면 지도는 건드리지 않는다. */
const scrollBy = (dy) => page.evaluate((d) => {
  const el = document.querySelector('.page-content');
  if (el) el.scrollTop += d; else window.scrollBy(0, d);
}, dy);
// 화면 전환 시각을 기록해 둔다. 내레이션 타이밍을 손으로 맞추면 자막이
// 화면보다 앞서 뜬다(2026-08-24 피드백: 1~2초 빠름). 실측에서 역산한다.
const marks = [];
const mark = (s) => {
  const t = (Date.now() - T0) / 1000;
  marks.push({ at: +t.toFixed(2), label: s });
  console.log(`  [${t.toFixed(1).padStart(5)}s] ${s}`);
};

const T0 = Date.now();
console.log(`촬영 시작 — 대상 ${VESSEL}`);

// ── 장면 1 · 대시보드 (0:00–0:25) ─────────────────────────────────────
await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle', timeout: 90000 });
// 실데이터가 화면에 들어찬 시점을 잡는다.
//
// 첫 몇 초는 KPI 가 전부 0척이고 지도에 배가 없다. 그 구간에 내레이션을 얹으면
// "물동량 1위 항만"이라고 말하면서 빈 화면을 보여주게 된다(2026-08-24 실측:
// 데이터가 차기까지 약 14초). 이 지점을 기록해 두고 앞부분을 잘라낸다.
await page.waitForFunction(() => {
  const t = document.body.innerText;
  const m = t.match(/관제 선박\s*([\d,]+)/);
  return m && parseInt(m[1].replace(/,/g, ''), 10) > 0;
}, { timeout: 120000 });
mark('데이터 로드');
await beat(1200);
mark('장면1 대시보드');
await glide(1280, 75);                 // 헤더의 기상·수집 상태
await beat(1300);
await glide(760, 250, 26);             // KPI 4장
await beat(1400);
await glide(960, 620, 30);             // 지도
await beat(1200);

// 선박 상세 — 지도의 배를 눌러 판정 근거를 펼치는 자리.
//
// 이 화면이 "배 한 척에 대해 무엇을 아는가"를 한눈에 보여준다(안전 심사 ·
// 접안 가능 선석 · 관련 경고). 영상에 빠져 있어 넣는다(2026-08-25 요청).
const pick = await page.evaluate(() => {
  const map = document.querySelector('.leaflet-container')?.getBoundingClientRect();
  if (!map) return false;
  for (const el of document.querySelectorAll('.vessel-marker--danger')) {
    const r = el.getBoundingClientRect();
    if (r.top > map.top + 90 && r.bottom < map.bottom - 90
        && r.left > map.left + 90 && r.right < map.right - 90) {
      el.setAttribute('data-pick', '1');
      return true;
    }
  }
  return false;
});
if (pick) {
  await clickAt(page.locator('[data-pick="1"]'), { force: true });
  await page.waitForFunction(
    () => /배정 가능 선석/.test(document.body.innerText), { timeout: 30000 },
  ).catch(() => {});
  await beat(700);
  mark('선박 상세');
  await beat(4200);
  await glide(1700, 500, 24);          // 상세 패널을 훑는다
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => d.scrollHeight > d.clientHeight + 40 && /배정 가능 선석/.test(d.innerText),
    );
    if (el) el.scrollTop += 260;
  });
  await beat(3200);
  mark('선박 상세 · 경고');
  await beat(3600);
  const closeBtn = page.getByRole('button', { name: '닫기' }).first();
  if (await closeBtn.count()) {
    await closeBtn.click({ force: true }).catch(() => {});
    await page.waitForFunction(
      () => !/배정 가능 선석/.test(document.body.innerText), { timeout: 10000 },
    ).catch(() => console.log('  [경고] 선박 상세가 닫히지 않았습니다'));
  }
  await beat(500);
}

// ── 장면 2 · 협상 로그 (0:25–1:05) ───────────────────────────────────
mark('장면2 선석 배정현황');
await clickAt(page.getByRole('link', { name: /선석|배정/ }).first());
await beat(2200);
await scrollBy(420);                   // 선석 점유 목록이 보이게
await beat(1600);

const row = page.locator('tr', { hasText: VESSEL });
await row.scrollIntoViewIfNeeded();
await beat(900);
mark(`${VESSEL} 행 → 협상 로그`);
await clickAt(row.locator('button', { hasText: '협상 로그' }));
await beat(1300);

mark('종합 판정 실행');
await clickAt(page.getByRole('button', { name: /종합 판정/ }).first());
await page.waitForSelector('text=최종 판단', { timeout: 120000 });
mark('판정 완료 — 3개 에이전트 로그');
await beat(1500);

// 에이전트 발화를 하나씩 짚는다.
//
// 예전엔 판정이 도는 12초 동안 "기상 에이전트가…"를 말하고, 정작 세 발화가
// 화면에 나타났을 땐 내레이션이 이미 다음 주제로 넘어가 있었다(2026-08-24
// 피드백). 각 발화 앞에 지점을 남겨 말이 화면을 따라가게 한다.
const panel = page.locator('text=에이전트 협상 로그').locator('xpath=ancestor::div[3]');
const pb = await panel.boundingBox().catch(() => null);
if (pb) await glide(pb.x + pb.width / 2, pb.y + pb.height * 0.55, 26);

for (const [label, needle] of [
  ['기상 판정 표시', '기상분석 에이전트'],
  ['스케줄링 판정 표시', '스케줄링 에이전트'],
  ['안전 판정 표시', '안전관제 에이전트'],
]) {
  const el = page.locator(`text=${needle}`).first();
  if (await el.count()) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await beat(600);
    mark(label);
    await beat(4200);            // 그 발화를 설명할 시간
  }
}

// ── 승인 ─────────────────────────────────────────────────────────────
mark('승인');
const ok = page.getByRole('button', { name: /^승인$/ }).first();
if (await ok.count()) {
  await clickAt(ok);
  await beat(3000);
  mark('배정현황 반영 확인');
  await glide(700, 700, 26);
  await beat(2200);
  await scrollBy(-300);
  await beat(1600);
} else {
  console.log('  [경고] 승인 버튼 없음 — 다른 배로 재촬영 필요');
}

// ── 질의응답(GraphRAG) ───────────────────────────────────────────────
const qtab = page.getByRole('tab', { name: /질의응답/ }).first();
const qtabAlt = page.locator('text=질의응답').first();
if (await qtab.count() || await qtabAlt.count()) {
  mark('질의응답 탭');
  await clickAt(await qtab.count() ? qtab : qtabAlt);
  await beat(1800);
  const q = page.locator('button', { hasText: /벤젠|메탄올|황산|톨루엔/ }).first();
  if (await q.count()) {
    await clickAt(q);
    await page.waitForFunction(
      () => /출처|인화점|보호구|취급|누출/.test(document.body.innerText),
      { timeout: 90000 },
    ).catch(() => {});
    await beat(700);
    mark('질의응답 답변');
    await beat(4200);
  }
}

// ── 안전/환경 관제 ───────────────────────────────────────────────────
await page.evaluate(() => fetch('/api/v1/dashboard/safety-index').catch(() => {}));
await beat(1500);
await clickAt(page.getByRole('link', { name: /안전|환경/ }).first());
// 안전 지수 레이더는 늦게 그려진다. '불러오는 중…'이 사라지고 차트가 실제로
// 나온 뒤에 지점을 찍어야, 잘라낸 영상에서 빈 카드를 보여주지 않는다.
await page.waitForFunction(() => {
  const t = document.body.innerText;
  return !/불러오는 중/.test(t) && document.querySelectorAll('svg.recharts-surface, svg').length > 2;
}, { timeout: 60000 }).catch(() => console.log('  [경고] 안전 지수 차트 대기 시간 초과'));
await beat(1200);
mark('장면4 안전/환경 관제');
await beat(2600);
await glide(1500, 400, 24);   // 오른쪽 위험 선석 패널
await beat(3000);

// ── 3D 관제 ──────────────────────────────────────────────────────────
const twin = page.getByRole('link', { name: /3D|관제 화면/ }).first();
if (await twin.count()) {
  mark('3D 관제 클릭');
  await clickAt(twin);
  // 3D 는 뜨는 데 시간이 걸린다. 준비된 시점을 따로 남겨 그 사이를 잘라내면,
  // 화면에서는 누르자마자 관제 화면이 나오는 것처럼 이어진다.
  await page.waitForFunction(
    () => document.querySelector('canvas') && /선석 현황|온산 AIS/.test(document.body.innerText),
    { timeout: 120000 },
  ).catch(() => {});
  // 캔버스와 HUD 가 붙었다고 장면이 그려진 것은 아니다. WebGL 이 첫 프레임을
  // 그리기까지 실측 6.7초가 더 걸렸고, 그 사이 화면은 빈 남색이었다
  // (2026-08-25: 지점을 준비 신호에 찍었더니 빈 화면이 영상에 남았다).
  // 넉넉히 기다린 뒤 지점을 찍는다 — 이 대기는 어차피 trim_gaps 가 잘라낸다.
  await beat(9000);
  mark('3D 관제 화면');
  await beat(4200);

  // 좌측 AIS 목록에서 배 하나를 눌러 우측 선박 패널을 연다.
  // 3D 를 '보기만 하는 화면'이 아니라 조회 수단으로 쓴다는 걸 보여주는 자리다.
  const picked = await page.evaluate(() => {
    const hud = [...document.querySelectorAll('div')]
      .find((d) => /온산 AIS 선박/.test(d.innerText) && d.innerText.length < 900);
    if (!hud) return false;
    const rows = [...hud.querySelectorAll('div')]
      .filter((d) => /\d+ kn/.test(d.innerText) && d.innerText.length < 80);
    if (!rows.length) return false;
    rows[0].setAttribute('data-twin-pick', '1');
    return true;
  });
  if (picked) {
    await clickAt(page.locator('[data-twin-pick="1"]'), { force: true });
    await page.waitForFunction(
      () => /적재량|속력 \/ 침로/.test(document.body.innerText), { timeout: 30000 },
    ).catch(() => console.log('  [경고] 3D 선박 패널이 열리지 않았습니다'));
    await beat(700);
    mark('3D 선박 조회');
    await beat(6000);
  }
}

// ── 센서 데이터 ──────────────────────────────────────────────────────
const sensor = page.getByRole('link', { name: /센서/ }).first();
if (await sensor.count()) {
  await clickAt(sensor, { force: true });
  // 지점은 '눌렀을 때'가 아니라 '화면이 떴을 때' 남긴다. 누른 시각에 남기면
  // 전환이 늦어질 때 내레이션이 아직 없는 화면을 설명하게 된다.
  await page.waitForFunction(
    () => /저장탱크|이송배관|게이트/.test(document.body.innerText),
    { timeout: 60000 },
  ).catch(() => {});
  await beat(800);
  mark('센서 데이터');
  await beat(3600);
  await scrollBy(260);
  await beat(3400);
}

// 마무리는 가려진 것 없는 대시보드로 끝낸다
const consoleClose = page.getByRole('button', { name: '협상 로그 닫기' }).first();
if (await consoleClose.count()) {
  await consoleClose.click({ force: true }).catch(() => {});
  await beat(600);
}

await clickAt(page.getByRole('link', { name: /^대시보드$/ }).first(), { force: true });
// 센서 탭과 같은 원칙 — 지점은 '눌렀을 때'가 아니라 '화면이 떴을 때' 남긴다.
// 여기만 누르기 전에 남기고 있어서, 커서가 사이드바까지 가는 시간(glide)만큼
// 마지막 인사가 아직 센서 화면 위에서 나왔다(2026-08-25 실측: 대시보드는
// 영상 끝 0.5초 전에야 나타남).
await page.waitForFunction(
  () => /온산항 관제 지도/.test(document.body.innerText),
  { timeout: 30000 },
).catch(() => console.log('  [경고] 대시보드로 돌아오지 못했습니다'));
await beat(700);
mark('대시보드로 복귀');
// 길게 잡는다 — Playwright 는 컨텍스트를 닫을 때 마지막 2~3초를 흘린다(실측).
// 마무리 인사(1.8초)와 그 앞 여유(1.6초)가 대시보드 위에서 끝나야 한다.
await beat(8000);

console.log(`\n총 길이 약 ${((Date.now() - T0) / 1000).toFixed(0)}초 · 페이지 오류 ${errs.length}건`);
errs.slice(0, 3).forEach((e) => console.log('  !', e));
await ctx.close();          // 여기서 영상 파일이 저장된다
// 내레이션 배치가 쓸 실측 타임라인
await writeFile(`${OUT}/_marks.json`, JSON.stringify({ marks }, null, 2), 'utf-8');
console.log(`실측 타임라인: _marks.json (${marks.length}개)`);
await browser.close();
const vp = await page.video()?.path().catch(() => null);
console.log('영상:', vp || OUT);
