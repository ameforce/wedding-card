// Pastel 게이트폴드 인트로 로컬 QA 캡처 (프리뷰 서버 http://localhost:4173 필요)
import { chromium } from "playwright";

const BASE = process.env.INTRO_QA_BASE || "http://localhost:4173";
const OUT = "artifacts/qa";

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

await page.goto(`${BASE}/`);
await page.waitForSelector(".intro-cover", { timeout: 5000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/intro-1-ribbon.png` });
await page.waitForTimeout(760);
await page.screenshot({ path: `${OUT}/intro-2-frame-f15.png` });
await page.waitForTimeout(1840);
const midPanelTransform = await page.evaluate(() => {
  const el = document.querySelector(".intro-cover__panel--left");
  return el ? getComputedStyle(el).transform : null;
});
await page.screenshot({ path: `${OUT}/intro-3-panels-open.png` });
await page.waitForTimeout(1100);
await page.screenshot({ path: `${OUT}/intro-4-reveal.png` });
await page.waitForTimeout(1400);
const afterPlay = await page.evaluate(() => ({
  cover: Boolean(document.querySelector(".intro-cover")),
  bodyLocked: document.body.classList.contains("intro-lock"),
}));
await page.reload();
await page.waitForTimeout(500);
const replaySuppressed = await page.evaluate(() => ({
  cover: Boolean(document.querySelector(".intro-cover")),
}));
await page.goto(`${BASE}/?capture=1`);
await page.waitForTimeout(500);
const captureMode = await page.evaluate(() => ({
  cover: Boolean(document.querySelector(".intro-cover")),
  isCapture: Boolean(document.querySelector("main.is-capture")),
}));
await page.goto(`${BASE}/?variant=quiet`);
await page.waitForTimeout(500);
const quietVariant = await page.evaluate(() => ({
  cover: Boolean(document.querySelector(".intro-cover")),
}));

console.log(JSON.stringify({ midPanelTransform, afterPlay, replaySuppressed, captureMode, quietVariant, consoleErrors }, null, 2));
await context.close();
await browser.close();
