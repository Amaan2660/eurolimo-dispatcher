const { chromium } = require('playwright');

const LC_URL   = 'https://eurolimo.limoconnect247.net';
const LC_EMAIL = process.env.LC_EMAIL || 'Bot@test.dk';
const LC_PASS  = process.env.LC_PASS  || 'Test123!';

let _browser  = null;
let _page     = null;
let _loggedIn = false;

async function getPage() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
  }
  if (!_page || _page.isClosed()) {
    _page     = await _browser.newPage();
    _loggedIn = false;
  }
  return _page;
}

async function login(page) {
  if (_loggedIn) return;
  console.log('[LC] Logging in...');

  await page.goto(LC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Try every possible selector for the email field
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id="email"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="Email" i]',
    'input[placeholder*="user" i]',
    'input[placeholder*="User" i]',
    'input[type="text"]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.fill(LC_EMAIL);
        console.log('[LC] Email filled via:', sel);
        emailFilled = true;
        break;
      }
    } catch(_) {}
  }

  if (!emailFilled) {
    // Last resort: fill the first visible input
    const inputs = await page.$$('input');
    for (const inp of inputs) {
      if (await inp.isVisible()) {
        await inp.fill(LC_EMAIL);
        console.log('[LC] Email filled via first visible input');
        emailFilled = true;
        break;
      }
    }
  }

  // Password
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
    'input[placeholder*="pass" i]',
    'input[placeholder*="Pass" i]',
  ];

  for (const sel of passSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.fill(LC_PASS);
        console.log('[LC] Password filled via:', sel);
        break;
      }
    } catch(_) {}
  }

  // Submit
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("LOGIN")',
    'button:has-text("SIGN IN")',
  ];

  for (const sel of submitSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click();
        console.log('[LC] Submitted via:', sel);
        break;
      }
    } catch(_) {}
  }

  await page.waitForTimeout(4000);
  console.log('[LC] After login URL:', page.url());
  _loggedIn = true;
}

async function fetchTripsByDateRange(startDate, endDate) {
  const page = await getPage();
  await login(page);

  console.log('[LC] Fetching trips', startDate, '->', endDate);
  await page.goto(LC_URL + '/#trips', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  // Try date inputs
  const dateInputs = await page.$$('input[type="date"]');
  if (
