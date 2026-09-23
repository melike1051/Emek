import {
  classifyFailure,
  MalformedEventError,
  UnsupportedEventVersionError,
} from './failure-classifier';
import { FailureClassification } from './event-consumer';

function withCode(error: Error, code: string): Error {
  return Object.assign(error, { code });
}

describe('FailureClassifier', () => {
  it('SyntaxError kalıcı (PERMANENT) olarak sınıflandırılır', () => {
    const error = new SyntaxError('Unexpected token');
    expect(classifyFailure(error)).toBe(FailureClassification.PERMANENT);
  });

  it('ZodError ismini içeren hata kalıcı olarak sınıflandırılır', () => {
    const error = new Error('Invalid input');
    error.name = 'ZodError';
    expect(classifyFailure(error)).toBe(FailureClassification.PERMANENT);
  });

  it('TypeError kalıcı olarak sınıflandırılır', () => {
    const error = new TypeError('Cannot read properties of undefined');
    expect(classifyFailure(error)).toBe(FailureClassification.PERMANENT);
  });

  it('UnsupportedEventVersionError kalıcı olarak sınıflandırılır', () => {
    const error = new UnsupportedEventVersionError('TestEvent', 2);
    expect(classifyFailure(error)).toBe(FailureClassification.PERMANENT);
  });

  it('MalformedEventError kalıcı olarak sınıflandırılır', () => {
    const error = new MalformedEventError('Eksik alan');
    expect(classifyFailure(error)).toBe(FailureClassification.PERMANENT);
  });

  it('ECONNREFUSED kodlu hata geçici (TRANSIENT) olarak sınıflandırılır', () => {
    const error = withCode(new Error('Connection refused'), 'ECONNREFUSED');
    expect(classifyFailure(error)).toBe(FailureClassification.TRANSIENT);
  });

  it('ETIMEDOUT kodlu hata geçici olarak sınıflandırılır', () => {
    const error = withCode(new Error('Connection timed out'), 'ETIMEDOUT');
    expect(classifyFailure(error)).toBe(FailureClassification.TRANSIENT);
  });

  it('PostgreSQL 40001 (serialization_failure) kodlu hata geçici olarak sınıflandırılır', () => {
    const error = withCode(new Error('could not serialize access'), '40001');
    expect(classifyFailure(error)).toBe(FailureClassification.TRANSIENT);
  });

  it('PostgreSQL 40P01 (deadlock) kodlu hata geçici olarak sınıflandırılır', () => {
    const error = withCode(new Error('deadlock detected'), '40P01');
    expect(classifyFailure(error)).toBe(FailureClassification.TRANSIENT);
  });

  it('Bilinmeyen hata güvenli varsayılan olarak geçici (TRANSIENT) sınıflandırılır', () => {
    const error = new Error('Bilinmeyen garip bir hata');
    expect(classifyFailure(error)).toBe(FailureClassification.TRANSIENT);
  });

  it('Error olmayan (örn. string veya obje) fırlatılan değer geçici sınıflandırılır', () => {
    expect(classifyFailure('Sadece bir string hata')).toBe(FailureClassification.TRANSIENT);
    expect(classifyFailure({ foo: 'bar' })).toBe(FailureClassification.TRANSIENT);
    expect(classifyFailure(null)).toBe(FailureClassification.TRANSIENT);
  });
});
