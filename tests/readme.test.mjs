import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/build_readme.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));

test('actualiza sin token personal e incluye el total privado anonimizado', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'profile-test-'));
  try {
    writeFileSync(join(cwd, 'README.md'), 'Perfil antiguo');
    const result = spawnSync(process.execPath, ['--import', fixture, script], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PROFILE_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: 'test',
        GITHUB_USERNAME: 'GonxKZ', INCLUDE_PRIVATE_REPOS: 'true' },
    });
    assert.equal(result.status, 0, result.stderr);
    const readme = readFileSync(join(cwd, 'README.md'), 'utf8');
    assert.notEqual(readme, 'Perfil antiguo');
    assert.match(readme, /57/);
    assert.match(readme, /30/);
    assert.doesNotMatch(readme, /github-readme-stats\.vercel/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('un error de API conserva el README y devuelve fallo sin datos privados', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'profile-error-'));
  try {
    writeFileSync(join(cwd, 'README.md'), 'Perfil anterior válido');
    const result = spawnSync(process.execPath, ['--import', fixture, script], {
      cwd, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PROFILE_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: 'test', FIXTURE_FAILURE: 'true' },
    });
    assert.equal(result.status, 1);
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'Perfil anterior válido');
    assert.match(result.stderr, /GraphQL/);
    assert.doesNotMatch(result.stderr, /secret-project/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
