# AporiaX Browser v1

AporiaX Browser gives the main Harness a disposable Playwright browser session for inspecting and interacting with web pages.

## Design

```text
Main Agent
   ↓
Browser tools
   ↓
AporiaXBrowserRuntime
   ↓
Playwright
   ↓
Edge / Chrome / Playwright Chromium
```

The browser session is isolated from the user's normal browser profile. It does not reuse cookies, saved passwords, or login state.

## Browser selection

AporiaX tries, in order:

1. Microsoft Edge
2. Google Chrome
3. Playwright Chromium

Windows normally has Edge available. For development, a Playwright Chromium binary can be installed with:

```bash
npm run browser:install
```

Playwright browser binaries are version-coupled to Playwright. Re-run the install command after changing the Playwright version.

## Tools

| Tool | Purpose | Default risk |
| --- | --- | --- |
| `browser_open` | Navigate to an http/https page and observe it | read |
| `browser_snapshot` | Read AI-oriented ARIA snapshot, visible text, console/network problems | read |
| `browser_screenshot` | Save a temporary PNG evidence file | read |
| `browser_console` | Read recent console/page errors | read |
| `browser_network` | Read HTTP errors and failed requests | read |
| `browser_click` | Click an element | control |
| `browser_fill` | Fill a field | control |
| `browser_press` | Send a key/chord | control |
| `browser_close` | Close the disposable session | control |

`browser_click`, `browser_fill`, and `browser_press` require approval in normal workspace-write mode. Builder workers do not receive browser tools.

## Observation model

AporiaX prefers Playwright's accessibility/ARIA representation over screenshot-only reasoning. `browser_snapshot` returns:

- current URL and title
- AI-oriented ARIA snapshot
- visible body text
- recent console warnings/errors
- recent HTTP >=400 responses
- failed network requests

This makes browser evidence usable by text-only main models such as DeepSeek V4. Screenshots are still available as evidence and can later be routed into AporiaX Vision for visual QA.

## Locator policy

For interactions, prefer semantic locators:

- role + accessible name
- label
- placeholder
- visible text

Raw selectors are a fallback.

## Safety boundaries

- only `http:` and `https:` navigation is allowed
- credentials embedded in URLs are rejected
- `file:`, `javascript:`, and other schemes are rejected
- downloads are disabled
- service workers are blocked in the disposable context
- no persistent browser profile is used
- browser control actions remain subject to Harness approval
- the browser is closed automatically when the run ends, fails, or is interrupted
- screenshots are written to a temporary directory, not to the authorized workspace

## Suggested validation

```bash
npm install
npm run test:browser
npm run build
npm start
```

Then start a local web app and ask AporiaX to inspect it, for example:

```text
打开 http://127.0.0.1:5173，检查页面布局、控制台和失败的网络请求。
```

AporiaX should call `browser_open`, inspect the returned snapshot, and use `browser_console` / `browser_network` when deeper evidence is needed.
