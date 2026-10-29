/** M0: the app launches securely, shows the start screen and intended-use statement; screenshot matrix. */
import { expect, test } from "@playwright/test";
import {
  expectNoErrors,
  launch,
  screenshot,
  type Lang,
  type Theme,
} from "./harness";

test("launches with hardened renderer and no console errors", async () => {
  const s = await launch();
  try {
    const { page } = s;
    await expect(page.getByTestId("start-screen")).toBeVisible();
    await expect(page.getByTestId("intended-badge")).toContainText(
      "Tanısal amaçlı değildir",
    );

    // Renderer has no Node, only the allow-listed API.
    const probe = await page.evaluate(() => ({
      hasProcess:
        typeof (globalThis as { process?: unknown }).process !== "undefined",
      hasRequire:
        typeof (globalThis as { require?: unknown }).require !== "undefined",
      apiKeys: Object.keys((window as unknown as { api: object }).api).sort(),
      origin: location.origin,
      csp:
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content") ?? "",
    }));
    expect(probe.hasProcess).toBe(false);
    expect(probe.hasRequire).toBe(false);
    expect(probe.origin).toBe("app://bundle");
    expect(probe.csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(probe.apiKeys).toContain("readFile");
    expect(probe.apiKeys).toEqual(
      [
        "answerZipPassword",
        "appInfo",
        "cancelScan",
        "clearSession",
        "copyText",
        "fileLocation",
        "getSettings",
        "on",
        "open",
        "openDropped",
        "readFile",
        "readOverlays",
        "readTags",
        "recentList",
        "recentOpen",
        "recentRemove",
        "revealFile",
        "setFullscreen",
        "setSettings",
      ].sort(),
    );
    expect(probe.apiKeys).not.toContain("ipcRenderer");

    // window.open and navigation to remote content are blocked; no network.
    const opened = await page.evaluate(
      () => window.open("https://example.com") === null,
    );
    expect(opened).toBe(true);
    // The deliberate remote fetch below must be refused; its CSP console messages are expected.
    s.allowErrors(/example\.com|Refused to connect|connect-src|ERR_BLOCKED/);
    const fetched = await page.evaluate(async () => {
      try {
        await fetch("https://example.com");
        return "reached";
      } catch {
        return "blocked";
      }
    });
    expect(fetched).toBe("blocked");

    // Sandbox flags of the window.
    const prefs = await s.app.evaluate(({ BrowserWindow }) => {
      // getLastWebPreferences exists at runtime but is not in Electron's public typings.
      const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): {
          sandbox?: boolean;
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
        } | null;
      };
      const p = wc.getLastWebPreferences();
      return {
        sandboxed: p?.sandbox,
        ctx: p?.contextIsolation,
        node: p?.nodeIntegration,
      };
    });
    expect(prefs).toEqual({ sandboxed: true, ctx: true, node: false });

    // WebGL path is used (not the CPU fallback).
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __cdv: { cpuRendering(): boolean } }
        ).__cdv.cpuRendering(),
      ),
    ).toBe(false);

    // About dialog shows the full intended-use statement in both languages.
    await page.getByTestId("intended-badge").click();
    await expect(page.getByTestId("about-dialog")).toContainText(
      "Tanısal amaçlı değildir",
    );
    await expect(page.getByTestId("about-dialog")).toContainText(
      "Not for primary diagnosis",
    );
    await page.keyboard.press("Escape");
    expectNoErrors(s);

    // Last: renderer-initiated navigation to remote content is cancelled (checked from the main process,
    // because Playwright keeps waiting for the blocked navigation inside the page).
    void page.evaluate(() => {
      location.href = "https://example.com/";
    });
    await new Promise((r) => setTimeout(r, 800));
    const url = await s.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getURL(),
    );
    expect(url).toBe("app://bundle/index.html");
  } finally {
    await s.close();
  }
});

const SIZES: [number, number][] = [
  [1280, 800],
  [1920, 1080],
];
const THEMES: Theme[] = ["dark", "light"];
const LANGS: Lang[] = ["tr", "en"];

test("start screen and dialogs screenshot matrix", async () => {
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      const s = await launch({ lang, theme });
      try {
        for (const [w, h] of SIZES) {
          await s.page.evaluate(() => undefined);
          const { setSize } = await import("./harness");
          await setSize(s.app, w, h);
          const tag = `${w}x${h}-${theme}-${lang}`;
          await screenshot(s.page, "M0", `start-${tag}`);
          if (w === 1280) {
            await s.page.getByTestId("tb-about").click();
            await expect(s.page.getByTestId("about-dialog")).toBeVisible();
            await screenshot(s.page, "M0", `about-${tag}`);
            await s.page.keyboard.press("Escape");
            await s.page.getByTestId("tb-settings").click();
            await expect(s.page.getByTestId("settings-dialog")).toBeVisible();
            await screenshot(s.page, "M0", `settings-${tag}`);
            await s.page.keyboard.press("Escape");
            await s.page.getByTestId("tb-help").click();
            await expect(s.page.getByTestId("shortcuts-dialog")).toBeVisible();
            await screenshot(s.page, "M0", `shortcuts-${tag}`);
            await s.page.keyboard.press("Escape");
          }
        }
        expectNoErrors(s);
      } finally {
        await s.close();
      }
    }
  }
});

test("splash shows the intended-use statement", async () => {
  const { _electron } = await import("@playwright/test");
  const { MAIN } = await import("./harness");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cdv-e2e-"));
  const app = await _electron.launch({
    args: [MAIN],
    env: { ...process.env, CDV_E2E: "1", CDV_USER_DATA: userData },
    chromiumSandbox: true,
  });
  const errors: string[] = [];
  app.on("console", (m) => {
    if (m.type() === "error") errors.push(`[main] ${m.text()}`);
  });
  try {
    const page = await app.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`[renderer] ${m.text()}`);
    });
    page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
    await expect(page.getByTestId("splash")).toContainText(
      "Tanısal amaçlı değildir",
    );
    await screenshot(page, "M0", "splash-1440x900-dark-tr");
    await expect(page.getByTestId("splash")).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
