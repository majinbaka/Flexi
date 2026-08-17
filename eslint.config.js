// Root ESLint 9 flat config, shared by every workspace package.
//
// One config file rather than per-package configs: at this repo's size a
// single shared rule baseline is enough value; per-package configs would be
// a decision with no payoff yet (see Design Notes in
// _bmad-output/implementation-artifacts/spec-lint-ci-tooling.md).
//
// `eslint-config-prettier` MUST stay last in the array below so ESLint only
// flags logic/correctness issues -- Prettier remains the single formatting
// source of truth (see `format` / `format:check` scripts).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '.agents/**',
      '.claude/**',
      '_bmad/**',
      '_bmad-output/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // apps/backend -- NestJS, Node/CJS runtime (source is written with
  // import/export syntax, but ships as CommonJS -- see tsconfig.json).
  {
    files: ['apps/backend/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // apps/frontend -- React/Vite SPA, browser runtime, ESM.
  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.vite.rules,
    },
  },

  // packages/shared-types -- dual CJS+ESM library, no runtime globals of
  // its own beyond plain ECMAScript/TypeScript.
  {
    files: ['packages/shared-types/**/*.ts'],
  },

  eslintConfigPrettier,
);
