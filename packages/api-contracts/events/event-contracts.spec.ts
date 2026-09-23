import {
  validateEnvelope,
  BookingCreatedSchema,
  SafetyAlertRaisedSchema,
  IdentityVerifiedSchema,
  EVENT_TOPIC_MAP,
} from './index';

describe('Event Contracts', () => {
  describe('Envelope Validation', () => {
    it('validates a valid envelope', () => {
      const validEnvelope = {
        eventId: '123e4567-e89b-12d3-a456-426614174000',
        eventType: 'BookingCreated',
        eventVersion: 1,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        aggregateType: 'booking',
        aggregateId: '123e4567-e89b-12d3-a456-426614174001',
        producer: 'services/api',
        correlationId: null,
        payload: { someKey: 'someValue' },
      };

      expect(() => validateEnvelope(validEnvelope)).not.toThrow();
    });

    it('fails when missing required fields', () => {
      const invalidEnvelope = {
        eventId: '123e4567-e89b-12d3-a456-426614174000',
        // missing eventType
        eventVersion: 1,
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        aggregateType: 'booking',
        aggregateId: '123e4567-e89b-12d3-a456-426614174001',
        producer: 'services/api',
        correlationId: null,
        payload: {},
      };

      expect(() => validateEnvelope(invalidEnvelope)).toThrow();
    });
  });

  describe('Payload Schemas', () => {
    it('BookingCreated payload validates correctly', () => {
      const payload = {
        bookingId: '123e4567-e89b-12d3-a456-426614174000',
        customerId: '123e4567-e89b-12d3-a456-426614174002',
        providerId: null,
        serviceId: '123e4567-e89b-12d3-a456-426614174003',
        scheduledStart: new Date().toISOString(),
        scheduledEnd: new Date().toISOString(),
      };

      expect(() => BookingCreatedSchema.parse(payload)).not.toThrow();
    });

    it('does not contain sensitive fields in SafetyAlertRaised', () => {
      // Just verifying the schema keys don't have sensitive data
      const keys = Object.keys(SafetyAlertRaisedSchema.shape);
      expect(keys).not.toContain('coordinates');
      expect(keys).not.toContain('address');
      expect(keys).not.toContain('phone');
    });

    it('does not contain sensitive fields in IdentityVerified', () => {
      const keys = Object.keys(IdentityVerifiedSchema.shape);
      expect(keys).not.toContain('tckn');
      expect(keys).not.toContain('biometric');
      expect(keys).not.toContain('identityHash');
    });
  });

  describe('Topic Mapping', () => {
    it('maps known event types to topics', () => {
      expect(EVENT_TOPIC_MAP['BookingCreated']).toBe('emek.booking');
      expect(EVENT_TOPIC_MAP['PaymentAuthorized']).toBe('emek.payment');
      expect(EVENT_TOPIC_MAP['SafetyAlertRaised']).toBe('emek.safety');
      expect(EVENT_TOPIC_MAP['UserRegistered']).toBe('emek.identity');
    });
  });
});
