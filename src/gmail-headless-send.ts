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

type CrashGuard = {
  crashed: boolean;
  wait<T>(label: string, promise: Promise<T>): Promise<T>;
};

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
loadDotEnv(join(rootDir, ".env"));

const profileName = requiredEnv("GMAIL_PROFILE_NAME");
const to = requiredEnv("GMAIL_TO");
const subject = process.env.GMAIL_SUBJECT || "Hello from OpenComputer";
const body = process.env.GMAIL_BODY || "Testing a headless Gmail send from OpenComputer.";
const artifactDir = process.env.GMAIL_ARTIFACT_DIR || join(rootDir, "artifacts", "gmail-headless");
const events: LogEvent[] = [];

async function main() {
  requiredEnv("OPENCOMPUTER_API_KEY");
  await mkdir(artifactDir, { recursive: true });

  log("input", { profileName, to, subject, artifactDir });

  const profile = await BrowserProfile.connect(profileName);
  log("profile", {
    id: profile.id,
    name: profile.name,
    providerProfileId: profile.providerProfileId,
    providerLastUsedAt: profile.providerLastUsedAt,
  });

  const browser = await Browser.create({
    headless: true,
    stealth: true,
    timeoutSeconds: 300,
    startUrl: "https://mail.google.com/",
    tags: { demo: "gmail-headless-send" },
    profile: {
      id: profile.id,
      saveChanges: true,
    },
  });
  log("browser_start", { id: browser.id, headless: browser.headless, startUrl: "https://mail.google.com/" });

  let pwBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  let page: Page | null = null;
  let pageCrashed = false;
  let finalStatus = "unknown";

  try {
    pwBrowser = await chromium.connectOverCDP(browser.cdpWsUrl);
    const context = pwBrowser.contexts()[0] || await pwBrowser.newContext();
    page = context.pages()[0] || await context.newPage();
    const crashGuard = createCrashGuard(page);

    await inspect(page, "initial");
    await captureStep(page, "01-initial", crashGuard);
    await crashGuard.wait(
      "goto_inbox",
      page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded", timeout: 60_000 }),
    );
    await inspect(page, "after_goto_inbox");
    await captureStep(page, "02-after-goto-inbox", crashGuard);
    await crashGuard.wait("initial_settle", page.waitForTimeout(5_000));
    await inspect(page, "after_initial_settle");
    await captureStep(page, "03-after-initial-settle", crashGuard);

    const challenge = await detectGoogleFriction(page, crashGuard);
    if (challenge.detected) {
      finalStatus = "blocked_by_google_challenge";
      await capture(page, "google-challenge", challenge, crashGuard);
      return;
    }

    await composeAndSend(page, crashGuard);
    await inspect(page, "after_send_attempt");

    const postSendChallenge = await detectGoogleFriction(page, crashGuard);
    if (postSendChallenge.detected) {
      finalStatus = "blocked_by_google_challenge_after_send";
      await capture(page, "google-challenge-after-send", postSendChallenge, crashGuard);
      return;
    }

    finalStatus = "send_attempt_completed";
    await capture(page, "send-attempt-completed", { note: "No challenge detected after send attempt." }, crashGuard);
  } catch (err) {
    finalStatus = "error";
    pageCrashed = err instanceof Error && err.message.includes("crashed");
    log("error", { message: err instanceof Error ? err.message : String(err) });
    if (page && !pageCrashed) {
      await capture(page, "error", { message: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    } else if (pageCrashed) {
      log("artifact_skipped", { label: "error", reason: "page crashed before screenshot/html capture" });
    }
    throw err;
  } finally {
    if (pwBrowser) await pwBrowser.close().catch(() => undefined);
    await browser.delete().catch((err) => log("browser_delete_error", { message: String(err) }));
    log("browser_delete", { id: browser.id, result: "done", finalStatus });
    await writeArtifacts();
  }

  if (finalStatus !== "send_attempt_completed") {
    process.exitCode = 2;
  }
}

async function composeAndSend(page: Page, crashGuard: CrashGuard) {
  log("send_step", { step: "waiting_for_gmail_controls" });
  await captureStep(page, "04-before-waiting-for-gmail-controls", crashGuard);
  await crashGuard.wait(
    "wait_for_gmail_controls",
    page.waitForSelector("a, button, input, textarea, [role='button']", { state: "attached", timeout: 30_000 }),
  );
  await captureStep(page, "05-after-gmail-controls-attached", crashGuard);

  const composeButton = page.getByRole("button", { name: /^Compose$/i }).first();
  if (await crashGuard.wait("compose_visible", composeButton.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await crashGuard.wait("compose_click", composeButton.click({ timeout: 10_000 }));
  } else {
    await crashGuard.wait(
      "compose_fallback_click",
      page.locator("div[role='button'][gh='cm'], .T-I.T-I-KE").first().click({ timeout: 10_000 }),
    );
  }
  log("send_step", { step: "compose_opened" });
  await captureStep(page, "06-compose-clicked", crashGuard);

  const dialog = page.locator("div[role='dialog']").last();
  await crashGuard.wait("compose_dialog_visible", dialog.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined));
  await captureStep(page, "07-compose-dialog-visible", crashGuard);

  const toField = page.locator(
    "textarea[name='to'], input[aria-label*='To recipients' i], textarea[aria-label*='To' i], input[aria-label*='Recipients' i]"
  ).last();
  await crashGuard.wait("fill_to", toField.fill(to, { timeout: 15_000 }));
  await crashGuard.wait("press_to_enter", page.keyboard.press("Enter").catch(() => undefined));

  await crashGuard.wait("fill_subject", page.locator("input[name='subjectbox']").last().fill(subject, { timeout: 15_000 }));

  const bodyField = page.locator(
    "div[aria-label='Message Body'][contenteditable='true'], div[role='textbox'][contenteditable='true']"
  ).last();
  await crashGuard.wait("body_click", bodyField.click({ timeout: 15_000 }));
  await crashGuard.wait("fill_body", bodyField.fill(body, { timeout: 15_000 }));
  log("send_step", { step: "draft_filled" });
  await captureStep(page, "08-draft-filled", crashGuard);

  try {
    await crashGuard.wait("send_click", page.getByRole("button", { name: /^Send$/i }).last().click({ timeout: 10_000 }));
  } catch {
    await crashGuard.wait(
      "send_fallback_click",
      page.locator("div[role='button'][aria-label^='Send'], div[data-tooltip^='Send']").last().click({ timeout: 10_000 }),
    );
  }
  log("send_step", { step: "send_clicked" });
  await captureStep(page, "09-send-clicked", crashGuard);
  await crashGuard.wait("after_send_settle", page.waitForTimeout(5_000));
  await captureStep(page, "10-after-send-settle", crashGuard);
}

async function inspect(page: Page, note: string) {
  log("page_event", {
    note,
    url: page.url(),
    title: await page.title().catch(() => ""),
  });
}

async function detectGoogleFriction(page: Page, crashGuard: CrashGuard) {
  const result = await crashGuard.wait("detect_google_friction", page.evaluate(() => {
    const text = document.body?.innerText || "";
    const url = location.href;
    const title = document.title;
    const patterns = [
      /captcha/i,
      /security challenge/i,
      /verify it'?s you/i,
      /verify that it'?s you/i,
      /suspicious activity/i,
      /unusual traffic/i,
      /couldn'?t verify/i,
      /this browser or app may not be secure/i,
      /to help keep your account secure/i,
      /confirm it'?s you/i,
      /passkey/i,
      /2-step verification/i,
      /two-step verification/i,
    ];
    const matched = patterns.find((pattern) => pattern.test(text) || pattern.test(url) || pattern.test(title));
    return {
      detected: Boolean(matched) || /accounts\.google\.com|ServiceLogin|signin/i.test(url),
      matched: matched ? String(matched) : null,
      url,
      title,
      textSample: text.replace(/\s+/g, " ").slice(0, 1200),
    };
  }));
  log("friction_check", result);
  return result;
}

async function capture(page: Page, label: string, extra: Record<string, unknown>, crashGuard?: CrashGuard) {
  if (crashGuard?.crashed) {
    log("artifact_skipped", { label, reason: "page crashed before screenshot/html capture" });
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}-${label}`;
  const screenshotPath = join(artifactDir, `${base}.png`);
  const htmlPath = join(artifactDir, `${base}.html`);

  await withTimeout(page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10_000 }), 12_000, `screenshot:${label}`).catch((err) => {
    log("screenshot_error", { label, message: String(err) });
  });
  await withTimeout(page.content(), 8_000, `html:${label}`).then((html) => writeFile(htmlPath, html, "utf8")).catch((err) => {
    log("html_error", { label, message: String(err) });
  });

  log("artifact", {
    label,
    screenshotPath,
    htmlPath,
    ...extra,
  });
}

async function captureStep(page: Page, label: string, crashGuard: CrashGuard) {
  await capture(page, label, {
    step: true,
    url: page.url(),
    title: await page.title().catch(() => ""),
  }, crashGuard);
}

function createCrashGuard(page: Page): CrashGuard {
  let crashed = false;
  let rejectCrash: (err: Error) => void = () => undefined;
  const crashPromise = new Promise<never>((_, reject) => {
    rejectCrash = reject;
  });
  // The page may crash while the script is between awaited Playwright calls.
  // Keep Node from treating that stored rejection as uncaught; active waits
  // still observe the original promise through Promise.race below.
  crashPromise.catch(() => undefined);

  page.on("crash", () => {
    crashed = true;
    const url = safePageUrl(page);
    log("page_crash", { url });
    rejectCrash(new Error(`Page crashed while running Gmail headless flow at ${url}`));
  });

  return {
    get crashed() {
      return crashed;
    },
    wait<T>(label: string, promise: Promise<T>) {
      // If crashPromise wins the race, Playwright's original operation can
      // still reject later with "Page crashed". Mark that rejection observed so
      // Node does not surface it as an uncaught exception after cleanup starts.
      promise.catch(() => undefined);
      if (crashed) {
        return Promise.reject(new Error(`Page already crashed before ${label}`));
      }
      return Promise.race([promise, crashPromise]);
    },
  };
}

function safePageUrl(page: Page) {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function writeArtifacts() {
  const logPath = join(artifactDir, "events.json");
  await writeFile(logPath, JSON.stringify(events, null, 2), "utf8");
  console.log(`Artifacts written to ${artifactDir}`);
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
