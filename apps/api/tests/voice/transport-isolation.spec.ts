import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TRANSPORT_DIR = join(__dirname, '../../src/modules/voice/transport');

function importedModules(source: string): string[] {
  const matches = source.matchAll(/from\s+['"]([^'"]+)['"]/g);
  return [...matches].map((m) => m[1]);
}

describe('the transport layer cannot reach tools', () => {
  const files = readdirSync(TRANSPORT_DIR).filter((f) => f.endsWith('.ts'));

  it('has transport files to check', () => {
    // Guards against the sweep below silently passing on an empty directory —
    // a sweep over nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)('%s imports neither the registry nor any tool', (file) => {
    const source = readFileSync(join(TRANSPORT_DIR, file), 'utf8');
    const imports = importedModules(source);

    const forbidden = imports.filter(
      (spec) => spec.includes('tool-registry') || /\.tool$/.test(spec) || spec.includes('/tools/')
    );

    expect(forbidden).toEqual([]);
  });

  it('the gateway holds no tool or registry reference in executable code', () => {
    // Comments are stripped first: the gateway's own doc comment explains why
    // it must not touch these, and a raw text match would flag that prose as a
    // violation. Only executable code counts.
    const source = readFileSync(join(TRANSPORT_DIR, 'voice.gateway.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/ToolRegistryService|ToolExecutorService/);
  });
});
