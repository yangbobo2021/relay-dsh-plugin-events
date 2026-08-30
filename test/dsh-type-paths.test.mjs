import assert from 'node:assert/strict';
import test from 'node:test';
import { declarationPaths } from '../scripts/dsh-type-paths.mjs';

test('development type paths honor package subpath exports and conditional declarations', () => {
  assert.deepEqual(declarationPaths({ name: '@deepseek-ai/example', exports: {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './types': { types: './lib/types/types.d.ts' },
    './client': { import: { types: './lib/client.d.mts' } },
    './source/*': './src/*.ts',
    './package.json': './package.json',
  } }, '/official/example'), {
    '@deepseek-ai/example': ['/official/example/lib/types/index.d.ts'],
    '@deepseek-ai/example/types': ['/official/example/lib/types/types.d.ts'],
    '@deepseek-ai/example/client': ['/official/example/lib/client.d.mts'],
    '@deepseek-ai/example/source/*': ['/official/example/src/*.ts'],
  });
});
