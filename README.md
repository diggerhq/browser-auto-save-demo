# Browser `save_changes` Auto-Close Demo

This demo creates a headless OpenComputer Browser Session with a profile and
`saveChanges: true`. The local page automatically asks the server to delete the
managed browser when the page is closed or navigated away from. That delete is
what triggers profile persistence.

The demo writes a harmless `localStorage` marker on `https://example.com`, then
verifies persistence by opening a second headless browser with the same profile.
Auth cookies and local storage use the same profile persistence path.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:8790`.

Set `OPENCOMPUTER_API_KEY` to an API key for an org with Browser Sessions
enabled. For dev Browser API testing, set `OPENCOMPUTER_BROWSER_API_URL`.

## Flow

1. Click `Start Headless Session`.
2. The server creates a profile-backed browser with `saveChanges: true`.
3. The server writes a marker into browser storage.
4. Closing the local tab sends a best-effort close event to the server.
5. The server deletes the OpenComputer browser session, triggering profile save.
6. Reopen the page and click `Verify Saved Profile` to confirm the marker was restored.

There is no `Save Auth` button. The important implementation detail is that
the managed browser must be deleted or allowed to time out; closing only a
Playwright page/browser is not enough to persist the profile.

## Headless Gmail Challenge Screenshot Test

This repo also includes a deliberately best-effort Gmail web-UI send test. It
uses a saved profile in headless mode, attempts to compose and send one email,
and writes screenshots/HTML/logs when Google shows sign-in, captcha, or account
security friction.

Configure `.env`:

```bash
OPENCOMPUTER_API_KEY=osb_...
GMAIL_PROFILE_NAME=scout-digger:sgp_test:684a2b2ca18a1424:google
GMAIL_TO=mo@digger.dev
GMAIL_SUBJECT=Hi Mo!
GMAIL_BODY=Who are you rooting for in the World Cup?
# Optional: use Gmail's basic HTML UI instead of the heavier JS UI.
GMAIL_MODE=html
# Optional: start a blank browser first, then attach the profile to avoid restored Gmail tabs.
GMAIL_ATTACH_PROFILE_AFTER_START=1
```

Run:

```bash
npm run gmail:headless
```

For accounts where the full Gmail JavaScript inbox crashes in headless mode,
try:

```bash
GMAIL_MODE=html npm run gmail:headless
```

If the saved profile restores a heavy Gmail inbox tab before the script can
navigate, try starting blank and attaching the profile after browser creation:

```bash
GMAIL_MODE=html GMAIL_ATTACH_PROFILE_AFTER_START=1 npm run gmail:headless
```

This uses the Browser API update route. If that route is unavailable in the
current environment, the script fails early with the HTTP response so the
limitation is explicit.

Artifacts are written to `artifacts/gmail-headless/` by default:

- `events.json` with page URLs, titles, challenge detection, and browser lifecycle
- `*.png` screenshot at the challenge or send-complete point
- `*.html` page HTML next to the screenshot

This is for debugging and screenshots, not the recommended production Gmail
sending path. Gmail web automation can be challenged even with a valid saved
profile. Reliable sending should use Gmail API OAuth or Workspace delegation.
