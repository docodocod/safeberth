// 원고 HTML의 SVG 도식 4장을 HWP용 PNG로 내보낸다
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = path.dirname(ROOT);
const OUT = path.join(BASE, '보고서_시각자료');
const HTML = path.join(BASE, '개발보고서_원고_팀장.html');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 })).newPage();
await page.goto(pathToFileURL(HTML).href);
await page.waitForTimeout(2500);
const figs = [['fig1','01_전체구성도'],['fig3','03_데이터흐름'],['fig4','04_판정시퀀스'],['fig10','10_교차검증차트']];
for (const [id, name] of figs) {
  const el = page.locator(`#${id} svg`);
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await el.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`✓ ${name} (${(fs.statSync(path.join(OUT,`${name}.png`)).size/1024).toFixed(0)}KB)`);
}
await browser.close();
