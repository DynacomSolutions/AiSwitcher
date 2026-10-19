const modulePath = process.env.HOST_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("HOST_PLAYWRIGHT_MODULE must identify the isolated Playwright package.");
const { expect, test } = await import(modulePath.endsWith(".mjs") ? modulePath : `${modulePath}/index.mjs`);

test("device preview requires the exact identifier and refresh invalidates the old preview", async ({ page }: { page: any }) => {
  await page.clock.install({ time: new Date("2026-10-19T00:00:00Z") });
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Create a drive" })).toBeVisible();

  await page.getByLabel("Target device").selectOption("SYNTHETIC_FIXTURE_drive_usb_1");
  await page.getByRole("button", { name: "Preview create layout" }).click();

  const preview = page.getByRole("region", { name: "Device preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Create layout", { exact: true })).toBeVisible();
  await expect(preview.getByText("Current partitions")).toBeVisible();

  const typedIdentifier = await preview.getByTestId("device-identifier").textContent();
  // This is the fixture's displayed device identifier, not its separate model label.
  expect(typedIdentifier).toBe("Synthetic USB Drive");
  await preview.getByLabel("Type the device identifier to confirm").fill("SYNTHETIC_FIXTURE_wrong");
  await preview.getByRole("button", { name: "Confirm create layout" }).click();
  await expect(preview.getByRole("alert")).toContainText("Type the exact displayed device identifier");

  await preview.getByLabel("Type the device identifier to confirm").fill(typedIdentifier!);
  await preview.getByRole("button", { name: "Confirm create layout" }).click();
  await expect(preview.getByText("Confirmation expires in 90 seconds")).toBeVisible();
  await page.clock.fastForward(90_000);
  await expect(preview.getByRole("alert")).toContainText("Confirmation expired");

  const oldPreviewId = await preview.getByTestId("preview-id").textContent();
  await page.getByRole("button", { name: "Refresh devices" }).click();
  await expect(preview).toBeHidden();
  await page.getByLabel("Target device").selectOption("SYNTHETIC_FIXTURE_drive_usb_1");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByTestId("preview-id")).not.toHaveText(oldPreviewId ?? "");
});
