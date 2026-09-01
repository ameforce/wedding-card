import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("guestbook deletion requires an in-app confirmation and sends one request only after confirmation", { timeout: 60_000 }, async () => {
  const server = await createServer({
    root: projectRoot,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();

  const address = server.httpServer.address();
  assert.equal(typeof address, "object");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let deleteRequests = 0;

  try {
    await page.route("**/api/guestbook/entries/unlock", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ entry: { name: "브라우저 테스트", message: "삭제 확인 테스트" } }),
      });
    });
    await page.route("**/api/guestbook/entries", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
    });

    await page.goto(`http://127.0.0.1:${address.port}/?capture=1`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "내 글 수정", exact: true }).click();
    await page.getByLabel("이름", { exact: true }).fill("브라우저 테스트");
    await page.getByLabel(/비밀번호/).fill("test-password");
    await page.getByRole("button", { name: "내 글 불러오기", exact: true }).click();

    const deleteButton = page.getByRole("button", { name: "삭제", exact: true });
    await deleteButton.click();
    const dialog = page.getByRole("dialog", { name: "이 방명록을 삭제할까요?" });
    await dialog.waitFor({ state: "visible" });
    assert.equal(deleteRequests, 0);

    assert.equal(await page.locator("#root").getAttribute("inert"), "");
    const cancelButton = dialog.getByRole("button", { name: "취소", exact: true });
    const confirmButton = dialog.getByRole("button", { name: "삭제하기", exact: true });
    await cancelButton.waitFor({ state: "visible" });
    assert.equal(await cancelButton.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await confirmButton.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Tab");
    assert.equal(await cancelButton.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#root").getAttribute("inert"), null);
    assert.equal(await deleteButton.evaluate((element) => document.activeElement === element), true);
    assert.equal(deleteRequests, 0);

    await deleteButton.click();
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(deleteRequests, 0);
    await deleteButton.waitFor({ state: "visible" });

    await deleteButton.click();
    await page.getByRole("button", { name: "삭제하기", exact: true }).click();
    await page.getByRole("button", { name: "비공개로 전하기", exact: true }).waitFor({ state: "visible" });
    assert.equal(deleteRequests, 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
