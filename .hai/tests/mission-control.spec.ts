import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".mission-shell")).toBeVisible();
});

test("filters and disclosure retain keyboard focus", async ({ page }) => {
  await expect(page.locator(".intent-row")).toHaveCount(4);
  await expect(page.getByText("HUMAN AUTHORIZED").first()).toBeVisible();
  await expect(page.getByText("AGENT DERIVED").first()).toBeVisible();

  const contextDepth = page.locator("#depth-context");
  await contextDepth.focus();
  await contextDepth.press("Enter");
  await expect(page.locator("#depth-context")).toBeFocused();

  await page.locator("#intent-control-INT-002").press("Enter");
  await expect(page.locator("#intent-control-INT-002")).toBeFocused();
  await expect(page.locator(".context-bay .context-record")).toHaveCount(4);
  await expect(page).toHaveURL(/intent=INT-002.*depth=context/);

  await page.locator("#scope-filter").selectOption("project");
  await expect(page.locator("#scope-filter")).toBeFocused();
  await expect(page.locator(".intent-row")).toHaveCount(2);

  await page.locator("#intent-search").fill("cr-akashgit");
  await expect(page.locator("#intent-search")).toBeFocused();
  await expect(page.locator(".no-results")).toBeVisible();
  await page.locator("#reset-view").click();
  await expect(page.locator("#reset-view")).toBeFocused();
  await expect(page.locator(".intent-row")).toHaveCount(4);
});

test("renders provenance with actor identity and exact values", async ({ page }) => {
  await page.locator("#depth-provenance").click();
  await page.locator("#intent-control-INT-004").click();

  const chain = page.locator(".context-bay .evidence-chain");
  await expect(chain.locator(".evidence-chain-token--agent")).toContainText("A1");
  await expect(chain.locator(".evidence-chain-token--human")).toContainText("H6");

  await page.locator("#intent-control-INT-002").click();
  await page.locator('.context-bay [data-evidence="H2"]').click();
  await expect(page.locator("#evidence-dialog")).toBeVisible();
  await expect(page.locator("#evidence-dialog")).toContainText("terminal_no_retry");
  await expect(page.locator("#evidence-title")).toBeFocused();
  await page.getByRole("button", { name: "Close evidence" }).click();
  await expect(page.locator('.context-bay [data-evidence="H2"]').first()).toBeFocused();
});

test("mobile prioritizes the plan and keeps focused context adjacent", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  const planTop = (await page.locator(".authority-ledger").boundingBox())?.y;
  const controlsTop = (await page.locator(".control-rail").boundingBox())?.y;
  expect(planTop).toBeDefined();
  expect(controlsTop).toBeDefined();
  expect(planTop!).toBeLessThan(controlsTop!);

  await page.locator("#depth-provenance").click();
  await page.locator("#intent-control-INT-004").click();
  await expect(page.locator(".mobile-context-panel")).toBeVisible();
  await expect(page.locator(".context-bay--mobile-hidden")).toBeHidden();
  await expect(page.locator("#reset-view")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("reflows at the minimum supported viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.reload();

  await expect(page.locator(".intent-row")).toHaveCount(4);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await expect(page.locator("#scope-filter")).toBeVisible();
  await expect(page.locator("#lifecycle-filter")).toBeVisible();
});
