# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ingredients.spec.ts >> Find ingredients does not throw registerBackend / undefined ORT
- Location: e2e/ingredients.spec.ts:5:1

# Error details

```
Error: Channel closed
```

```
Error: expect(locator).not.toContainText(expected) failed

Locator: locator('.error')
Expected substring: not "registerBackend"
Error: element(s) not found

Call log:
  - Expect "not toContainText" with timeout 300000ms
  - waiting for locator('.error')

```

```
Error: browserContext.close: Target page, context or browser has been closed
```