import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

class ProfileError extends Error {}

export interface Repo {
  full_name: string;
  html_url: string;
  languages_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  language: string | null;
  pushed_at: string;
}
interface User { login: string; name: string | null; bio: string | null; html_url: string }
interface PullRequest {
  html_url: string; title: string; number: number; state: string;
  repository_url: string; updated_at: string;
}
interface Commit {
  sha: string; html_url: string; repository: Pick<Repo, 'full_name' | 'html_url' | 'private'>;
  commit: { message: string; author: { date: string } };
}
export interface Contributions {
  startedAt: string;
  endedAt: string;
  totalCommitContributions: number;
  totalPullRequestContributions: number;
  totalIssueContributions: number;
  totalPullRequestReviewContributions: number;
  restrictedContributionsCount: number;
  contributionCalendar: { totalContributions: number };
}
export interface Config {
  login: string;
  token: string;
  personal: boolean;
  includePrivate: boolean;
  maxRepos: number;
  searchPages: number;
  excludedLanguages: Set<string>;
  email: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new ProfileError(`${name} debe estar entre 1 y ${max}.`);
    return value;
  };
  const login = env.GITHUB_USERNAME || 'GonxKZ';
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) throw new ProfileError('GITHUB_USERNAME no es válido.');
  const token = env.PROFILE_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!token) throw new ProfileError('Define GITHUB_TOKEN o PROFILE_GITHUB_TOKEN para consultar GitHub.');
  return {
    login, token, personal: Boolean(env.PROFILE_GITHUB_TOKEN || env.GH_TOKEN),
    includePrivate: env.INCLUDE_PRIVATE_REPOS !== 'false',
    maxRepos: integer('MAX_LANGUAGE_REPOS', 500, 1000),
    searchPages: integer('SEARCH_PAGES', 3, 10),
    excludedLanguages: new Set((env.EXCLUDED_LANGUAGES ?? 'Hack').toLowerCase().split(',').map(s => s.trim())),
    email: env.CONTACT_EMAIL || 'gonzalo_kzz@hotmail.com',
  };
}

export function createClient(token: string, request = fetch, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  return async function api<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com') throw new ProfileError('Origen de API no permitido.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await request(url.href, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        if (attempt === 2) throw new ProfileError('No se pudo conectar con GitHub tras tres intentos.');
        await wait(1000 * 2 ** attempt);
        continue;
      }
      const throttled = response.status === 429 || (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
      const retryable = throttled || response.status >= 500;
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 2 ** attempt);
        if (retryable && attempt < 2 && Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 30) {
          await response.body?.cancel();
          await wait(retryAfter * 1000);
          continue;
        }
        // Los errores no incluyen rutas ni respuestas que puedan contener datos privados.
        throw new ProfileError(`GitHub respondió HTTP ${response.status}. Revisa permisos, caducidad y límites de la API.`);
      }
      if (response.headers.has('x-github-sso')) throw new ProfileError('GitHub requiere autorizar el token mediante SSO.');
      const result = await response.json() as T & { errors?: unknown[] };
      if (result.errors?.length) throw new ProfileError('La consulta GraphQL de GitHub contiene errores. No se publican datos parciales.');
      return result;
    }
    throw new ProfileError('Se agotaron los reintentos de GitHub.');
  };
}
type Client = ReturnType<typeof createClient>;

export async function paginate<T>(api: Client, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await api<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new ProfileError('La consulta supera 1000 repositorios. Acota el acceso antes de publicar un resultado incompleto.');
}

async function search<T>(api: Client, kind: string, query: string, sort: string, pages: number) {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= pages; page++) {
    const result = await api<{ items: T[]; total_count: number; incomplete_results: boolean }>(
      `/search/${kind}?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=100&page=${page}`);
    if (result.incomplete_results) throw new ProfileError('GitHub devolvió una búsqueda incompleta. Se conserva el perfil anterior.');
    items.push(...result.items);
    total = result.total_count;
    if (result.items.length < 100) break;
  }
  return { items, truncated: total > items.length };
}

