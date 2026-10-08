import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Syntax-only rules: type-aware linting runs out of memory on the engine's 600 KB API declaration.
export default tseslint.config(
  { ignores: ['node_modules/', 'types/', 'plugins/*/.claude-plugin/', 'plugins/**/*.js', '.koh/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
