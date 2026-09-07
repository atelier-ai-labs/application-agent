import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PlaywrightLeverBrowserSession } from '../playwrightLeverBrowserSession';
const browser = await chromium.launch({ headless: true });
try {
 const context = await browser.newContext();
 await context.route('**/*', route => route.abort());
 const page = await context.newPage();
 const session = new PlaywrightLeverBrowserSession(page, context, browser, 3000, {});
 const cases = [
  ['script and passive badge', '<script src="https://www.recaptcha.net/api.js"></script><div class="grecaptcha-badge"><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible" title="reCAPTCHA"></iframe></div>', 'infrastructure_present'],
  ['hidden token', '<textarea name="g-recaptcha-response" style="display:none"></textarea>', 'infrastructure_present'],
  ['static provider text', '<p>This site is protected by reCAPTCHA</p>', 'infrastructure_present'],
  ['dormant frame', '<div style="display:none"><iframe src="https://www.recaptcha.net/recaptcha/api2/bframe" title="challenge"></iframe></div>', 'infrastructure_present'],
  ['visible challenge', '<iframe src="https://www.recaptcha.net/recaptcha/api2/bframe" title="challenge"></iframe>', 'active_challenge'],
  ['interactive checkbox', '<div class="captcha"><input type="checkbox" aria-label="I am not a robot">I\'m not a robot</div>', 'active_challenge'],
  ['ambiguous frame', '<iframe src="https://captcha.example.invalid/widget"></iframe>', 'uncertain'],
  ['unknown badge control', '<div class="grecaptcha-badge"><iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?size=invisible"></iframe><button class="captcha-action" type="button">Continue</button></div>', 'uncertain'],
  ['no markers', '<p>Application form</p>', 'none'],
 ] as const;
 for (const [label, html, expected] of cases) {
  await page.setContent(`<form>${html}<label>Email<input type="email"></label><button type="submit">Submit</button></form>`);
  const boundary = await session.detectHumanBoundary();
  assert.equal(session.diagnostics().captcha?.state, expected, label);
  assert.equal(Boolean(boundary), expected === 'active_challenge' || expected === 'uncertain', label);
  if (!boundary) await page.locator('input[type=email]').fill('synthetic@example.invalid');
  console.log(`PASS ${label}: ${expected}`);
 }
} finally { await browser.close(); }
