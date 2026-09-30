import { describe, expect, it } from 'vitest';
import { buildCsp, createNonce } from './csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

describe('buildCsp (R-105)', () => {
  it("script-src nonce + strict-dynamic taşır, 'unsafe-inline' taşımaz", () => {
    const script = directive(buildCsp('abc123', false), 'script-src');
    expect(script).toContain("'nonce-abc123'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("'unsafe-eval' yalnız geliştirmede", () => {
    expect(directive(buildCsp('n', true), 'script-src')).toContain("'unsafe-eval'");
  });

  it('çerçeveleme ve eklenti kapalı', () => {
    const csp = buildCsp('n', false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('nonce her çağrıda farklı ve en az 128 bit', () => {
    const a = createNonce();
    expect(a).not.toBe(createNonce());
    expect(atob(a)).toHaveLength(16);
  });
});
