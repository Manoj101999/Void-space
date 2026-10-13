// Root ESLint flat config (ESLint 9). Shared baseline for the whole monorepo.
// App-specific overrides live next to the app (e.g. apps/web/eslint.config.mjs).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/.turbo/**',
      '**/generated/**',
      'packages/contracts/lib/**',
      'packages/contracts/out/**',
      'packages/contracts/cache/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
);