export async function getContributions(api: Client, login: string, now: Date) {
  const result = await api<{ data: { user: { contributionsCollection: Contributions } | null } }>('/graphql', {
    query: `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) { contributionsCollection(from: $from, to: $to) {
        startedAt endedAt totalCommitContributions totalPullRequestContributions
        totalIssueContributions totalPullRequestReviewContributions restrictedContributionsCount
        contributionCalendar { totalContributions }
      } }
    }`,
    variables: { login, from: new Date(now.getTime() - 365 * 86400000).toISOString(), to: now.toISOString() },
  });
  if (!result.data.user) throw new ProfileError('No se ha encontrado el usuario de GitHub.');
  const stats = result.data.user.contributionsCollection;
  const counts = [stats.totalCommitContributions, stats.totalPullRequestContributions, stats.totalIssueContributions,
    stats.totalPullRequestReviewContributions, stats.restrictedContributionsCount, stats.contributionCalendar.totalContributions];
  if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new ProfileError('GitHub devolvió contadores no válidos.');
  return stats;
}

export function publicRepos(repos: Repo[]) {
  // Una visibilidad desconocida tampoco autoriza publicar detalles.
  return repos.filter(repo => repo.private === false);
}
const key = (name: string) => name.toLowerCase();
const prRepo = (pr: PullRequest) => pr.repository_url.split('/').slice(-2).join('/');

export async function collect(config: Config, api: Client, now: Date) {
  if (config.personal) {
    const viewer = await api<{ login: string }>('/user');
    if (key(viewer.login) !== key(config.login)) throw new ProfileError('El token personal debe pertenecer al usuario del perfil.');
  }
  const [user, stats, owned, accessible, prs, commits] = await Promise.all([
    api<User>(`/users/${config.login}`), getContributions(api, config.login, now),
    paginate<Repo>(api, `/users/${config.login}/repos?sort=pushed&direction=desc`),
    config.personal && config.includePrivate
      ? paginate<Repo>(api, '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc')
      : Promise.resolve([] as Repo[]),
    search<PullRequest>(api, 'issues', `is:pr is:public author:${config.login}`, 'updated', config.searchPages),
    search<Commit>(api, 'commits', `is:public author:${config.login}`, 'author-date', config.searchPages),
  ]);
  const repos = new Map<string, Repo>();
  for (const repo of [...owned, ...accessible]) {
    repos.set(key(repo.full_name), repo);
  }
  for (const name of new Set([...prs.items.map(prRepo), ...commits.items.map(c => c.repository.full_name)])) {
    if (!repos.has(key(name))) repos.set(key(name), await api<Repo>(`/repos/${name}`));
  }
  const allRepos = [...repos.values()]
    .filter(repo => config.includePrivate || repo.private === false)
    .sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
  if (allRepos.length > config.maxRepos) throw new ProfileError('Se ha superado el límite de repositorios. No se publican estadísticas de una muestra parcial.');
  const languageRepos = allRepos;
  const totals: Record<string, number> = {};
  for (const repo of languageRepos) {
    const languages = await api<Record<string, number>>(repo.languages_url);
    for (const [language, bytes] of Object.entries(languages)) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ProfileError('GitHub devolvió bytes de lenguaje no válidos.');
      if (!config.excludedLanguages.has(language.toLowerCase())) totals[language] = (totals[language] ?? 0) + bytes;
    }
  }
  const visible = publicRepos(allRepos).filter(repo => key(repo.full_name) !== key(`${config.login}/${config.login}`));
  const allowed = new Set(visible.map(r => key(r.full_name)));
  return {
    user, stats, repos: visible,
    prs: prs.items.filter(pr => allowed.has(key(prRepo(pr)))).slice(0, 5),
    commits: commits.items.filter(c => c.repository.private === false && allowed.has(key(c.repository.full_name)))
      .filter((c, i, all) => all.findIndex(other => other.sha === c.sha) === i).slice(0, 5),
    languages: Object.entries(totals).sort((a, b) => b[1] - a[1]),
    analyzed: languageRepos.length, detected: allRepos.length,
    privateLanguages: languageRepos.filter(repo => repo.private === true).length,
    searchTruncated: prs.truncated || commits.truncated,
    now,
  };
}
export type Activity = Awaited<ReturnType<typeof collect>>;

