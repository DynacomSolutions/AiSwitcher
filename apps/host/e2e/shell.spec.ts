const modulePath = process.env.HOST_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("HOST_PLAYWRIGHT_MODULE must identify the isolated Playwright package.");
const { expect, test } = await import(modulePath.endsWith(".mjs") ? modulePath : `${modulePath}/index.mjs`);

test("drive content paths round-trip through browser history", async ({ page }: { page: any }) => {
  await page.goto("/drives");
  await expect(page.getByRole("heading", { name: "Drives" })).toBeVisible();
  await page.getByRole("link", { name: "Synthetic USB Drive" }).click();
  await expect(page).toHaveURL(/\/drives\/SYNTHETIC_FIXTURE_drive_usb_1$/);
  await expect(page.getByRole("heading", { name: "Synthetic USB Drive" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Synthetic USB Drive" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/drives$/);
  await expect(page.getByRole("heading", { name: "Drives" })).toBeVisible();
  const historyLength = await page.evaluate(() => history.length);
  await page.getByLabel("Filter drives").selectOption("ready");
  await expect(page).toHaveURL(/\/drives\?status=ready$/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.goForward();
  await expect(page).toHaveURL(/\/drives\/SYNTHETIC_FIXTURE_drive_usb_1$/);
});

test("direct missing-drive route is recoverable and keyboard accessible", async ({ page }: { page: any }) => {
  await page.goto("/drives/SYNTHETIC_FIXTURE_missing");
  await expect(page.getByRole("heading", { name: "Drive unavailable" })).toBeVisible();
  await page.getByRole("link", { name: "Return to drives" }).focus();
  await expect(page.getByRole("link", { name: "Return to drives" })).toBeFocused();
  await page.getByRole("link", { name: "Return to drives" }).click();
  await expect(page.getByRole("heading", { name: "Drives" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Operation running: 2 of 4 bytes");
  await expect(page.getByRole("progressbar", { name: "Operation progress" })).toHaveAttribute("value", "2");
});
