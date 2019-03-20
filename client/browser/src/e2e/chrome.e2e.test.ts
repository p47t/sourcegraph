import * as path from 'path'
import puppeteer from 'puppeteer'
import { readEnvString } from '../../../../shared/src/util/e2e-test-utils'
import { saveScreenshotsUponFailuresAndClosePage } from '../../../../shared/src/util/screenshotReporter'

const chromeExtensionPath = path.resolve(__dirname, '..', '..', 'build/chrome')

const SOURCEGRAPH_BASE_URL = readEnvString({
    variable: 'SOURCEGRAPH_BASE_URL',
    defaultValue: 'https://sourcegraph.com',
})

// The default value here is the dev extension ID.
// In CI, tests are be run against the prod extension ID.
const EXTENSION_ID = readEnvString({
    variable: 'SOURCEGRAPH_EXTENSION_ID',
    defaultValue: 'bmfbcejdknlknpncfpeloejonjoledha',
})

const OPTIONS_PAGE_URL = `chrome-extension://${EXTENSION_ID}/options.html`

async function getTokenWithSelector(
    page: puppeteer.Page,
    token: string,
    selector: string
): Promise<puppeteer.ElementHandle> {
    const elements = await page.$$(selector)

    let element: puppeteer.ElementHandle<HTMLElement> | undefined
    for (const elem of elements) {
        const text = await page.evaluate(element => element.textContent, elem)
        if (text === token) {
            element = elem
            break
        }
    }

    if (!element) {
        throw new Error(`Unable to find token '${token}' with selector ${selector}`)
    }

    return element
}

async function clickElement(page: puppeteer.Page, element: puppeteer.ElementHandle): Promise<void> {
    // Wait for JS to be evaluated (https://github.com/GoogleChrome/puppeteer/issues/1805#issuecomment-357999249).
    await page.waitFor(500)
    await element.click()
}

describe('Sourcegraph Chrome extension', () => {
    let browser: puppeteer.Browser
    let page: puppeteer.Page

    async function ensureLoggedIn({
        page,
        baseURL,
        email = 'test@test.com',
        username = 'test',
        password = 'test',
    }: {
        page: puppeteer.Page
        baseURL: string
        email?: string
        username?: string
        password?: string
    }): Promise<void> {
        await page.goto(baseURL)
        const url = new URL(await page.url())
        if (url.pathname === '/site-admin/init') {
            await page.type('input[name=email]', email)
            await page.type('input[name=username]', username)
            await page.type('input[name=password]', password)
            await page.click('button[type=submit]')
            await page.waitForNavigation()
        } else if (url.pathname === '/sign-in') {
            await page.type('input', username)
            await page.type('input[name=password]', password)
            await page.click('button[type=submit]')
            await page.waitForNavigation()
        }
    }

    // Open browser.
    beforeAll(
        async (): Promise<void> => {
            jest.setTimeout(90 * 1000)

            let args: string[] = [
                `--disable-extensions-except=${chromeExtensionPath}`,
                `--load-extension=${chromeExtensionPath}`,
            ]

            if (process.getuid() === 0) {
                // TODO don't run as root in CI
                console.warn('Running as root, disabling sandbox')
                args = [...args, '--no-sandbox', '--disable-setuid-sandbox']
            }

            browser = await puppeteer.launch({
                headless: false,
                args,
            })
        }
    )

    // Open page.
    beforeEach(async () => {
        page = await browser.newPage()
    })

    // Take a screenshot when a test fails.
    saveScreenshotsUponFailuresAndClosePage(
        path.resolve(__dirname, '..', '..', '..', '..'),
        path.resolve(__dirname, '..', '..', '..', '..', 'puppeteer'),
        () => page
    )

    // Close browser.
    afterAll(async () => {
        if (browser) {
            if (page && !page.isClosed()) {
                await page.close()
            }
            await browser.close()
        }
    })

    const repoBaseURL = 'https://github.com/gorilla/mux'

    test('connects to sourcegraph.com by default', async () => {
        await page.goto(OPTIONS_PAGE_URL)
        await page.waitForSelector('.e2e-server-url-status-success')
    })

    if (SOURCEGRAPH_BASE_URL !== 'https://sourcegraph.com') {
        test("sets the Sourcegraph URL and warns the user he's not logged in", async () => {
            await ensureLoggedIn({ page, baseURL: SOURCEGRAPH_BASE_URL })
            // Make sure we're actually logged out of the instance
            await page.goto(SOURCEGRAPH_BASE_URL + '/-/sign-out')
            await page.waitForSelector('.signin-form')
            await page.goto(OPTIONS_PAGE_URL)
            await page.waitForSelector('.e2e-server-url-input')
            await page.focus('.e2e-server-url-input')
            // Erase input value
            await page.evaluate(
                () => ((document.querySelector('.e2e-server-url-input')! as HTMLInputElement).value = '')
            )
            await page.keyboard.type(SOURCEGRAPH_BASE_URL)
            // Clear the focus on the input field.
            await page.evaluate(() => (document.activeElement! as HTMLElement).blur())
            await page.waitForSelector('.e2e-server-url-status-error')
        })

        test('connects to the instance once the user is logged in', async () => {
            await ensureLoggedIn({ page, baseURL: SOURCEGRAPH_BASE_URL })
            await page.goto(OPTIONS_PAGE_URL)
            await page.waitForSelector('.e2e-server-url-status-success')
        })
    }

    test('injects View on Sourcegraph', async () => {
        await page.goto(repoBaseURL)
        await page.waitForSelector('li#open-on-sourcegraph')
    })

    test('injects toolbar for code views', async () => {
        await page.goto('https://github.com/gorilla/mux/blob/master/mux.go')
        await page.waitForSelector('.code-view-toolbar')
    })

    test('provides tooltips for single file', async () => {
        await page.goto('https://github.com/gorilla/mux/blob/master/mux.go')

        const element = await getTokenWithSelector(page, 'NewRouter', 'span.pl-en')

        await clickElement(page, element)

        await page.waitForSelector('.e2e-tooltip-go-to-definition')
    })

    const tokens = {
        base: { text: 'matchHost', selector: 'span.pl-v' },
        head: { text: 'regexpType', selector: 'span.pl-v' },
    }

    for (const diffType of ['unified', 'split']) {
        for (const side of ['base', 'head']) {
            test(`provides tooltips for diff files (${diffType}, ${side})`, async () => {
                await page.goto(`https://github.com/gorilla/mux/pull/328/files?diff=${diffType}`)

                const token = tokens[side as 'base' | 'head']
                const element = await getTokenWithSelector(page, token.text, token.selector)

                // Scrolls the element into view so that code view is in view.
                await element.hover()
                await page.waitForSelector('[data-path="regexp.go"] .code-view-toolbar .open-on-sourcegraph')
                await clickElement(page, element)
                await page.waitForSelector('.e2e-tooltip-go-to-definition')
            })
        }
    }
})
