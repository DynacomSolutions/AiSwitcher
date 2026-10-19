const baseURL = "http://localhost:1420";

export default {
  testDir: "./e2e",
  timeout: 15_000,
  use: {
    baseURL,
    browserName: "chromium",
    headless: true,
    launchOptions: process.env.HOST_CHROMIUM_PATH ? { executablePath: process.env.HOST_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "bun run dev:test -- --host localhost --port 1420 --strictPort",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 15_000,
  },
};
