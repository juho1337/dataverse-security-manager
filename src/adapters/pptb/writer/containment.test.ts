import { describe, expect, it } from 'vitest';

// Mutating host methods may be named only inside adapters/pptb/writer, and only boundary.ts may call them.
// (The read adapter's own guard is ../readonly.test.ts.)
const all = import.meta.glob('../../../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const production = Object.entries(all).filter(([name]) => !/\.test\.tsx?$/.test(name) && !name.includes('/test/'));
const MUTATING = ['create', 'update', 'delete', 'execute', 'associate', 'disassociate', 'executeBatch', 'executeTransaction'];

function strip(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('write boundary containment', () => {
  it('finds production sources', () => {
    expect(production.length).toBeGreaterThan(10);
  });

  it('only writer/boundary.ts calls host mutating methods (raw.<method>)', () => {
    for (const [name, text] of production) {
      if (name.endsWith('/adapters/pptb/writer/boundary.ts')) continue;
      const code = strip(text);
      for (const method of MUTATING) {
        expect(new RegExp(`\\b(raw|dataverseAPI|powerplatformAPI|host)\\s*\\??\\.${method}\\s*[(.]`).test(code), `${name} calls ${method}`).toBe(false);
      }
    }
  });

  it('nothing outside adapters/pptb/writer imports the write boundary or the writer port implementation', () => {
    for (const [name, text] of production) {
      if (name.includes('/adapters/pptb/writer/')) continue;
      expect(/pptb\/writer\/boundary/.test(strip(text)), `${name} imports the boundary`).toBe(false);
    }
  });
});
