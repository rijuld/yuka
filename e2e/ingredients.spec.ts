import { expect, test } from '@playwright/test'

test('home loads', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: /Extract all text from an image upload/i })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Find ingredients' })).toBeVisible()
})
