import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

/**
 * ── WHY THERE ARE NOW THREE BLOCKS ──────────────────────────────────────────
 * The config previously declared `files: ['src/**\/*.ts']` and nothing else. It
 * did not stop ESLint looking at the rest of the repo — it only stopped ESLint
 * knowing how to READ it, so every .ts file outside src/ was handed to the
 * default parser and failed on the first `interface` or type annotation. The
 * result was ~70 "Parsing error" entries that said nothing about the code and
 * drowned the handful of findings that did.
 *
 * Build output is now ignored (linting dist/ was never intended), and the
 * remaining TypeScript — tests, one-off scripts, prisma seeds — is parsed
 * properly and linted, just without the type-aware `project` setting, which
 * those files are not in the tsconfig for.
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Tests, scripts and seeds. Same correctness rules, minus the two that only
    // make sense for shipped code: a script is expected to print, and a test
    // fixture is expected to be loosely typed.
    files: ['tests/**/*.ts', 'scripts/**/*.ts', 'prisma/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
