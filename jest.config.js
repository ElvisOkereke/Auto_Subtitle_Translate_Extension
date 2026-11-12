const extension = {
  displayName: 'extension',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }]
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'json']
};

// The hosted proxy (server/): Node environment, its own tsconfig (Node types).
const server = {
  displayName: 'server',
  testEnvironment: 'node',
  roots: ['<rootDir>/server/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: 'server/tsconfig.json' }]
  },
  moduleFileExtensions: ['ts', 'js', 'json']
};

module.exports = {
  projects: [extension, server],
  collectCoverageFrom: ['src/**/*.ts', 'server/src/**/*.ts', '!src/**/*.d.ts', '!src/test/**']
};
