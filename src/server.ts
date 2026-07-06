import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, BrowserProfile } from "@opencomputer/sdk";
import { chromium } from "playwright";

type ActiveSession = {
  browser: Browser;
  profileId: string;
  profileName: string;
  marker: string;
  deletePromise?: Promise<void>;
};

type CloseRequest = {
  browserId?: string;
};

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "..");
const publicDir = join(rootDir, "public");

loadDotEnv(join(rootDir, ".env"));

const port = Number(process.env.PORT || "8790");
const defaultProfileName = process.env.OC_BROWSER_PROFILE_NAME || "save-changes-auto-demo";
const markerKey = "opencomputer-save-changes-demo";
const markerUrl = "https://example.com";
const sessions = new Map<string, ActiveSession>();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "POST" && url.pathname === "/api/start") {
      return await startSession(res);
    }

    if (req.method === "POST" && url.pathname === "/api/close") {
      const body = await readJson<CloseRequest>(req);
      return await closeSession(clean(body.browserId), res);
    }

    if (req.method === "POST" && url.pathname === "/api/verify") {
      return await verifyProfile(res);
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    return sendJson(res, 405, { error: "method_not_allowed" });
  } catch (err) {
    return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, () => {
  console.log(`Browser save_changes demo: http://localhost:${port}`);
});

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function startSession(res: ServerResponse) {
  requireApiKey();

  const profile = await getOrCreateProfile(defaultProfileName);
  const marker = `saved-${Date.now()}`;
  const browser = await Browser.create({
    headless: true,
    startUrl: markerUrl,
    timeoutSeconds: 300,
    tags: { demo: "save-changes-auto-close" },
    profile: {
      id: profile.id,
      saveChanges: true,
    },
  });

  sessions.set(browser.id, {
    browser,
    profileId: profile.id,
    profileName: profile.name || defaultProfileName,
    marker,
  });

  await writeMarker(browser, marker);

  return sendJson(res, 200, {
    browser: {
      id: browser.id,
      headless: true,
      status: browser.status,
    },
    profile: {
      id: profile.id,
      name: profile.name,
    },
    marker,
    closeBehavior: "Closing this local tab calls /api/close with sendBeacon. The server deletes the managed browser, which triggers profile save.",
  });
}

async function closeSession(browserId: string, res: ServerResponse) {
  if (!browserId) return sendJson(res, 400, { error: "browser_id_required" });

  const deleted = await deleteManagedBrowser(browserId);
  return sendJson(res, deleted ? 200 : 404, {
    browserId,
    deleted,
    profileSaveTriggered: deleted,
  });
}

async function verifyProfile(res: ServerResponse) {
  requireApiKey();

  const profile = await BrowserProfile.connect(defaultProfileName);
  const browser = await Browser.create({
    headless: true,
    startUrl: markerUrl,
    timeoutSeconds: 120,
    tags: { demo: "save-changes-auto-close-verify" },
    profile: { id: profile.id },
  });

  try {
    const restored = await readMarker(browser);
    return sendJson(res, 200, {
      profile: {
        id: profile.id,
        name: profile.name,
      },
      restored,
      markerKey,
      ok: Boolean(restored),
    });
  } finally {
    await browser.delete().catch(() => undefined);
  }
}

async function writeMarker(browser: Browser, marker: string) {
  const pwBrowser = await chromium.connectOverCDP(browser.cdpWsUrl);
  try {
    const context = pwBrowser.contexts()[0] || await pwBrowser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(markerUrl);
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: markerKey, value: marker },
    );
  } finally {
    await pwBrowser.close().catch(() => undefined);
  }
}

async function readMarker(browser: Browser) {
  const pwBrowser = await chromium.connectOverCDP(browser.cdpWsUrl);
  try {
    const context = pwBrowser.contexts()[0] || await pwBrowser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(markerUrl);
    return await page.evaluate((key) => localStorage.getItem(key), markerKey);
  } finally {
    await pwBrowser.close().catch(() => undefined);
  }
}

async function getOrCreateProfile(name: string) {
  try {
    return await BrowserProfile.connect(name);
  } catch {
    return await BrowserProfile.create({ name });
  }
}

async function deleteManagedBrowser(browserId: string) {
  const active = sessions.get(browserId);
  if (active?.deletePromise) {
    await active.deletePromise;
    return true;
  }

  if (active) {
    active.deletePromise = active.browser.delete().finally(() => {
      sessions.delete(browserId);
    });
    await active.deletePromise;
    return true;
  }

  try {
    const browser = await Browser.connect(browserId);
    await browser.delete();
    return true;
  } catch {
    return false;
  }
}

async function shutdown(signal: string) {
  console.log(`\n${signal}: deleting ${sessions.size} active browser session(s) to trigger profile saves...`);
  await Promise.allSettled([...sessions.keys()].map((browserId) => deleteManagedBrowser(browserId)));
  process.exit(signal === "SIGTERM" ? 143 : 130);
}

function serveStatic(pathname: string, res: ServerResponse) {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (file.includes("..")) return sendJson(res, 400, { error: "bad_path" });

  readFile(join(publicDir, file), (err, body) => {
    if (err) return sendJson(res, 404, { error: "not_found" });
    const type = extname(file) === ".js"
      ? "text/javascript; charset=utf-8"
      : extname(file) === ".css"
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as T : {} as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function requireApiKey() {
  if (!process.env.OPENCOMPUTER_API_KEY) {
    throw new Error("Set OPENCOMPUTER_API_KEY before running this demo.");
  }
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
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
