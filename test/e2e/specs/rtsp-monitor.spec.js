import { expect, test } from "@playwright/test";
import { login, restoreSqliteSnapshot, screenshot } from "../util-test";
import sharp from "sharp";

test("stream protocol controls stay consistent and verified TLS capture fails closed", async ({ page }, testInfo) => {
    const native = await require("../../../server/monitor-types/rtsp/frame-capture").probeNativeSupport();
    test.skip(Boolean(native.nodeAv || native.sharp), "native dependencies unavailable for frame capture controls");
    await restoreSqliteSnapshot();
    await page.goto("./add");
    await login(page);
    await page.getByTestId("monitor-type-select").selectOption("rtsp");
    await page.locator("#rtsp-url").fill("rtsp://camera.example/live");
    await page.locator("#rtsp-protocol").selectOption("rtsps");
    await expect(page.locator("#rtsp-url")).toHaveValue("rtsps://camera.example/live");
    await page.locator("#rtsp-url").fill("rtmp://camera.example/live");
    await expect(page.locator("#rtsp-protocol")).toHaveValue("rtmp");
    await page.locator("#rtsp-url").fill("rtsps://camera.example/live");
    await expect(page.locator("#rtsp-protocol")).toHaveValue("rtsps");

    const enhanced = page.locator("#rtsp-mode-enhanced");
    await expect(page.locator("#rtsp-mode-basic")).toBeChecked();
    await expect(enhanced).toBeEnabled();
    await page.locator('label[for="rtsp-mode-enhanced"]').click();
    await expect(page.getByText("Verified TLS frame capture is unavailable", { exact: false })).toBeVisible();
    await screenshot(testInfo, page);
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.locator(".alert-danger")).toContainText("Verified TLS frame capture is unavailable");
    await page.locator("#ignore-tls").check();
    await expect(page.getByText("Verified TLS frame capture is unavailable because", { exact: false })).toBeHidden();
});

test("a binary reference upload survives socket parsing, canonicalization and reload", async ({ page }) => {
    const native = await require("../../../server/monitor-types/rtsp/frame-capture").probeNativeSupport();
    test.skip(Boolean(native.nodeAv || native.sharp), "native dependencies unavailable for Full mode controls");
    await restoreSqliteSnapshot();
    await page.goto("./add");
    await login(page);
    await page.getByTestId("monitor-type-select").selectOption("rtsp");
    await page.getByTestId("friendly-name-input").fill("RTSP reference regression");
    await page.locator("#rtsp-url").fill("rtsp://127.0.0.1:1/stream");
    await expect(page.locator("#rtsp-mode-full")).toBeEnabled();
    await page.locator('label[for="rtsp-mode-full"]').click();
    await page.locator("#rtsp-separate-dn").uncheck();
    await page.getByTestId("save-button").click();
    await page.waitForURL("/dashboard/*");
    const monitorId = page.url().split("/").pop();
    await page.goto(`./edit/${monitorId}`);
    const png = await sharp({ create: { width: 900, height: 700, channels: 3, background: "#336699" } }).png().toBuffer();
    await page.locator("#upload-single").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".ref-thumb")).toBeVisible();
    await expect(page.locator(".ref-thumb")).toHaveJSProperty("naturalWidth", 640);
    await page.reload();
    await expect(page.locator(".ref-thumb")).toBeVisible();
    await expect(page.locator(".ref-thumb")).toHaveJSProperty("naturalWidth", 640);
});
