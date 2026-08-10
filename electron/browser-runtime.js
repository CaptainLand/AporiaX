import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const MAX_SNAPSHOT_CHARS = 48_000;
const MAX_BODY_TEXT_CHARS = 24_000;
const MAX_EVENT_ENTRIES = 80;
const DEFAULT_TIMEOUT_MS = 12_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

export const BROWSER_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description:
        "Open an http/https page in AporiaX's isolated browser session and return a compact DOM/accessibility snapshot. Use this for local dev servers and web research that requires interaction.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http or https URL." },
          wait_until: {
            type: "string",
            enum: ["commit", "domcontentloaded", "load", "networkidle"],
            description: "Navigation wait condition. Defaults to domcontentloaded.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_snapshot",
      description:
        "Read the current browser page as an AI-oriented accessibility snapshot plus visible text, console errors, and failed/error network requests.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click one element in the current page. Prefer semantic role/name, label, text, or placeholder locators over raw selectors.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "ARIA role, for example button or link." },
          name: { type: "string", description: "Accessible name used with role." },
          label: { type: "string", description: "Associated form-control label." },
          text: { type: "string", description: "Visible text to locate." },
          placeholder: { type: "string", description: "Input placeholder to locate." },
          selector: { type: "string", description: "Fallback CSS/Playwright selector." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description:
        "Fill a text field in the current page. This changes page state and may require approval depending on the task permission mode.",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: "Text to enter." },
          role: { type: "string" },
          name: { type: "string" },
          label: { type: "string" },
          placeholder: { type: "string" },
          selector: { type: "string" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_press",
      description:
        "Press a keyboard key on a located element or on the page, for example Enter, Escape, ArrowDown, or Control+L.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Playwright keyboard key/chord." },
          role: { type: "string" },
          name: { type: "string" },
          label: { type: "string" },
          text: { type: "string" },
          placeholder: { type: "string" },
          selector: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Capture the current page to a temporary PNG evidence file and return the path. This does not modify the authorized workspace.",
      parameters: {
        type: "object",
        properties: {
          full_page: { type: "boolean", description: "Capture the full scrollable page. Defaults to false." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_console",
      description:
        "Read recent browser console messages and uncaught page errors from the isolated browser session.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_network",
      description:
        "Read recent HTTP error responses and failed network requests from the current page.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the isolated browser session and release its resources.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

export const BROWSER_TOOL_RISKS = Object.freeze({
  browser_open: "read",
  browser_snapshot: "read",
  browser_screenshot: "read",
  browser_console: "read",
  browser_network: "read",
  browser_close: "control",
  browser_click: "control",
  browser_fill: "control",
  browser_press: "control",
});

const BROWSER_TOOL_NAMES = new Set(Object.keys(BROWSER_TOOL_RISKS));

export function isBrowserToolName(name) {
  return BROWSER_TOOL_NAMES.has(String(name || ""));
}

export function normalizeBrowserUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Browser URL must be an absolute http/https URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("AporiaX Browser only allows http and https URLs.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials embedded in browser URLs are not allowed.");
  }
  return url.toString();
}

export function hasBrowserLocator(input = {}) {
  return Boolean(
    String(input.selector || "").trim() ||
      String(input.label || "").trim() ||
      String(input.placeholder || "").trim() ||
      String(input.text || "").trim() ||
      String(input.role || "").trim(),
  );
}

function compact(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function pushRing(list, value, limit = MAX_EVENT_ENTRIES) {
  list.push(value);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function locatorFor(page, input = {}) {
  const selector = String(input.selector || "").trim();
  if (selector) return page.locator(selector);
  const label = String(input.label || "").trim();
  if (label) return page.getByLabel(label, { exact: false });
  const placeholder = String(input.placeholder || "").trim();
  if (placeholder) return page.getByPlaceholder(placeholder, { exact: false });
  const role = String(input.role || "").trim();
  const name = String(input.name || "").trim();
  if (role) return page.getByRole(role, name ? { name, exact: false } : undefined);
  const text = String(input.text || "").trim();
  if (text) return page.getByText(text, { exact: false });
  throw new Error(
    "Browser interaction needs one locator: role/name, label, text, placeholder, or selector.",
  );
}

export class AporiaXBrowserRuntime {
  #browser = null;
  #context = null;
  #page = null;
  #console = [];
  #network = [];
  #launch = null;
  #artifactDirectory;
  #headless;

  constructor({ artifactDirectory = "", headless = true } = {}) {
    this.#artifactDirectory = artifactDirectory || join(tmpdir(), "aporiax-browser");
    this.#headless = headless !== false;
  }

  get active() {
    return Boolean(this.#page && !this.#page.isClosed());
  }

  async #launchBrowser() {
    if (this.#browser?.isConnected()) return;
    const attempts = [
      { channel: "msedge", label: "Microsoft Edge" },
      { channel: "chrome", label: "Google Chrome" },
      { channel: null, label: "Playwright Chromium" },
    ];
    const errors = [];
    for (const attempt of attempts) {
      try {
        this.#browser = await chromium.launch({
          headless: this.#headless,
          ...(attempt.channel ? { channel: attempt.channel } : {}),
        });
        this.#launch = attempt.label;
        return;
      } catch (error) {
        errors.push(`${attempt.label}: ${error?.message || error}`);
      }
    }
    throw new Error(
      [
        "Unable to start an AporiaX browser. Install Microsoft Edge/Google Chrome or install Playwright Chromium.",
        "For development you can run: npx playwright install chromium",
        ...errors.slice(0, 3),
      ].join("\n"),
    );
  }

  async #ensurePage() {
    if (this.active) return this.#page;
    await this.#launchBrowser();
    this.#context = await this.#browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
    });
    this.#context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    this.#context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    this.#page = await this.#context.newPage();
    this.#page.on("console", (message) => {
      pushRing(this.#console, {
        type: message.type(),
        text: compact(message.text(), 2_000),
      });
    });
    this.#page.on("pageerror", (error) => {
      pushRing(this.#console, {
        type: "pageerror",
        text: compact(error?.message || error, 2_000),
      });
    });
    this.#page.on("response", (response) => {
      if (response.status() < 400) return;
      pushRing(this.#network, {
        type: "http-error",
        status: response.status(),
        method: response.request().method(),
        url: compact(response.url(), 2_000),
      });
    });
    this.#page.on("requestfailed", (request) => {
      pushRing(this.#network, {
        type: "request-failed",
        method: request.method(),
        url: compact(request.url(), 2_000),
        error: compact(request.failure()?.errorText || "request failed", 1_000),
      });
    });
    return this.#page;
  }

  async snapshot() {
    const page = await this.#ensurePage();
    const [title, aria, text] = await Promise.all([
      page.title().catch(() => ""),
      page
        .ariaSnapshot({ mode: "ai", depth: 10, timeout: 5_000 })
        .catch(async () =>
          page.locator("body").ariaSnapshot({ timeout: 5_000 }).catch(() => ""),
        ),
      page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
    ]);
    return {
      active: true,
      browser: this.#launch,
      url: page.url(),
      title,
      ariaSnapshot: compact(aria, MAX_SNAPSHOT_CHARS),
      visibleText: compact(text, MAX_BODY_TEXT_CHARS),
      consoleErrors: this.#console
        .filter((entry) => ["error", "warning", "pageerror"].includes(entry.type))
        .slice(-20),
      networkProblems: this.#network.slice(-20),
    };
  }

  async open(input = {}) {
    const page = await this.#ensurePage();
    const url = normalizeBrowserUrl(input.url);
    const waitUntil = new Set(["commit", "domcontentloaded", "load", "networkidle"]).has(
      input.wait_until,
    )
      ? input.wait_until
      : "domcontentloaded";
    const response = await page.goto(url, { waitUntil });
    return {
      navigation: {
        requestedUrl: url,
        url: page.url(),
        status: response?.status() ?? null,
        ok: response ? response.ok() : null,
      },
      ...(await this.snapshot()),
    };
  }

  async click(input = {}) {
    const page = await this.#ensurePage();
    const locator = locatorFor(page, input).first();
    await locator.click();
    return { action: "click", ...(await this.snapshot()) };
  }

  async fill(input = {}) {
    const page = await this.#ensurePage();
    if (typeof input.value !== "string" || input.value.length > 20_000) {
      throw new Error("Browser fill value must be a string up to 20,000 characters.");
    }
    const locator = locatorFor(page, input).first();
    await locator.fill(input.value);
    return { action: "fill", valueLength: input.value.length, ...(await this.snapshot()) };
  }

  async press(input = {}) {
    const page = await this.#ensurePage();
    const key = String(input.key || "").trim();
    if (!key || key.length > 80) throw new Error("A browser key/chord is required.");
    if (hasBrowserLocator(input)) {
      await locatorFor(page, input).first().press(key);
    } else {
      await page.keyboard.press(key);
    }
    return { action: "press", key, ...(await this.snapshot()) };
  }

  async screenshot(input = {}) {
    const page = await this.#ensurePage();
    await mkdir(this.#artifactDirectory, { recursive: true });
    const path = join(
      this.#artifactDirectory,
      `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );
    await page.screenshot({
      path,
      type: "png",
      fullPage: Boolean(input.full_page),
    });
    return {
      path,
      url: page.url(),
      title: await page.title().catch(() => ""),
      fullPage: Boolean(input.full_page),
      temporary: true,
    };
  }

  console() {
    return { entries: this.#console.slice(-MAX_EVENT_ENTRIES) };
  }

  network() {
    return { entries: this.#network.slice(-MAX_EVENT_ENTRIES) };
  }

  async close() {
    try {
      await this.#context?.close();
    } catch {
      // Best-effort teardown.
    }
    try {
      await this.#browser?.close();
    } catch {
      // Best-effort teardown.
    }
    this.#page = null;
    this.#context = null;
    this.#browser = null;
    return { closed: true };
  }
}

export function createBrowserRuntime(options) {
  return new AporiaXBrowserRuntime(options);
}

export async function executeBrowserTool(runtime, toolName, input = {}) {
  if (!runtime) throw new Error("AporiaX Browser runtime is unavailable.");
  switch (toolName) {
    case "browser_open":
      return runtime.open(input);
    case "browser_snapshot":
      return runtime.snapshot();
    case "browser_click":
      return runtime.click(input);
    case "browser_fill":
      return runtime.fill(input);
    case "browser_press":
      return runtime.press(input);
    case "browser_screenshot":
      return runtime.screenshot(input);
    case "browser_console":
      return runtime.console();
    case "browser_network":
      return runtime.network();
    case "browser_close":
      return runtime.close();
    default:
      throw new Error(`Unsupported browser tool: ${toolName}`);
  }
}
