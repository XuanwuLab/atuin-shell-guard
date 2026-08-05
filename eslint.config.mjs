import js from '@eslint/js';
import globals from 'globals';
import nodePlugin from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'plugin/*.cjs',
      'old/**',
      'testing-repo/**',
      'tmp-local-install/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  nodePlugin.configs['flat/recommended-module'],
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/hashbang': 'off',
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
  {
    files: [
      'src/bash/cli.ts',
      'src/bash/repl.ts',
      'src/plugin/direct-hook.ts',
      'src/bash/__tests__/**/*.ts',
      'scripts/**/*.mjs',
      'plugin_test_harness/**/*.mjs',
    ],
    rules: {
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'plugin_test_harness/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
