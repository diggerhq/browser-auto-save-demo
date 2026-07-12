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

## Gmail Send And Debug Test

This repo also includes a deliberately best-effort Gmail web-UI send test. It
uses a saved profile, opens a headful browser by default, attempts to compose
and send one email, and writes screenshots/HTML/logs when Google shows sign-in,
captcha, account security friction, or a page crash.

Configure `.env`:

```bash
OPENCOMPUTER_API_KEY=osb_...
GMAIL_PROFILE_NAME=scout-digger:sgp_test:684a2b2ca18a1424:google
GMAIL_TO=mo@digger.dev
GMAIL_SUBJECT=Hi Mo!
GMAIL_BODY=Who are you rooting for in the World Cup?
# Recommended: request Gmail's basic HTML URL; Gmail may redirect to modern Gmail.
GMAIL_MODE=html
# Recommended: load the saved profile on a blank page before navigating to Gmail.
GMAIL_START_URL=about:blank
# Defaults: headful browser, stealth enabled, Kernel telemetry requested.
GMAIL_HEADLESS=0
GMAIL_STEALTH=1
GMAIL_TELEMETRY=1
# Optional: send experimental raw create fields to ask the provider not to restore saved tabs.
GMAIL_DISABLE_RESTORE_TABS=1
# Optional: start a blank browser first, then attach the profile to avoid restored Gmail tabs.
GMAIL_ATTACH_PROFILE_AFTER_START=1
```

Run:

```bash
npm run gmail:headless
```

Despite the script name, this runs headful by default. To force headless for an
A/B test, set:

```bash
GMAIL_HEADLESS=1 npm run gmail:headless
```

If the saved profile restores a heavy Gmail inbox tab before the script can
navigate, try starting blank and attaching the profile after browser creation:

```bash
GMAIL_MODE=html GMAIL_START_URL=about:blank GMAIL_ATTACH_PROFILE_AFTER_START=1 npm run gmail:headless
```

This uses the Browser API update route. If that route is unavailable in the
current environment, the script fails early with the HTTP response so the
limitation is explicit.

To test whether the Browser API accepts an explicit no-restore-tabs create
option, run:

```bash
GMAIL_MODE=html GMAIL_START_URL=about:blank GMAIL_DISABLE_RESTORE_TABS=1 GMAIL_PROFILE_NAME=gmail-demo GMAIL_TO=mo@digger.dev npm run gmail:headless
```

This intentionally bypasses the SDK body mapper and sends experimental raw
fields: `restore_tabs: false`, `clear_restored_tabs: true`, and
`restore_session: false`. If the API rejects unknown fields, the script prints
the exact HTTP response.

To distinguish profile startup crashes from Gmail navigation crashes, start the
profile on a blank page first:

```bash
GMAIL_START_URL=about:blank GMAIL_MODE=html GMAIL_HEADLESS=0 GMAIL_STEALTH=1 GMAIL_PROFILE_NAME=gmail-demo GMAIL_TO=mo@digger.dev npm run gmail:headless
```

You can also try repairing the profile's restored tabs by loading the profile,
opening a lightweight Gmail URL, closing any restored tabs, and deleting the
browser to save the new tab state:

```bash
GMAIL_PROFILE_NAME=gmail-demo GMAIL_PATCH_URL=https://mail.google.com/mail/u/0/h/ npm run gmail:patch-profile
```

Then retry:

```bash
GMAIL_MODE=html GMAIL_PROFILE_NAME=gmail-demo GMAIL_TO=mo@digger.dev npm run gmail:headless
```

This is best-effort. If the restored Gmail tab crashes the renderer before the
patch page can be opened, profile repair needs server/provider support to clear
saved tabs without first launching them.

Artifacts are written to `artifacts/gmail-headless/` by default:

- `events.json` with page URLs, titles, challenge detection, and browser lifecycle
- `*.png` screenshot at the challenge or send-complete point
- `*.html` page HTML next to the screenshot

This is for debugging and screenshots, not the recommended production Gmail
sending path. Gmail web automation can be challenged even with a valid saved
profile. Reliable sending should use Gmail API OAuth or Workspace delegation.
