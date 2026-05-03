/// <reference lib="dom" />
/// <reference types="node" />

/**
 * README “bonito”:
 * - Header animado (typing)
 * - Stats (sin stars/issues/contribs) → commits + PRs
 * - 🐍 Snake (SVG generado en assets/snake.svg)
 * - En curso: tabla últimos 5 repos (excluye repo del perfil)
 * - Lenguajes más usados: oculta 0.0% (pct < 0.05)
 * - PRs recientes (5) — excluye repo de perfil
 * - Commits recientes (5) — excluye repo de perfil
 * - Skills en GRID 6×4 (24 iconos)
 * - Stats en columna: primero “Most Used Languages”, debajo “stats”
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// -------- Tipos mínimos --------
interface GitHubUser {
  login: string;
  name: string | null;
  bio: string | null;
  public_repos: number;
  html_url: string;
  blog: string | null;
  company: string | null;
  location: string | null;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  owner?: { login: string; type?: string };
  fork: boolean;
  description: string | null;
  html_url: string;
  languages_url: string;
  pushed_at: string; // ISO
  archived: boolean;
  language: string | null;
  private?: boolean;
}

type LanguagesMap = Record<string, number>;

interface GitHubOrg {
  login: string;
}

interface SearchIssuesResult {
  items: Array<{
    html_url: string;
    title: string;
    state: "open" | "closed";
    number: number;
    repository_url: string;
    updated_at: string;
    created_at: string;
  }>;
}

interface SearchCommitsResult {
  items: Array<{
    sha: string;
    html_url: string;
    commit: {
      message: string;
      author: { date: string; name?: string; email?: string | null };
      committer?: { date: string };
    };
    repository: GitHubRepo;
  }>;
}

// -------- Config --------
const USERNAME = process.env.GITHUB_USERNAME ?? (process.env.CI ? process.env.USERNAME : undefined) ?? "GonxKZ";
const TOKEN = process.env.PROFILE_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const HAS_PERSONAL_TOKEN = Boolean(process.env.PROFILE_GITHUB_TOKEN || process.env.GH_TOKEN);
const CONTACT_EMAIL = process.env.CONTACT_EMAIL ?? "gonzalo_kzz@hotmail.com";
const MAX_LANGUAGE_REPOS = Number(process.env.MAX_LANGUAGE_REPOS ?? 140);
const SEARCH_PAGES = Number(process.env.SEARCH_PAGES ?? 3);
const INCLUDE_FORKS = /^true$/i.test(process.env.INCLUDE_FORKS ?? "");
const INCLUDE_PRIVATE_REPOS = /^true$/i.test(process.env.INCLUDE_PRIVATE_REPOS ?? "");
const EXCLUDED_LANGUAGES = new Set(
  (process.env.EXCLUDED_LANGUAGES ?? "Hack")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
);
const CONFIGURED_ORGS = (process.env.GITHUB_ORGS ?? process.env.ORGANIZATIONS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.warn("GITHUB_TOKEN no definido. Se usara la API publica con limites de rate-limit mas estrictos.");
}

const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (TOKEN) HEADERS.Authorization = `Bearer ${TOKEN}`;

// -------- Utils --------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mdLink = (text: string, url: string) => `[${text}](${url})`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const esc = (s: unknown) => (s ?? "").toString().replace(/\|/g, "\\|");
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { year: "numeric", month: "short", day: "2-digit" });
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "… " : s);
const repoKey = (fullName: string) => fullName.toLowerCase();
const profileRepoFullName = (login: string) => `${login}/${login}`.toLowerCase();

// -------- API --------
async function gh<T>(url: string, init: RequestInit = {}, retries = 3): Promise<T> {
  const res = await fetch(url, { headers: HEADERS, ...init });
  if (res.status === 403 && retries > 0) {
    const reset = res.headers.get("x-ratelimit-reset");
    const now = Math.floor(Date.now() / 1000);
    const waitSec = reset ? Math.max(0, Number(reset) - now) + 1 : 30;
    console.warn(`Rate-limited. Esperando ${waitSec}s…`);
    await sleep(waitSec * 1000);
    return gh<T>(url, init, retries - 1);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} :: ${url}\n${txt}`);
  }
  return (await res.json()) as T;
}

async function getUser(login: string) {
  return gh<GitHubUser>(`https://api.github.com/users/${login}`);
}

async function getOwnedRepos(login: string) {
  const perPage = 100;
  let page = 1;
  const all: GitHubRepo[] = [];
  while (true) {
    const chunk = await gh<GitHubRepo[]>(
      `https://api.github.com/users/${login}/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc`
    );
    all.push(...chunk);
    if (chunk.length < perPage) break;
    page++;
    await sleep(100);
  }
  return filterRepos(all);
}

async function getAuthenticatedRepos() {
  if (!process.env.PROFILE_GITHUB_TOKEN && !process.env.GH_TOKEN) return [];

  const perPage = 100;
  let page = 1;
  const all: GitHubRepo[] = [];
  const visibility = INCLUDE_PRIVATE_REPOS ? "all" : "public";
  while (true) {
    const chunk = await gh<GitHubRepo[]>(
      `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated&direction=desc&visibility=${visibility}&affiliation=owner,collaborator,organization_member`
    );
    all.push(...chunk);
    if (chunk.length < perPage) break;
    page++;
    await sleep(100);
  }
  return filterRepos(all);
}

async function getPublicOrganizations(login: string) {
  const perPage = 100;
  let page = 1;
  const all: GitHubOrg[] = [];
  while (true) {
    const chunk = await gh<GitHubOrg[]>(`https://api.github.com/users/${login}/orgs?per_page=${perPage}&page=${page}`);
    all.push(...chunk);
    if (chunk.length < perPage) break;
    page++;
    await sleep(100);
  }
  return all.map((org) => org.login);
}

async function getAuthenticatedOrganizations() {
  if (!process.env.PROFILE_GITHUB_TOKEN && !process.env.GH_TOKEN) return [];

  const perPage = 100;
  let page = 1;
  const all: GitHubOrg[] = [];
  while (true) {
    const chunk = await gh<GitHubOrg[]>(`https://api.github.com/user/orgs?per_page=${perPage}&page=${page}`);
    all.push(...chunk);
    if (chunk.length < perPage) break;
    page++;
    await sleep(100);
  }
  return all.map((org) => org.login);
}

async function getRepo(fullName: string) {
  return gh<GitHubRepo>(`https://api.github.com/repos/${fullName}`);
}

async function getRepoLanguages(languages_url: string) {
  return gh<LanguagesMap>(languages_url);
}

function filterRepos(repos: GitHubRepo[]) {
  return repos.filter((r) => (INCLUDE_FORKS || !r.fork) && !r.archived && (INCLUDE_PRIVATE_REPOS || !r.private));
}

function mergeRepos(target: Map<string, GitHubRepo>, repos: GitHubRepo[]) {
  for (const repo of filterRepos(repos)) {
    target.set(repoKey(repo.full_name), repo);
  }
}

async function searchPRs(login: string, pages = SEARCH_PAGES) {
  const items: SearchIssuesResult["items"] = [];
  const visibilityQualifier = INCLUDE_PRIVATE_REPOS && (process.env.PROFILE_GITHUB_TOKEN || process.env.GH_TOKEN) ? "" : "+is:public";
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.github.com/search/issues?q=is:pr+author:${encodeURIComponent(
      login
    )}${visibilityQualifier}&sort=updated&order=desc&per_page=100&page=${page}`;
    const res = await gh<SearchIssuesResult>(url);
    items.push(...res.items);
    if (res.items.length < 100) break;
    await sleep(100);
  }
  return items;
}

async function searchCommits(login: string, pages = SEARCH_PAGES) {
  const items: SearchCommitsResult["items"] = [];
  for (let page = 1; page <= pages; page++) {
    const url = `https://api.github.com/search/commits?q=author:${encodeURIComponent(
      login
    )}&sort=author-date&order=desc&per_page=100&page=${page}`;
    const res = await gh<SearchCommitsResult>(url);
    items.push(...res.items);
    if (res.items.length < 100) break;
    await sleep(100);
  }
  return items;
}

async function getPublicEventRepos(login: string) {
  type EventsResp = Array<{
    type: string;
    repo: { name: string };
    created_at: string;
    payload?: { commits?: Array<{ sha: string; message: string; url?: string }> };
  }>;
  const events = await gh<EventsResp>(`https://api.github.com/users/${login}/events/public`);
  return events.map((ev) => ev.repo.name);
}

function prRepoFullName(item: SearchIssuesResult["items"][number]) {
  return item.repository_url.split("/").slice(-2).join("/");
}

async function hydrateRepos(fullNames: Iterable<string>) {
  const repos: GitHubRepo[] = [];
  const uniqueFullNames = Array.from(new Set(Array.from(fullNames).map((name) => name.trim()).filter(Boolean)));
  for (const fullName of uniqueFullNames) {
    try {
      repos.push(await getRepo(fullName));
      await sleep(60);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Repositorio no leído ${fullName}: ${msg}`);
    }
  }
  return filterRepos(repos);
}

async function discoverActivityUniverse(login: string) {
  const [user, ownedRepos, authenticatedRepos, publicOrgs, authenticatedOrgs, prItems, commitItems, eventRepoNames] =
    await Promise.all([
      getUser(login),
      getOwnedRepos(login),
      getAuthenticatedRepos().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Repos autenticados no disponibles: ${msg}`);
        return [] as GitHubRepo[];
      }),
      getPublicOrganizations(login).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Organizaciones públicas no disponibles: ${msg}`);
        return [] as string[];
      }),
      getAuthenticatedOrganizations().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Organizaciones autenticadas no disponibles: ${msg}`);
        return [] as string[];
      }),
      searchPRs(login),
      searchCommits(login).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Busqueda de commits no disponible: ${msg}`);
        return [] as SearchCommitsResult["items"];
      }),
      getPublicEventRepos(login).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Eventos publicos no disponibles: ${msg}`);
        return [] as string[];
      }),
    ]);

  const repos = new Map<string, GitHubRepo>();
  mergeRepos(repos, ownedRepos);
  mergeRepos(repos, authenticatedRepos);
  mergeRepos(
    repos,
    commitItems.map((item) => item.repository)
  );

  const fullNamesToHydrate = new Set<string>();
  for (const item of prItems) fullNamesToHydrate.add(prRepoFullName(item));
  for (const fullName of eventRepoNames) fullNamesToHydrate.add(fullName);
  for (const repo of await hydrateRepos(fullNamesToHydrate)) repos.set(repoKey(repo.full_name), repo);
  const allowedRepoKeys = new Set(repos.keys());

  const organizations = Array.from(new Set([...CONFIGURED_ORGS, ...publicOrgs, ...authenticatedOrgs])).sort((a, b) =>
    a.localeCompare(b)
  );

  return {
    user,
    repos: Array.from(repos.values()),
    organizations,
    prItems,
    commitItems,
    sourceCounts: {
      ownedRepos: ownedRepos.length,
      authenticatedRepos: authenticatedRepos.length,
      prRepos: new Set(prItems.map(prRepoFullName).map(repoKey).filter((key) => allowedRepoKeys.has(key))).size,
      commitRepos: new Set(commitItems.map((item) => item.repository.full_name).map(repoKey).filter((key) => allowedRepoKeys.has(key))).size,
      eventRepos: new Set(eventRepoNames.map(repoKey)).size,
    },
  };
}

// PRs recientes (todos los repos públicos accesibles, incluidas organizaciones)
function getRecentPRs(login: string, prItems: SearchIssuesResult["items"], allowedRepoKeys: Set<string>, n = 5) {
  const profileFull = profileRepoFullName(login);

  return prItems
    .map((it) => {
      const repoFull = prRepoFullName(it);
      return {
        title: it.title,
        url: it.html_url,
        repo: repoFull,
        state: it.state,
        updated: it.updated_at,
        number: it.number,
      };
    })
    .filter((p) => p.repo.toLowerCase() !== profileFull)
    .filter((p) => allowedRepoKeys.has(repoKey(p.repo)))
    .slice(0, n);
}

// Commits recientes (busqueda global por autor) — excluye repo de perfil
function getRecentCommits(login: string, commitItems: SearchCommitsResult["items"], allowedRepoKeys: Set<string>, n = 5) {
  const profileFull = profileRepoFullName(login);

  return commitItems
    .filter((item) => item.repository.full_name.toLowerCase() !== profileFull)
    .filter((item) => allowedRepoKeys.has(repoKey(item.repository.full_name)))
    .slice(0, n)
    .map((item) => ({
      repo: item.repository.full_name,
      sha: item.sha,
      message: item.commit.message || "(sin mensaje)",
      created: item.commit.author?.date ?? item.commit.committer?.date ?? new Date().toISOString(),
      url: item.html_url,
    }));
}

// -------- Plantillas --------
// Lista de iconos (24). Se renderiza en grid 6×4.
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

// Tabla “En curso”
function latestReposTable(repos: GitHubRepo[], login: string): string {
  const profileFull = profileRepoFullName(login);
  const latest = repos
    .filter((r) => !r.archived)
    .filter((r) => r.full_name.toLowerCase() !== profileFull)
    .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
    .slice(0, 5);

  const rows = latest.map((r) => {
    const repo = mdLink(r.full_name, r.html_url);
    if (r.private) {
      const desc = r.description ? esc(r.description) : "Repositorio privado/accesible por organización.";
      return `| ${repo}<br/><sub>${desc}</sub> | ${esc(r.language ?? "Privado")} | ${fmtDate(r.pushed_at)} | Privado | Privado |`;
    }

    const encodedFullName = r.full_name.split("/").map(encodeURIComponent).join("/");
    const langBadge = `![lang](https://img.shields.io/github/languages/top/${encodedFullName}?style=flat-square)`;
    const lastCommit = `![last](https://img.shields.io/github/last-commit/${encodedFullName}?style=flat-square&label=%C3%BAltimo%20commit)`;
    const activity = `![act](https://img.shields.io/github/commit-activity/m/${encodedFullName}?style=flat-square&label=commits%2Fmes)`;
    const size = `![size](https://img.shields.io/github/repo-size/${encodedFullName}?style=flat-square&label=size)`;
    const desc = r.description ? esc(r.description) : "";
    return `| ${repo}${desc ? `<br/><sub>${desc}</sub>` : ""} | ${langBadge} | ${lastCommit} | ${activity} | ${size} |`;
  });

  return [
    "| Repo | Lenguaje | Último commit | Commits/mes | Tamaño |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function prsRecientesList(prs: Awaited<ReturnType<typeof getRecentPRs>>): string {
  if (!prs.length) return "_Sin PRs públicos recientes._";
  return prs
    .map(
      (p) =>
        `- ${mdLink(`#${p.number} ${esc(p.title)}`, p.url)} — \`${p.repo}\` — ${p.state.toUpperCase()} — ${fmtDate(
          p.updated
        )}`
    )
    .join("\n");
}

function commitsRecientesList(commits: Awaited<ReturnType<typeof getRecentCommits>>): string {
  if (!commits.length) return "_Sin commits públicos recientes._";
  return commits
    .map(
      (c) =>
        `- ${mdLink(truncate(esc(c.message).toString(), 80), c.url)} — \`${c.repo}\` — ${fmtDate(c.created)}`
    )
    .join("\n");
}

function buildReadme(params: {
  user: GitHubUser;
  repos: GitHubRepo[];
  langSorted: { lang: string; bytes: number; pct: number }[];
  totalBytes: number;
  analyzedRepos: number;
  organizations: string[];
  sourceCounts: {
    ownedRepos: number;
    authenticatedRepos: number;
    prRepos: number;
    commitRepos: number;
    eventRepos: number;
  };
  prs: Awaited<ReturnType<typeof getRecentPRs>>;
  commits: Awaited<ReturnType<typeof getRecentCommits>>;
}) {
  const { user, repos, langSorted, analyzedRepos, organizations, sourceCounts, prs, commits } = params;
  const { name, bio, html_url, login } = user;
  const displayName = name || login;

  const typing = `
<p align="left">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=24&duration=2300&pause=600&center=false&vCenter=true&repeat=true&width=720&lines=Systems+%26+Low-level+(C%2FC%2B%2B);Inteligencia+Artificial;Optimizaci%C3%B3n+y+Rendimiento;Aprendizaje+continuo" alt="typing" />
</p>
`.trim();

  // ---- Stats nativas. La tabla de lenguajes ampliada se genera debajo con API propia. ----
  const cardWidth = 720;
  const cards = `
<p align="left">
  <img src="https://github-readme-stats.vercel.app/api?username=${login}&show_icons=true&include_all_commits=true&hide_title=true&theme=tokyonight&hide=stars,issues,contribs&card_width=${cardWidth}" height="190" alt="GitHub stats"/>
</p>
`.trim();

  // 🐍 Snake
  const snake = `
### 🐍 Snake
<p align="left">
  <img src="https://raw.githubusercontent.com/${login}/${login}/main/assets/snake.svg" alt="snake"/>
</p>
`.trim();

  // Lenguajes: oculta 0.0% (pct < 0.05)
  const langRows = langSorted
    .filter((x) => x.pct >= 0.05)
    .map(({ lang, bytes, pct }) => `| ${esc(lang)} | ${fmtPct(pct)} | ${bytes.toLocaleString()} |`)
    .join("\n");

  const orgSummary = organizations.length ? organizations.map((org) => `\`${org}\``).join(", ") : "_sin organizaciones públicas detectadas_";
  const langTable = langRows
    ? `
> Agregado de **bytes por lenguaje** en ${analyzedRepos} repos propios, contribuidos y/o accesibles por organización.
> Fuentes detectadas: ${sourceCounts.ownedRepos} repos propios, ${sourceCounts.authenticatedRepos} repos accesibles por token, ${sourceCounts.prRepos} repos con PRs, ${sourceCounts.commitRepos} repos con commits y ${sourceCounts.eventRepos} repos por eventos públicos.
> Organizaciones detectadas/configuradas: ${orgSummary}.

| Lenguaje | % | Bytes |
|---|---:|---:|
${langRows}
`.trim()
    : "_Se llenará automáticamente con la actividad de repos propios, contribuidos y de organizaciones accesibles._";

  const latestTable = latestReposTable(repos, login);
  const updated = new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" });

  const md = `
<!-- Profile: ${login} — dark, clean, compact -->
<h1 align="left">${displayName}</h1>
<p align="left">
${bio ? esc(bio) : "Ingeniero de Software · Low-level (C/C++), Inteligencia Artificial, Ciberseguridad. Rendimiento."}
</p>
${typing}

---

### ⚙️ Skills
${renderSkillsGrid(ICONS, 6, 42)}

---

### 📈 GitHub Stats
${cards}

${snake}

---

### 🛠️ En curso (últimos 5 repos)
${latestTable}

---

### 🔀 PRs recientes
${prsRecientesList(prs)}

---

### 📝 Commits recientes
${commitsRecientesList(commits)}

---

### 🧠 Lenguajes más usados
${langTable}

---

### 📬 Contacto
- Email: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
- GitHub: ${mdLink(login, html_url)}

<sub>Actualizado automáticamente el ${updated} (Europe/Madrid).</sub>
`.trim();

  return md;
}

// -------- Main --------
async function main() {
  if (INCLUDE_PRIVATE_REPOS && !HAS_PERSONAL_TOKEN) {
    console.warn(
      "INCLUDE_PRIVATE_REPOS=true requiere PROFILE_GITHUB_TOKEN o GH_TOKEN. Se omite la regeneracion para no perder la actividad privada ya publicada."
    );
    return;
  }

  console.log(`Generando README para ${USERNAME}…`);
  const activity = await discoverActivityUniverse(USERNAME);
  const { user, organizations, prItems, commitItems, sourceCounts } = activity;
  const repos = activity.repos
    .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
    .slice(0, MAX_LANGUAGE_REPOS);
  const allowedRepoKeys = new Set(repos.map((repo) => repoKey(repo.full_name)));

  console.log(
    `Repos detectados: ${activity.repos.length}. Analizando lenguajes en ${repos.length}. Organizaciones: ${
      organizations.length ? organizations.join(", ") : "ninguna publica/configurada"
    }.`
  );

  // Agregado de lenguajes
  const langTotals: LanguagesMap = {};
  let analyzed = 0;
  for (const r of repos) {
    try {
      const langs = await getRepoLanguages(r.languages_url);
      for (const [lang, bytes] of Object.entries(langs)) {
        if (EXCLUDED_LANGUAGES.has(lang.toLowerCase())) continue;
        langTotals[lang] = (langTotals[lang] ?? 0) + Number(bytes);
      }
      analyzed++;
      await sleep(60);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Lenguajes no leídos en ${r.full_name}: ${msg}`);
    }
  }

  const totalBytes = Object.values(langTotals).reduce((a, b) => a + b, 0);
  const langSorted = Object.entries(langTotals)
    .map(([lang, bytes]) => ({
      lang,
      bytes,
      pct: totalBytes ? (bytes * 100) / totalBytes : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  // PRs y commits recientes
  const prs = getRecentPRs(USERNAME, prItems, allowedRepoKeys, 5);
  const commits = getRecentCommits(USERNAME, commitItems, allowedRepoKeys, 5);

  const next = buildReadme({
    user,
    repos,
    langSorted,
    totalBytes,
    analyzedRepos: analyzed,
    organizations,
    sourceCounts,
    prs,
    commits,
  });

  const path = "README.md";
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (prev.trim() !== next.trim()) {
    writeFileSync(path, next, "utf8");
    console.log("README.md actualizado.");
  } else {
    console.log("README.md sin cambios.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
