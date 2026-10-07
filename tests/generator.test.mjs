import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadme, collect, createClient, escapeText, getContributions, loadConfig, paginate, publicRepos } from '../scripts/build_readme.ts';

const config = loadConfig({ GITHUB_TOKEN: 'fixture', GITHUB_USERNAME: 'GonxKZ', MAX_LANGUAGE_REPOS: '1' });
const now = new Date('2026-10-08T12:00:00Z');
const repo = (name, privateRepo = false) => ({
  full_name: `GonxKZ/${name}`, html_url: `https://github.com/GonxKZ/${name}`,
  languages_url: `https://api.github.com/repos/GonxKZ/${name}/languages`,
  private: privateRepo, fork: false, archived: false, description: name,
  language: 'TypeScript', pushed_at: '2026-10-08T10:00:00Z',
});
const stats = {
  startedAt: '2025-10-08T12:00:00Z', endedAt: now.toISOString(), totalCommitContributions: 20,
  totalPullRequestContributions: 4, totalIssueContributions: 2, totalPullRequestReviewContributions: 1,
  restrictedContributionsCount: 30, contributionCalendar: { totalContributions: 57 },
};
const publicRepo = { ...repo('public-demo'), fork: true };
const privateRepo = { ...repo('secret-project', true), archived: true };
const commit = (repository) => ({ sha: repository.full_name, repository,
  html_url: `${repository.html_url}/commit/123`, commit: { message: 'Mensaje ' + repository.full_name, author: { date: now.toISOString() } } });
const pr = (repository) => ({ title: 'PR ' + repository.full_name, number: 1, state: 'open',
  html_url: `${repository.html_url}/pull/1`, repository_url: `https://api.github.com/repos/${repository.full_name}`, updated_at: now.toISOString() });
const user = { login: 'GonxKZ', name: 'Gonzalo', bio: 'Software', html_url: 'https://github.com/GonxKZ' };
const activity = {
  user, stats, repos: [publicRepo, privateRepo], prs: [pr(publicRepo), pr(privateRepo)],
  commits: [commit(publicRepo), commit(privateRepo)], languages: [['TypeScript', 300]],
  analyzed: 2, detected: 2, privateLanguages: 1, searchTruncated: false, now,
};

test('publica agregados privados sin nombres, enlaces, títulos o mensajes privados', () => {
  const output = buildReadme(activity, config);
  assert.match(output, /public-demo/);
  assert.doesNotMatch(output, /secret-project/);
  assert.match(output, /\| TypeScript \| 100.0% \| 300 \|/);
  assert.match(output, /\| Contribuciones privadas sin desglose \| 30 \|/);
  assert.match(output, /\| Total, incluidas las privadas que GitHub permite contabilizar \| 57 \|/);
});

test('no publica repositorios de visibilidad desconocida', () => {
  assert.deepEqual(publicRepos([publicRepo, { ...privateRepo, private: undefined }]), [publicRepo]);
});

test('escapa HTML y sintaxis Markdown de los datos de GitHub', () => {
  assert.equal(escapeText('<img src=x>|[texto]\n&`'), '&lt;img src=x&gt;&#124;&#91;texto&#93; &amp;&#96;');
  const output = buildReadme({ ...activity, user: { ...user, bio: '<script>alert(1)</script>' } }, config);
  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /&lt;script&gt;/);
});

test('rechaza enlaces de repositorio ajenos a GitHub', () => {
  assert.throws(() => buildReadme({ ...activity, repos: [{ ...publicRepo, html_url: 'https://evil.example' }] }, config), /Enlace/);
});

test('describe ausencia de actividad y límites de búsqueda sin inventar resultados', () => {
  const output = buildReadme({ ...activity, repos: [], prs: [], commits: [], languages: [], searchTruncated: true }, config);
  assert.match(output, /Sin repositorios públicos/);
  assert.match(output, /Sin commits públicos/);
  assert.match(output, /Sin PRs públicas/);
  assert.match(output, /Sin datos de lenguajes/);
  assert.match(output, /limitado a las páginas/);
});

for (const value of ['0', '-1', 'NaN', '1.5', '1001']) {
  test(`rechaza límite de repositorios inválido: ${value}`, () => {
    assert.throws(() => loadConfig({ GITHUB_TOKEN: 'fixture', MAX_LANGUAGE_REPOS: value }), /MAX_LANGUAGE_REPOS/);
  });
}
test('requiere credencial y valida el usuario antes de consultar', () => {
  assert.throws(() => loadConfig({}), /TOKEN/);
  assert.throws(() => loadConfig({ GITHUB_TOKEN: 'fixture', GITHUB_USERNAME: 'a/../b' }), /USERNAME/);
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('no envía el token a otro origen', async () => {
  const api = createClient('sensitive', () => { throw new Error('No debe hacer peticiones'); });
  await assert.rejects(api('https://evil.example/steal'), /Origen/);
});

test('propaga un 403 de permisos sin esperas y sin contenido privado', async () => {
  const api = createClient('fixture', async () => json({ message: 'secret-project' }, 403), async () => assert.fail('No se debe reintentar'));
  await assert.rejects(api('/repos/secret-project'), error => /HTTP 403/.test(error.message) && !error.message.includes('secret-project'));
});

test('recupera un error transitorio con reintentos acotados', async () => {
  let attempts = 0;
  const api = createClient('fixture', async () => ++attempts < 3 ? json({}, 503) : json({ ok: true }), async () => {});
  assert.deepEqual(await api('/user'), { ok: true });
  assert.equal(attempts, 3);
});

test('abandona tras tres respuestas transitorias fallidas', async () => {
  let attempts = 0;
  const api = createClient('fixture', async () => { attempts++; return json({}, 503); }, async () => {});
  await assert.rejects(api('/user'), /HTTP 503/);
  assert.equal(attempts, 3);
});

test('respeta Retry-After acotado y rechaza esperas superiores al presupuesto', async () => {
  let attempts = 0;
  const waits = [];
  const api = createClient('fixture', async () => ++attempts === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ ok: true }), async ms => waits.push(ms));
  assert.deepEqual(await api('/user'), { ok: true });
  assert.deepEqual(waits, [2000]);
  const long = createClient('fixture', async () => json({}, 429, { 'retry-after': '3600' }), async () => assert.fail('Espera no acotada'));
  await assert.rejects(long('/user'), /HTTP 429/);
});

