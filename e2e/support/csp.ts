import { expect, type Page } from '@playwright/test';

/**
 * Nonce'lu CSP (R-105): başlık istek başına nonce taşır, `script-src` `'unsafe-inline'` taşımaz,
 * sayfadaki her script aynı nonce'la işaretlidir ve yükleme boyunca CSP ihlali olmaz.
 */
export async function expectNonceCsp(page: Page, path: string): Promise<string> {
  const violations: string[] = [];
  await page.exposeFunction('__reportCspViolation', (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __reportCspViolation: (d: string) => void })
        .__reportCspViolation;
      report(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  const response = await page.goto(path);
  const csp = (await response?.headerValue('content-security-policy')) ?? '';
  const script = csp.split('; ').find((part) => part.startsWith('script-src ')) ?? '';
  const nonce = /'nonce-([^']+)'/.exec(script)?.[1];
  expect(nonce, 'script-src nonce taşımalı').toBeTruthy();
  expect(script).not.toContain("'unsafe-inline'");

  // Sunucunun ürettiği HTML'deki her script aynı nonce'u taşır. (Çalışma anında nonce'lu bir
  // script'in eklediği script'ler — ör. geliştirmede HMR istemcisi — `'strict-dynamic'` ile
  // meşrudur ve nonce taşımaz; onlar aşağıdaki ihlal dinleyicisiyle kapsanır.)
  const html = (await response?.text()) ?? '';
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  expect(tags.length).toBeGreaterThan(0);
  for (const tag of tags) {
    expect(tag, 'her SSR script nonce taşımalı').toContain(`nonce="${nonce}"`);
  }

  await page.waitForLoadState('networkidle');
  expect(violations).toEqual([]);
  return nonce!;
}
