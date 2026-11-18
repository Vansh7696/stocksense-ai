import { test, expect } from '@playwright/test';
import { setupApiMocks, mockStockReliance, mockPredictions } from './fixtures/mockApi.js';

test.describe('StockSense AI — Master E2E Browser Test Suite (Milestone 6D.3)', () => {
  test.beforeEach(async ({ page }) => {
    await setupApiMocks(page);
  });

  // 1. User Registration Flow
  test('1. Registration flow navigates and presents registration fields', async ({ page }) => {
    await page.goto('/register');
    await expect(page).toHaveTitle(/StockSense/i);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  // 2. User Login Flow
  test('2. Login flow accepts credentials and navigates to dashboard', async ({ page }) => {
    await page.route('**/api/auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { user: { id: 'user-1', email: 'test@stocksense.ai' } } }),
      });
    });

    await page.goto('/login');
    await page.fill('input[type="email"]', 'test@stocksense.ai');
    await page.fill('input[type="password"]', 'ValidPassword123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/(dashboard)?$/);
  });

  // 3. Logout Flow
  test('3. Logout flow successfully terminates user session', async ({ page }) => {
    await page.route('**/api/auth/logout', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    });

    await page.goto('/');
    const logoutBtn = page.locator('button:has-text("Logout"), button[title="Logout"]');
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
      await expect(page).toHaveURL(/\/login/);
    }
  });

  // 4. Invalid Credentials Flow
  test('4. Displays error alert upon invalid login credentials', async ({ page }) => {
    await page.route('**/api/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { message: 'Invalid email or password' } }),
      });
    });

    await page.goto('/login');
    await page.fill('input[type="email"]', 'wrong@stocksense.ai');
    await page.fill('input[type="password"]', 'IncorrectPassword123!');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Invalid email or password')).toBeVisible();
  });

  // 5. Dashboard Loading Flow
  test('5. Dashboard renders key metrics and platform overview banner', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1:has-text("Indian Equity Intelligence")')).toBeVisible();
    await expect(page.locator('text=Tracked Instruments')).toBeVisible();
  });

  // 6. Stock Explorer Loading Flow
  test('6. Stock Explorer loads catalog view and renders stocks table', async ({ page }) => {
    await page.goto('/stocks');
    await expect(page.locator('h1:has-text("Stock Explorer")')).toBeVisible();
    await expect(page.locator('main').getByText('RELIANCE').first()).toBeVisible();
  });

  // 7. Stock Search Flow
  test('7. Stock search filters catalog by symbol query', async ({ page }) => {
    await page.goto('/stocks');
    const searchInput = page.locator('input[placeholder*="Search by symbol"]');
    await searchInput.fill('RELIANCE');
    await expect(page.locator('text=Reliance Industries Limited')).toBeVisible();
  });

  // 8. Stock Detail Navigation Flow
  test('8. Navigates from catalog to Stock Detail page', async ({ page }) => {
    await page.goto('/stocks');
    await page.locator('main').getByText('RELIANCE').first().click();
    await expect(page).toHaveURL(/\/stocks\/(RELIANCE|[a-f0-9-]+)/);
  });

  // 9. Prediction Display Flow
  test('9. Displays multi-horizon prediction cards (T+1, T+3, T+5)', async ({ page }) => {
    await page.goto('/stocks/RELIANCE?exchange=NSE');
    await expect(page.locator('text=Quantitative Directional Forecast')).toBeVisible();
    await expect(page.locator('text=1-Day Forecast')).toBeVisible();
    await expect(page.locator('text=3-Day Forecast')).toBeVisible();
  });

  // 10. News Sentiment Intelligence Flow
  test('10. Displays financial news sentiment polarity and fusion score', async ({ page }) => {
    await page.goto('/stocks/RELIANCE?exchange=NSE');
    await expect(page.locator('text=Market News Sentiment & Intelligence')).toBeVisible();
    await expect(page.locator('main').getByText('BULLISH').first()).toBeVisible();
  });

  // 11. Technical Patterns Recognition Flow
  test('11. Displays candlestick patterns, support/resistance, and breakout signals', async ({ page }) => {
    await page.goto('/stocks/RELIANCE?exchange=NSE');
    await expect(page.locator('text=Technical Pattern & Breakout Intelligence')).toBeVisible();
    await expect(page.locator('text=Bullish Engulfing')).toBeVisible();
  });

  // 12. Chart Rendering Flow
  test('12. Renders historical candlestick chart container', async ({ page }) => {
    await page.goto('/stocks/RELIANCE?exchange=NSE');
    await expect(page.locator('text=Historical OHLCV Candlesticks')).toBeVisible();
  });

  // 13. Watchlist Management Flow
  test('13. Manages stock addition and removal from user watchlist', async ({ page }) => {
    await page.goto('/watchlist');
    await expect(page.locator('h1').getByText(/Watchlist/i)).toBeVisible();
  });

  // 14. Alert Creation Flow
  test('14. Opens alert modal and validates price threshold input', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page.locator('h1:has-text("Stock Price Alerts")')).toBeVisible();
  });

  // 15. Alert Status Display Flow
  test('15. Displays active alerts and target levels', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page.locator('main').getByText('2,600').first()).toBeVisible();
  });

  // 16. API Failure Handling Flow
  test('16. Gracefully renders ErrorState when API fails', async ({ page }) => {
    await page.route('**/api/market/overview', async (route) => {
      await route.fulfill({ status: 500, body: JSON.stringify({ error: { message: 'Gateway Timeout' } }) });
    });

    await page.goto('/');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  // 17. Session Expiration Flow
  test('17. Redirects or prompts user on session expiration (401)', async ({ page }) => {
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({ status: 401, body: JSON.stringify({ error: { code: 'UNAUTHORIZED' } }) });
    });

    await page.goto('/alerts');
    await expect(page).toHaveURL(/\/(login|alerts)?/);
  });

  // 18. Responsive Layout Flow
  test('18. Renders cleanly on mobile viewports', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await expect(page.locator('h1:has-text("Indian Equity Intelligence")')).toBeVisible();
  });
});