export const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\[\]`*_\\|]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ');
const count = (value: number) => value.toLocaleString('es-ES');
const date = (value: string) => new Date(value).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: 'short', year: 'numeric' });
function link(label: string, url: string) {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://github.com') throw new ProfileError('Enlace de GitHub no válido.');
  return `[${escapeText(label)}](${parsed.href.replace(/[()]/g, char => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'))})`;
}
const ICONS: Array<{ src: string; alt: string }> = [
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/cplusplus/cplusplus-original.svg", alt: "C++" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/c/c-original.svg", alt: "C" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/rust/rust-original.svg", alt: "Rust" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/python/python-original.svg", alt: "Python" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/java/java-original.svg", alt: "Java" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/typescript/typescript-original.svg", alt: "TypeScript" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/javascript/javascript-original.svg", alt: "JavaScript" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/bash/bash-original.svg", alt: "Bash" },

  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg", alt: "React" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nextjs/nextjs-original.svg", alt: "Next.js" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/bootstrap/bootstrap-original.svg", alt: "Bootstrap" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/tailwindcss/tailwindcss-original.svg", alt: "Tailwind CSS" },

  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/django/django-plain.svg", alt: "Django" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/pytorch/pytorch-original.svg", alt: "PyTorch" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/tensorflow/tensorflow-original.svg", alt: "TensorFlow" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/opencv/opencv-original.svg", alt: "OpenCV" },

  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/docker/docker-original.svg", alt: "Docker" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/kubernetes/kubernetes-plain.svg", alt: "Kubernetes" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg", alt: "Linux" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nginx/nginx-original.svg", alt: "Nginx" },

  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/postgresql/postgresql-original.svg", alt: "PostgreSQL" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/mysql/mysql-original.svg", alt: "MySQL" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/mongodb/mongodb-original.svg", alt: "MongoDB" },
  { src: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/redis/redis-original.svg", alt: "Redis" },
];

function renderSkillsGrid(icons = ICONS, cols = 6, size = 42) {
  const rows: string[] = [];
  for (let i = 0; i < icons.length; i += cols) {
    const cells = icons
      .slice(i, i + cols)
      .map(
        (ic) =>
          `<td align="center" width="100" height="80"><img src="${ic.src}" width="${size}" height="${size}" alt="${ic.alt}"/></td>`
      )
      .join("");
    rows.push(`<tr>${cells}</tr>`);
  }
  return `<table><tbody>${rows.join("")}</tbody></table>`;
}

