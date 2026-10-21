const modulePath = process.env.HOST_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("HOST_PLAYWRIGHT_MODULE must identify the isolated Playwright package.");
const { expect, test } = await import(modulePath.endsWith(".mjs") ? modulePath : `${modulePath}/index.mjs`);

const DEVICE = "SYNTHETIC_FIXTURE_drive_usb_1";

async function begin(page: any) {
  await page.goto("/create");
  await page.getByLabel("Target device").selectOption(DEVICE);
}

test("only removable non-system drives are offered, with their identity", async ({ page }: { page: any }) => {
  await begin(page);
  const options = await page.getByLabel("Target device").locator("option").allTextContents();
  expect(options.join("|")).not.toContain("Synthetic System Disk");
  const identity = page.getByRole("definition");
  await expect(page.getByLabel("Selected device")).toContainText("Synthetic device");
  await expect(page.getByLabel("Selected device")).toContainText("SYNTHETIC_FIXTURE_serial_1");
  await expect(page.getByLabel("Selected device")).toContainText("USB");
  expect(await identity.count()).toBeGreaterThan(3);
});

test("passphrase rules stop the flow before any preview", async ({ page }: { page: any }) => {
  await begin(page);
  await page.getByLabel("Passphrase", { exact: true }).fill("short");
  await page.getByLabel("Confirm passphrase").fill("short");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByRole("alert")).toContainText("at least 12 characters");
  await expect(page.getByRole("region", { name: "Device preview" })).toBeHidden();

  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByLabel("Confirm passphrase").fill("SYNTHETIC_FIXTURE_13");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByRole("alert")).toContainText("differ");
  await expect(page.getByRole("region", { name: "Device preview" })).toBeHidden();
});

test("the model is declined by default and its licence is shown before acceptance", async ({ page }: { page: any }) => {
  await begin(page);
  await expect(page.getByLabel("No, do not download a model")).toBeChecked();
  await expect(page.getByRole("region", { name: "Model licence" })).toBeHidden();

  await page.getByLabel("Yes, include a pinned model").check();
  await page.getByLabel("Model", { exact: true }).selectOption("SYNTHETIC_FIXTURE_model");
  const licence = page.getByRole("region", { name: "Model licence" });
  await expect(licence).toContainText("SYNTHETIC_FIXTURE licence: use only for tests.");

  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByLabel("Confirm passphrase").fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByRole("alert")).toContainText("Accept the model licence");
  await expect(page.getByRole("region", { name: "Device preview" })).toBeHidden();

  await licence.getByLabel("I accept this licence").check();
  await page.getByRole("button", { name: "Preview create layout" }).click();
  await expect(page.getByRole("region", { name: "Device preview" })).toBeVisible();
});

test("a confirmed preview cannot write while the build forbids it", async ({ page }: { page: any }) => {
  await begin(page);
  await page.getByLabel("Passphrase", { exact: true }).fill("SYNTHETIC_FIXTURE_12");
  await page.getByLabel("Confirm passphrase").fill("SYNTHETIC_FIXTURE_12");
  await page.getByRole("button", { name: "Preview create layout" }).click();
  const preview = page.getByRole("region", { name: "Device preview" });
  await expect(preview.getByRole("button", { name: "Write to drive" })).toBeDisabled();
  await preview.getByLabel("Type the device identifier to confirm").fill("Synthetic USB Drive");
  await preview.getByRole("button", { name: "Confirm create layout" }).click();
  await preview.getByRole("button", { name: "Write to drive" }).click();
  await expect(preview.getByRole("alert")).toContainText("Writing is disabled in this build.");
});
