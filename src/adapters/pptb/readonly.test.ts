import { describe, expect, it } from 'vitest';

// The PPTB adapter may only use read-only host methods. This guards against a mutating call slipping in
// before the separately approved write boundary exists.
const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const READ_ONLY_DATAVERSE_METHODS = new Set([
  'retrieve',
  'fetchXmlQuery',
  'retrieveMultiple',
  'queryData',
  'getEntityMetadata',
  'getAllEntitiesMetadata',
  'getEntityRelatedMetadata',
  'getEntitySetName',
]);
const MUTATING = [
  'create', 'update', 'delete', 'execute', 'associate', 'disassociate', 'executeBatch', 'executeTransaction',
  'createMultiple', 'updateMultiple', 'deploySolution', 'publishCustomizations', 'createEntityDefinition',
  'updateEntityDefinition', 'deleteEntityDefinition', 'createAttribute', 'updateAttribute', 'deleteAttribute',
];

describe('PPTB adapter is read-only', () => {
  const production = Object.entries(sources).filter(([name]) => !name.endsWith('.test.ts'));

  it('finds the adapter sources', () => {
    expect(production.length).toBeGreaterThan(0);
  });

  it('only calls allow-listed read methods on dataverseAPI', () => {
    for (const [name, text] of production) {
      const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of code.matchAll(/dataverseAPI\s*\??\.\s*(\w+)/g)) {
        expect(READ_ONLY_DATAVERSE_METHODS.has(m[1] ?? ''), `${name} calls dataverseAPI.${m[1]}`).toBe(true);
      }
    }
  });

  it('never references a mutating host method by name on any host API', () => {
    for (const [name, text] of production) {
      const code = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const method of MUTATING) {
        expect(new RegExp(`\\b(dataverseAPI|powerplatformAPI)\\b[^;]*\\.${method}\\s*\\(`).test(code), `${name} uses ${method}`).toBe(false);
      }
    }
  });
});
