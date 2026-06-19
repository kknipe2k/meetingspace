import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      // Framework-managed CommonJS tooling and scaffolding (Hard Rule §4.9):
      // the app surface is TypeScript/ESM; these .cjs scripts are linted by the
      // kit, not by the app's flat config.
      '**/*.cjs',
      '.claude/**',
      'templates/**',
      'validators/**',
      'scripts/**',
      'examples/**',
      // Generated base64 font data (M04.C, ADR-0013) — emitted by
      // scripts/generate-font-data.cjs, not hand-authored.
      'shared/fonts/font-data.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Allow intentionally-unused `_`-prefixed args/vars (e.g. the `_event`
      // parameter in IPC handler fakes). Retires the recurring mechanical friction
      // flagged in the M03 summary (decision #5).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The Anthropic SDK is main-process only (gotcha §3, Hard Rule §10). The
      // renderer talks to the LLM over typed IPC; the import-boundary test
      // (tests/unit/renderer-no-sdk-import.test.ts) is the runtime backstop.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/sdk',
              message: 'The Anthropic SDK is main-process only — use the typed llm IPC instead.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
