const nextJest = require('next/jest');

const createJestConfig = nextJest({
  // Load next.config.mjs and .env files from this directory.
  dir: './',
});

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@smileflow/shared-types$': '<rootDir>/../../packages/shared-types/src',
  },
  testMatch: ['<rootDir>/tests/**/*.test.{ts,tsx}'],
};

module.exports = createJestConfig(config);
