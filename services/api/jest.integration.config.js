/**
 * Integration tests: require a real PostgreSQL+PostGIS and Redis.
 * Start them with `npm run infra:up` from the repository root.
 *
 * These tests fail loudly when infrastructure is unreachable — they never skip,
 * because a silent skip hides migration and constraint regressions.
 *
 * They run serially (maxWorkers: 1) because they share one database and reset its
 * schema; serialization is part of the configuration, not something the caller must
 * remember to pass on the command line.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.integration.spec.ts'],
  setupFiles: ['<rootDir>/test/setup-integration.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
  clearMocks: true,
};
