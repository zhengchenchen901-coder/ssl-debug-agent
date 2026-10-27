module.exports = {
  rootDir: require('node:path').resolve(__dirname, '..'),
  testEnvironment: 'node',
  testMatch: ['<rootDir>/verification/**/*.test.js'],
  transform: { '^.+\\.js$': '<rootDir>/verification/transform.cjs' },
  testTimeout: 30000,
};
