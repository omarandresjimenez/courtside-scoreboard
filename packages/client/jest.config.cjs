/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          jsx: 'react-jsx',
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.css$': 'identity-obj-proxy',
  },
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.test.{ts,tsx}',
    // Bootstrap/wiring, not logic — see README's "Quality gates" section.
    '!src/main.tsx',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    // 100 on every metric except branches: AdminDashboard.tsx has one
    // documented, currently-unreachable branch for the not-yet-built
    // "custom" scoring preset (see the comment at its call site) — this is
    // deliberately not gamed with a fake test or an istanbul-ignore.
    global: { branches: 98, functions: 100, lines: 100, statements: 100 },
  },
};
