import { Browser } from "@opencomputer/sdk";

export function browserApiUrl() {
  return (process.env.OPENCOMPUTER_BROWSER_API_URL || "https://browser.opencomputer.dev").replace(/\/+$/, "");
}

export function browserApiKey() {
  const key = process.env.OPENCOMPUTER_API_KEY;
  if (!key) throw new Error("Set OPENCOMPUTER_API_KEY before running this script.");
  return key;
}

export async function createBrowserRaw(body: Record<string, unknown>) {
  const apiUrl = browserApiUrl();
  const apiKey = browserApiKey();
  const resp = await fetch(`${apiUrl}/v1/browsers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Raw browser create failed: ${resp.status} ${text}`);
  }

  return new Browser(JSON.parse(text), apiUrl, apiKey);
}

export async function patchBrowserRaw(browserId: string, body: Record<string, unknown>) {
  const apiUrl = browserApiUrl();
  const apiKey = browserApiKey();
  const resp = await fetch(`${apiUrl}/v1/browsers/${encodeURIComponent(browserId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Raw browser patch failed: ${resp.status} ${text}`);
  }

  return new Browser(JSON.parse(text), apiUrl, apiKey);
}