test('no acepta respuestas GraphQL parciales ni autorizaciones SSO incompletas', async () => {
  const graphql = createClient('fixture', async () => json({ data: {}, errors: [{ message: 'secret' }] }));
  await assert.rejects(graphql('/graphql', {}), /GraphQL/);
  const sso = createClient('fixture', async () => json([], 200, { 'x-github-sso': 'partial-results; organizations=123' }));
  await assert.rejects(sso('/user/repos'), /SSO/);
});

test('pagina repositorios y no confunde la primera página con el total', async () => {
  const api = createClient('fixture', async input => {
    const page = new URL(input).searchParams.get('page');
    return json(page === '1' ? Array.from({ length: 100 }, (_, i) => i) : [100]);
  });
  const all = await paginate(api, '/repos');
  assert.equal(all.length, 101);
  assert.equal(all[100], 100);
});

test('falla al alcanzar el límite de paginación sin confirmar el final', async () => {
  const api = createClient('fixture', async () => json(Array(100).fill(0)));
  await assert.rejects(paginate(api, '/repos'), /1000/);
});

test('consulta un periodo explícito de 365 días y rechaza contadores inválidos', async () => {
  const api = createClient('fixture', async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).variables, { login: 'GonxKZ', from: '2025-10-08T12:00:00.000Z', to: '2026-10-08T12:00:00.000Z' });
    return json({ data: { user: { contributionsCollection: stats } } });
  });
  assert.deepEqual(await getContributions(api, 'GonxKZ', now), stats);
  const invalid = createClient('fixture', async () => json({ data: { user: { contributionsCollection: { ...stats, totalCommitContributions: -1 } } } }));
  await assert.rejects(getContributions(invalid, 'GonxKZ', now), /contadores/);
  const missing = createClient('fixture', async () => json({ data: { user: null } }));
  await assert.rejects(getContributions(missing, 'missing', now), /usuario/);
});

function collectionClient({ incomplete = false, badBytes = false, mismatch = false } = {}) {
  return createClient('fixture', async input => {
    const url = new URL(input);
    if (url.pathname === '/user') return json({ login: mismatch ? 'another-user' : 'GonxKZ' });
    if (url.pathname === '/users/GonxKZ') return json(user);
    if (url.pathname === '/graphql') return json({ data: { user: { contributionsCollection: stats } } });
    if (url.pathname === '/users/GonxKZ/repos') return json([publicRepo]);
    if (url.pathname === '/user/repos') return json([privateRepo, { ...publicRepo, pushed_at: '2025-01-01T00:00:00Z' }]);
    if (url.pathname === '/search/issues') return json({ items: [pr(publicRepo)], total_count: 1, incomplete_results: incomplete });
    if (url.pathname === '/search/commits') return json({ items: [{ ...commit(publicRepo), repository: { full_name: publicRepo.full_name, html_url: publicRepo.html_url, private: false } }], total_count: 1, incomplete_results: incomplete });
    if (url.pathname.endsWith('/languages')) return json({ TypeScript: badBytes ? -1 : 100, Hack: 1000 });
    throw new Error('Ruta inesperada: ' + url.pathname);
  });
}

test('incluye forks y archivados al agregar todos los lenguajes sin publicar detalles privados', async () => {
  const personal = { ...config, personal: true, maxRepos: 500 };
  const result = await collect(personal, collectionClient(), now);
  assert.equal(result.analyzed, 2);
  assert.equal(result.detected, 2);
  assert.equal(result.privateLanguages, 1);
  assert.deepEqual(result.languages, [['TypeScript', 200]]);
  assert.equal(result.commits.length, 1);
  assert.equal(result.prs.length, 1);
  assert.doesNotMatch(buildReadme(result, personal), /secret-project/);
});

test('rechaza tokens de otra cuenta y búsquedas incompletas', async () => {
  await assert.rejects(collect({ ...config, personal: true }, collectionClient({ mismatch: true }), now), /pertenecer/);
  await assert.rejects(collect(config, collectionClient({ incomplete: true }), now), /incompleta/);
  await assert.rejects(collect(config, collectionClient({ badBytes: true }), now), /bytes/);
});

test('reintenta fallos de conexión sin filtrar su mensaje privado', async () => {
  let attempts = 0;
  const api = createClient('fixture', async () => {
    if (++attempts < 3) throw new TypeError('private-host');
    return json({ ok: true });
  }, async () => {});
  assert.deepEqual(await api('/user'), { ok: true });
  const failing = createClient('fixture', async () => { throw new TypeError('private-host'); }, async () => {});
  await assert.rejects(failing('/user'), error => /conectar/.test(error.message) && !error.message.includes('private-host'));
});

test('rechaza una muestra parcial cuando el número de repositorios supera el presupuesto', async () => {
  await assert.rejects(collect({ ...config, personal: true }, collectionClient(), now), /límite de repositorios/);
});