export function buildReadme(activity: Activity, config: Config) {
  const { user, stats, languages, now } = activity;
  const totalBytes = languages.reduce((sum, [, bytes]) => sum + bytes, 0);
  const languageRows = languages.filter(([, bytes]) => totalBytes > 0 && bytes * 100 / totalBytes >= 0.05)
    .map(([language, bytes]) => `| ${escapeText(language)} | ${(100 * bytes / totalBytes).toFixed(1)}% | ${count(bytes)} |`);
  const repos = publicRepos(activity.repos);
  const allowed = new Set(repos.map(repo => key(repo.full_name)));
  const repoRows = repos.slice(0, 5).map(repo =>
    `| ${link(repo.full_name, repo.html_url)} | ${escapeText(repo.language || 'Sin clasificar')} | ${date(repo.pushed_at)} |`);
  const prs = activity.prs.filter(pr => allowed.has(key(prRepo(pr)))).map(pr =>
    `- ${link(`#${pr.number} ${pr.title}`, pr.html_url)} · ${escapeText(prRepo(pr))} · ${pr.state === 'open' ? 'Abierta' : 'Cerrada'} · ${date(pr.updated_at)}`);
  const commits = activity.commits.filter(c => c.repository.private === false && allowed.has(key(c.repository.full_name))).map(c =>
    `- ${link(c.commit.message.split('\n')[0].slice(0, 100), c.html_url)} · ${escapeText(c.repository.full_name)} · ${date(c.commit.author.date)}`);
  return `<h1>${escapeText(user.name || user.login)}</h1>

${escapeText(user.bio || 'Ingeniero de software. C/C++, inteligencia artificial, ciberseguridad y rendimiento.')}

[![Actualización del perfil](https://github.com/${config.login}/${config.login}/actions/workflows/update-readme.yml/badge.svg)](https://github.com/${config.login}/${config.login}/actions/workflows/update-readme.yml)

### Tecnologías

${renderSkillsGrid()}

### Actividad en GitHub

Del ${date(stats.startedAt)} al ${date(stats.endedAt)}. Datos del calendario de contribuciones de GitHub.

| Métrica | Contribuciones |
|---|---:|
| Total, incluidas las privadas que GitHub permite contabilizar | ${count(stats.contributionCalendar.totalContributions)} |
| Commits con desglose disponible | ${count(stats.totalCommitContributions)} |
| Pull requests con desglose disponible | ${count(stats.totalPullRequestContributions)} |
| Issues con desglose disponible | ${count(stats.totalIssueContributions)} |
| Revisiones de PR con desglose disponible | ${count(stats.totalPullRequestReviewContributions)} |
| Contribuciones privadas sin desglose | ${count(stats.restrictedContributionsCount)} |

Las contribuciones privadas sin desglose ya están incluidas en el total. GitHub no permite clasificarlas aquí como commits, PRs o issues. Los detalles de actividad que aparecen debajo son públicos.

![Calendario de contribuciones animado](assets/snake.svg)

### Repositorios públicos con actividad reciente

${repoRows.length ? '| Repositorio | Lenguaje principal | Último push |\n|---|---|---|\n' + repoRows.join('\n') : 'Sin repositorios públicos disponibles.'}

### PRs públicas recientes

${prs.join('\n') || 'Sin PRs públicas en la búsqueda actual.'}

### Commits públicos recientes

${commits.join('\n') || 'Sin commits públicos en la búsqueda actual.'}

### Lenguajes de los repositorios consultados

Bytes de código en ${activity.analyzed} de ${activity.detected} repositorios detectados, con ${activity.privateLanguages} privados incluidos de forma agregada. Se incluyen repositorios archivados y forks, cuyas copias pueden repetir código. Se excluyen los lenguajes configurados como ruido. Estos bytes describen los repositorios, no la autoría de cada línea.

${languageRows.length ? '| Lenguaje | Porcentaje | Bytes |\n|---|---:|---:|\n' + languageRows.join('\n') : 'Sin datos de lenguajes disponibles.'}

${config.personal && config.includePrivate ? 'Consulta autenticada de repositorios accesibles al token personal.' : 'Los lenguajes se calculan sobre repositorios públicos. Las contribuciones privadas se cuentan cuando GitHub las expone de forma anónima.'}
${activity.searchTruncated ? '\nLa búsqueda de actividad pública se ha limitado a las páginas más recientes.\n' : ''}
### Contacto

- Correo: ${escapeText(config.email)}
- GitHub: ${link(user.login, user.html_url)}

[Funcionamiento y límites de las estadísticas](docs/actualizacion.md).

<sub>Actualizado el ${now.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} (Europe/Madrid). Actualización programada cada día.</sub>
`;
}

export async function main() {
  const config = loadConfig();
  const now = new Date();
  const activity = await collect(config, createClient(config.token), now);
  const next = buildReadme(activity, config);
  if (!existsSync('README.md') || readFileSync('README.md', 'utf8') !== next) writeFileSync('README.md', next, 'utf8');
  const summary = `Perfil actualizado. ${activity.stats.contributionCalendar.totalContributions} contribuciones, ` +
    `${activity.stats.restrictedContributionsCount} privadas sin desglose. Lenguajes: ${activity.analyzed} repositorios, ` +
    `${activity.privateLanguages} privados. Token personal: ${config.personal ? 'sí' : 'no'}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n', { flag: 'a' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('No se ha podido actualizar el perfil. El README anterior se conserva.');
    console.error(error instanceof ProfileError ? error.message : 'Respuesta inesperada o error local al generar el perfil.');
    process.exitCode = 1;
  });
}
