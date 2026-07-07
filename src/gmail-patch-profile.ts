import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, BrowserProfile } from "@opencomputer/sdk";
import { chromium, type Page } from "playwright";

type LogEvent = {
  timestamp: string;
  type: string;
  [key: string]: unknown;
};

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
loadDotEnv(join(rootDir, ".env"));

const profileName = requiredEnv("GMAIL_PROFILE_NAME");
const patchUrl = process.env.GMAIL_PATCH_URL || "https://mail.google.com/mail/u/0/h/";
const artifactDir = process.env.GMAIL_PATCH_ARTIFACT_DIR || join(rootDir, "artifacts", "gmail-patch-profile");
const events: LogEvent[] = [];

async function main() {
  requiredEnv("OPENCOMPUTER_API_KEY");
  await mkdir(artifactDir, { recursive: true });

  log("input", { profileName, patchUrl, artifactDir });

  const profile = await BrowserProfile.connect(profileName);
  log("profile", { id: profile.id, name: profile.name, providerProfileId: profile.providerProfileId });

  const browser = await Browser.create({
    headless: true,
    stealth: true,
    timeoutSeconds: 180,
    startUrl: patchUrl,
    tags: { demo: "gmail-profile-patch" },
    profile: {
      id: profile.id,
      saveChanges: true,
    },
    chromePolicy: {
      RestoreOnStartup: 4,
      RestoreOnStartupURLs: [patchUrl],
    },
  });
  log("browser_start", { id: browser.id, startUrl: patchUrl });

  let pwBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    pwBrowser = await chromium.connectOverCDP(browser.cdpWsUrl);
    const context = pwBrowser.contexts()[0] || await pwBrowser.newContext();

    for (const [index, existing] of context.pages().entries()) {
      existing.on("crash", () => log("page_crash", { index, url: safePageUrl(existing) }));
      await inspect(existing, `existing_${index}`).catch((err) => log("inspect_error", { index, message: String(err) }));
    }

    const patchPage = await context.newPage();
    let patchPageCrashed = false;
    patchPage.on("crash", () => {
      patchPageCrashed = true;
      log("page_crash", { role: "patch", url: safePageUrl(patchPage) });
    });
    await patchPage.goto(patchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
      log("patch_goto_error", { url: patchUrl, message: String(err) });
    });
    if (patchPageCrashed) {
      log("profile_patch", {
        result: "failed_restored_tab_crashed",
        note: "Profile restored the crashing Gmail tab before the patch URL could be saved.",
      });
      return;
    }
    await patchPage.waitForTimeout(3_000).catch((err) => {
      log("patch_wait_error", { message: String(err) });
    });
    if (patchPageCrashed) {
      log("profile_patch", {
        result: "failed_restored_tab_crashed",
        note: "Patch page crashed before restored tabs could be closed.",
      });
      return;
    }
    await inspect(patchPage, "patch_page_loaded");
    await capture(patchPage, "patch-page-loaded");

    for (const page of context.pages()) {
      if (page === patchPage) continue;
      await page.close({ runBeforeUnload: false }).catch((err) => {
        log("page_close_error", { url: safePageUrl(page), message: String(err) });
      });
    }
    log("profile_patch", { result: "closed_restored_tabs", remainingPages: context.pages().length });

    await patchPage.bringToFront().catch(() => undefined);
    await patchPage.waitForTimeout(2_000);
    await capture(patchPage, "before-delete-save");
  } finally {
    if (pwBrowser) await pwBrowser.close().catch(() => undefined);
    await browser.delete().catch((err) => log("browser_delete_error", { message: String(err) }));
    log("browser_delete", { id: browser.id, result: "done", note: "delete triggers saveChanges profile persistence" });
    await writeArtifacts();
  }
}

async function inspect(page: Page, note: string) {
  log("page_event", {
    note,
    url: safePageUrl(page),
    title: await page.title().catch(() => ""),
  });
}

async function capture(page: Page, label: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactDir, `${stamp}-${label}.png`);
  const htmlPath = join(artifactDir, `${stamp}-${label}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10_000 }).catch((err) => {
    log("screenshot_error", { label, message: String(err) });
  });
  await page.content().then((html) => writeFile(htmlPath, html, "utf8")).catch((err) => {
    log("html_error", { label, message: String(err) });
  });
  log("artifact", { label, screenshotPath, htmlPath });
}

async function writeArtifacts() {
  const logPath = join(artifactDir, "events.json");
  await writeFile(logPath, JSON.stringify(events, null, 2), "utf8");
  console.log(`Artifacts written to ${artifactDir}`);
}

function safePageUrl(page: Page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function log(type: string, fields: Record<string, unknown>) {
  const event = { timestamp: new Date().toISOString(), type, ...fields };
  events.push(event);
  console.log(`[${type}] ${JSON.stringify(fields)}`);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running this script.`);
  return value;
}

function loadDotEnv(path: string) {
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional; exported environment variables work too.
  }
}

main().catch(async (err) => {
  console.error(err);
  await writeArtifacts().catch(() => undefined);
  process.exit(1);
});
