import { InvalidTokenError } from './token-verifier';
import { MockTokenVerifier } from './mock-token-verifier';

describe('MockTokenVerifier', () => {
  const verifier = new MockTokenVerifier();

  it('subject ayrıştırır', async () => {
    const token = await verifier.verify('mock:user-abc');

    expect(token.subject).toBe('user-abc');
    expect(token.emailVerified).toBe(false);
  });

  it('e-posta ve telefon niteliklerini okur', async () => {
    const token = await verifier.verify('mock:user-abc:email=ayse@example.com:phone=+905551112233');

    expect(token.email).toBe('ayse@example.com');
    expect(token.phoneNumber).toBe('+905551112233');
    expect(token.emailVerified).toBe(true);
  });

  it('mock biçiminde olmayan token reddedilir', async () => {
    await expect(verifier.verify('eyJhbGciOiJSUzI1NiJ9.payload.sig')).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('subject boşsa reddedilir', async () => {
    await expect(verifier.verify('mock:')).rejects.toThrow(InvalidTokenError);
  });
});
