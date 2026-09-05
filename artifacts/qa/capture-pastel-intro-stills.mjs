// 인트로 전용 클린 영화 + 360/1440px 반응형 스틸 캡처
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const browser = await chromium.launch();

// 1) 390x844 인트로 전용 녹화
const videoContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  recordVideo: { dir: "artifacts/qa", size: { width: 390, height: 844 } },
});
const videoPage = await videoContext.newPage();
await videoPage.goto(`${BASE}/`);
await videoPage.waitForSelector(".intro-cover", { timeout: 5000 });
await videoPage.waitForTimeout(5000);
await videoContext.close();

// 2) 360px 개봉 중간 스틸
const narrow = await browser.newContext({ viewport: { width: 360, height: 740 } });
const narrowPage = await narrow.newPage();
await narrowPage.goto(`${BASE}/`);
await narrowPage.waitForSelector(".intro-cover", { timeout: 5000 });
await narrowPage.waitForTimeout(2600);
await narrowPage.screenshot({ path: "artifacts/qa/intro-360-panels-open.png" });
await narrowContextClose(narrow);

// 3) 1440px 개봉 중간 스틸
const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const widePage = await wide.newPage();
await widePage.goto(`${BASE}/`);
await widePage.waitForSelector(".intro-cover", { timeout: 5000 });
await widePage.waitForTimeout(2600);
await widePage.screenshot({ path: "artifacts/qa/intro-1440-panels-open.png" });
await wide.close();

await browser.close();

async function narrowContextClose(context) {
  await context.close();
}
