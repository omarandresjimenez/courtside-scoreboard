/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Type-checking here would require the Prisma client to already be
        // generated (`prisma generate`), which needs network access this
        // sandbox's egress allowlist blocks. Tests still run fully — this
        // only skips compile-time type-checking during the Jest transform;
        // `npm run typecheck` (a separate, real tsc pass) is the actual
        // type-safety gate and will catch what this can't here.
        tsconfig: { module: 'commonjs', moduleResolution: 'node', isolatedModules: true },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/testUtils/**',
    // Bootstrap/wiring, not logic — see README's "Quality gates" section.
    '!src/db/client.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
