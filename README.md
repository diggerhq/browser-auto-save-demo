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
