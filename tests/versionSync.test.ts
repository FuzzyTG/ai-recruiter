import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('version metadata', () => {
  it('keeps plugin, marketplace, npm package, and MCP server versions in sync', () => {
    const plugin = readJson('.claude-plugin/plugin.json');
    const marketplace = readJson('.claude-plugin/marketplace.json');
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const serverSource = fs.readFileSync(path.join(repoRoot, 'src/server.ts'), 'utf8');

    const pluginVersion = plugin.version;
    const marketplacePlugin = (marketplace.plugins as Array<Record<string, unknown>>).find(
      (entry) => entry.name === plugin.name,
    );

    expect(marketplacePlugin?.version).toBe(pluginVersion);
    expect(packageJson.version).toBe(pluginVersion);
    expect(packageLock.version).toBe(pluginVersion);
    expect((packageLock.packages as Record<string, Record<string, unknown>>)[''].version).toBe(pluginVersion);
    expect(serverSource).toContain(`version: '${pluginVersion}'`);
  });
});
