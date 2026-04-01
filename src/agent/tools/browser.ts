import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

// ── Singleton browser state ───────────────────────────────────────────────────
let browser: Browser | null = null
let context: BrowserContext | null = null
const pages = new Map<string, Page>()
let activePageId = "default"

async function ensureBrowser(): Promise<BrowserContext> {
  if (!browser || !context) {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    })
    const defaultPage = await context.newPage()
    pages.set("default", defaultPage)
    activePageId = "default"
  }
  return context
}

async function getPage(pageId?: string): Promise<Page> {
  await ensureBrowser()
  const id = pageId ?? activePageId
  const page = pages.get(id)
  if (!page) {
    throw new Error(`Page "${id}" not found. Available: ${[...pages.keys()].join(", ")}`)
  }
  return page
}

// ── Result types ──────────────────────────────────────────────────────────────
export type BrowserToolResult =
  | { kind: "text"; text: string }
  | { kind: "screenshot"; base64: string; caption: string }

// ── Main tool function ────────────────────────────────────────────────────────
export async function browserUse(input: Record<string, unknown>): Promise<BrowserToolResult> {
  const act = input.action as string

  try {
    switch (act) {
      // ── Navigation ──────────────────────────────────────────────────────────
      case "navigate": {
        const page = await getPage(input.page as string | undefined)
        const waitUntil =
          (input.wait_until as "load" | "domcontentloaded" | "networkidle") ?? "domcontentloaded"
        await page.goto(input.url as string, { waitUntil, timeout: 30_000 })
        return {
          kind: "text",
          text: `Navigated to ${input.url}. Title: "${await page.title()}"`,
        }
      }

      // ── Screenshot ──────────────────────────────────────────────────────────
      case "screenshot": {
        const page = await getPage(input.page as string | undefined)
        let buffer: Buffer
        if (input.selector) {
          buffer = await page.locator(input.selector as string).first().screenshot()
        } else {
          buffer = await page.screenshot({
            fullPage: !!(input.full_page),
            type: "jpeg",
            quality: 80,
          })
        }
        const title = await page.title()
        const url = page.url()
        return {
          kind: "screenshot",
          base64: buffer.toString("base64"),
          caption: `Screenshot of "${title}" (${url})`,
        }
      }

      // ── Click ───────────────────────────────────────────────────────────────
      case "click": {
        const page = await getPage(input.page as string | undefined)
        await page.locator(input.selector as string).first().click({
          button: (input.button as "left" | "right" | "middle") ?? "left",
          clickCount: input.double ? 2 : 1,
        })
        return { kind: "text", text: `Clicked "${input.selector}"` }
      }

      // ── Type (key-by-key, triggers input events) ────────────────────────────
      case "type": {
        const page = await getPage(input.page as string | undefined)
        await page.locator(input.selector as string).first().pressSequentially(
          input.text as string,
          { delay: (input.delay as number) ?? 0 }
        )
        return { kind: "text", text: `Typed into "${input.selector}"` }
      }

      // ── Fill (sets value directly, fast) ────────────────────────────────────
      case "fill": {
        const page = await getPage(input.page as string | undefined)
        await page.locator(input.selector as string).first().fill(input.value as string)
        return { kind: "text", text: `Filled "${input.selector}"` }
      }

      // ── Select option ────────────────────────────────────────────────────────
      case "select": {
        const page = await getPage(input.page as string | undefined)
        await page
          .locator(input.selector as string)
          .first()
          .selectOption(input.value as string)
        return { kind: "text", text: `Selected "${input.value}" in "${input.selector}"` }
      }

      // ── Hover ────────────────────────────────────────────────────────────────
      case "hover": {
        const page = await getPage(input.page as string | undefined)
        await page.locator(input.selector as string).first().hover()
        return { kind: "text", text: `Hovered over "${input.selector}"` }
      }

      // ── Scroll ───────────────────────────────────────────────────────────────
      case "scroll": {
        const page = await getPage(input.page as string | undefined)
        if (input.selector) {
          await page.locator(input.selector as string).first().scrollIntoViewIfNeeded()
          return { kind: "text", text: `Scrolled "${input.selector}" into view` }
        }
        await page.mouse.wheel((input.x as number) ?? 0, (input.y as number) ?? 500)
        return { kind: "text", text: `Scrolled page by (${input.x ?? 0}, ${input.y ?? 500})` }
      }

      // ── Key press ────────────────────────────────────────────────────────────
      case "press": {
        const page = await getPage(input.page as string | undefined)
        if (input.selector) {
          await page.locator(input.selector as string).first().press(input.key as string)
        } else {
          await page.keyboard.press(input.key as string)
        }
        return { kind: "text", text: `Pressed "${input.key}"` }
      }

      // ── Wait for ─────────────────────────────────────────────────────────────
      case "wait_for": {
        const page = await getPage(input.page as string | undefined)
        const timeout = (input.timeout as number) ?? 10_000
        if (input.selector) {
          await page
            .locator(input.selector as string)
            .first()
            .waitFor({
              state:
                (input.state as "visible" | "hidden" | "attached" | "detached") ?? "visible",
              timeout,
            })
          return {
            kind: "text",
            text: `Element "${input.selector}" is ${input.state ?? "visible"}`,
          }
        }
        if (input.text) {
          await page.waitForFunction(
            (t) => document.body.innerText.includes(t as string),
            input.text,
            { timeout }
          )
          return { kind: "text", text: `Text "${input.text}" found on page` }
        }
        await page.waitForTimeout(timeout)
        return { kind: "text", text: `Waited ${timeout}ms` }
      }

      // ── Evaluate JS ──────────────────────────────────────────────────────────
      case "evaluate": {
        const page = await getPage(input.page as string | undefined)
        const result = await page.evaluate(input.script as string)
        return { kind: "text", text: JSON.stringify(result, null, 2) }
      }

      // ── Get visible text ─────────────────────────────────────────────────────
      case "get_text": {
        const page = await getPage(input.page as string | undefined)
        const text = input.selector
          ? await page.locator(input.selector as string).first().innerText()
          : await page.evaluate(() => document.body.innerText)
        const out = text.length > 50_000 ? text.slice(0, 50_000) + "\n...[truncated]" : text
        return { kind: "text", text: out }
      }

      // ── Get HTML ─────────────────────────────────────────────────────────────
      case "get_html": {
        const page = await getPage(input.page as string | undefined)
        let html: string
        if (input.selector) {
          const loc = page.locator(input.selector as string).first()
          html = input.outer
            ? await loc.evaluate((el) => el.outerHTML)
            : await loc.innerHTML()
        } else {
          html = await page.content()
        }
        const out = html.length > 50_000 ? html.slice(0, 50_000) + "\n...[truncated]" : html
        return { kind: "text", text: out }
      }

      // ── History ──────────────────────────────────────────────────────────────
      case "go_back": {
        const page = await getPage(input.page as string | undefined)
        await page.goBack({ waitUntil: "domcontentloaded" })
        return { kind: "text", text: `Navigated back. Now at: ${page.url()}` }
      }

      case "go_forward": {
        const page = await getPage(input.page as string | undefined)
        await page.goForward({ waitUntil: "domcontentloaded" })
        return { kind: "text", text: `Navigated forward. Now at: ${page.url()}` }
      }

      // ── Tab management ───────────────────────────────────────────────────────
      case "new_page": {
        await ensureBrowser()
        const newPage = await context!.newPage()
        const id = `page_${Date.now()}`
        pages.set(id, newPage)
        activePageId = id
        if (input.url) {
          await newPage.goto(input.url as string, { waitUntil: "domcontentloaded" })
        }
        return {
          kind: "text",
          text: `Opened new page id="${id}"${input.url ? `. Navigated to ${input.url}` : ""}`,
        }
      }

      case "close_page": {
        const id = (input.page as string) ?? activePageId
        const page = pages.get(id)
        if (!page) return { kind: "text", text: `Page "${id}" not found` }
        await page.close()
        pages.delete(id)
        if (activePageId === id) {
          activePageId = [...pages.keys()][0] ?? "default"
        }
        return {
          kind: "text",
          text: `Closed page "${id}". Active page is now "${activePageId}"`,
        }
      }

      case "list_pages": {
        await ensureBrowser()
        const entries = await Promise.all(
          [...pages.entries()].map(async ([id, p]) => {
            const marker = id === activePageId ? "*" : " "
            return `${marker} [${id}] ${p.url()} — "${await p.title()}"`
          })
        )
        return { kind: "text", text: entries.length ? entries.join("\n") : "No open pages" }
      }

      case "switch_page": {
        const id = input.page as string
        if (!pages.has(id)) {
          return {
            kind: "text",
            text: `Page "${id}" not found. Available: ${[...pages.keys()].join(", ")}`,
          }
        }
        activePageId = id
        return { kind: "text", text: `Switched to page "${id}"` }
      }

      // ── Lifecycle ────────────────────────────────────────────────────────────
      case "close_browser": {
        if (browser) {
          await browser.close()
          browser = null
          context = null
          pages.clear()
          activePageId = "default"
        }
        return { kind: "text", text: "Browser closed" }
      }

      default:
        return { kind: "text", text: `Error: unknown action "${act}"` }
    }
  } catch (err: unknown) {
    return { kind: "text", text: `Error: ${(err as Error).message}` }
  }
}
