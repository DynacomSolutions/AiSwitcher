const modulePath = process.env.HOST_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("HOST_PLAYWRIGHT_MODULE must identify the isolated Playwright package.");
const { expect, test } = await import(modulePath.endsWith(".mjs") ? modulePath : `${modulePath}/index.mjs`);

test("device preview requires the exact identifier and refresh invalidates the old preview", async ({ page }: { page: any }) => {
  await page.clock.install({ time: new Date("2026-10-19T00:00:00Z") });
  await page.goto("/create");
  await expect(page.getByRole("heading", { name: "Create a drive" })).toBeVisible();

  await page.getByLabel("Target device").selectOption("SYNTHETIC_FIXTURE_drive_usb_1");
  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByLabel("Confirm passphrase").fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview create layout" }).click();

  const preview = page.getByRole("region", { name: "Device preview" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Create layout", { exact: true })).toBeVisible();
  await expect(preview.getByText("Current partitions")).toBeVisible();
  await expect(preview.getByText("Synthetic device", { exact: true })).toBeVisible();
  await expect(preview.getByText("SYNTHETIC_FIXTURE_serial_1", { exact: true })).toBeVisible();
  await expect(preview.getByText("SYNTHETIC_FIXTURE_CONNECTION", { exact: true })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "SYNTHETIC_FIXTURE_serial_1" })).toHaveCount(1);

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
  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByLabel("Confirm passphrase").fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByTestId("preview-id")).not.toHaveText(oldPreviewId ?? "");
});

test("known drive update requires exact confirmation and expires", async ({ page }: { page: any }) => {
  await page.clock.install({ time: new Date("2026-10-19T00:00:00Z") });
  await page.goto("/drives/SYNTHETIC_FIXTURE_drive_usb_1");
  await page.getByRole("link", { name: "Update", exact: true }).click();
  await expect(page).toHaveURL(/\/drives\/SYNTHETIC_FIXTURE_drive_usb_1\/update$/);
  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview update", exact: true }).click();
  const preview = page.getByRole("region", { name: "Update preview" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("AISX: 600,000,000 bytes preserved");
  await expect(preview).toContainText("AISPERSIST: 2,147,483,648 bytes preserved");
  await expect(page.getByRole("button", { name: "Write update", exact: true })).toBeDisabled();
  await page.getByLabel("Type the device identifier to confirm").fill("SYNTHETIC_FIXTURE_wrong");
  await page.getByRole("button", { name: "Confirm image update" }).click();
  await expect(page.getByRole("alert")).toContainText("exact displayed device identifier");
  await page.getByLabel("Type the device identifier to confirm").fill("Synthetic USB Drive");
  await page.getByRole("button", { name: "Confirm image update" }).click();
  await expect(page.getByRole("button", { name: "Write update", exact: true })).toBeEnabled();
  await page.clock.fastForward(90_000);
  await expect(preview).toBeHidden();
  await expect(page.getByRole("alert")).toContainText("Confirmation expired");

  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview update", exact: true }).click();
  await expect(preview).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_changed");
  await expect(preview).toBeHidden();
  await page.getByRole("link", { name: "Back to drives", exact: true }).click();
  await page.goto("/drives/SYNTHETIC_FIXTURE_drive_system_1");
  await expect(page.getByRole("link", { name: "Update", exact: true })).toHaveCount(0);
});
