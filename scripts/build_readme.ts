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
  fork: boolean;
  description: string | null;
  html_url: string;
  languages_url: string;
  pushed_at: string; // ISO
  archived: boolean;
  language: string | null;
}

type LanguagesMap = Record<string, number>;

interface SearchIssuesResult {
  items: Array<{
    html_url: string;
    title: string;
    state: "open" | "closed";
    number: number;
    repository_url: string;
    updated_at: string;
  }>;
}

// -------- Config --------
const USERNAME = process.env.USERNAME ?? "GonxKZ";
const TOKEN = process.env.GITHUB_TOKEN;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL ?? "gonzalo_kzz@hotmail.com";

if (!TOKEN) {
  console.error("Falta GITHUB_TOKEN en el entorno.");
  process.exit(1);
}

const HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

// -------- Utils --------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mdLink = (text: string, url: string) => `[${text}](${url})`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const esc = (s: unknown) => (s ?? "").toString().replace(/\|/g, "\\|");
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-ES", { year: "numeric", month: "short", day: "2-digit" });
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "… " : s);

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

async function getAllRepos(login: string) {
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
  return all.filter((r) => !r.fork);
}

async function getRepoLanguages(languages_url: string) {
  return gh<LanguagesMap>(languages_url);
}

// PRs recientes (excluye repo de perfil)
async function getRecentPRs(login: string, n = 5) {
  const url = `https://api.github.com/search/issues?q=is:pr+author:${login}+is:public&sort=created&order=desc&per_page=${n +
    10}`;
  const res = await gh<SearchIssuesResult>(url);
  const profileFull = `${login}/${login}`.toLowerCase();

  return res.items
    .map((it) => {
      const repoFull = it.repository_url.split("/").slice(-2).join("/");
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
    .slice(0, n);
}

// Commits recientes (PushEvent) — excluye repo de perfil
async function getRecentCommits(login: string, n = 5) {
  type EventsResp = Array<{
    type: string;
    repo: { name: string };
    created_at: string;
    payload?: { commits?: Array<{ sha: string; message: string; url?: string }> };
  }>;
  const events = await gh<EventsResp>(`https://api.github.com/users/${login}/events/public`);
  const profileFull = `${login}/${login}`.toLowerCase();

  const commits: { repo: string; sha: string; message: string; created: string; url: string }[] = [];

  for (const ev of events) {
    const repoFull = ev.repo.name;
    if (ev.type !== "PushEvent" || !ev.payload?.commits?.length) continue;
    if (repoFull.toLowerCase() === profileFull) continue;

    for (const c of ev.payload.commits) {
      const sha = c.sha;
      const url = `https://github.com/${repoFull}/commit/${sha}`;
      commits.push({
        repo: repoFull,
        sha,
        message: c.message || "(sin mensaje)",
        created: ev.created_at,
        url,
      });
      if (commits.length >= n) break;
    }
    if (commits.length >= n) break;
  }
  return commits;
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
  const profileRepoName = login.toLowerCase();
  const latest = repos
    .filter((r) => !r.archived)
    .filter((r) => r.name.toLowerCase() !== profileRepoName)
    .sort((a, b) => new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime())
    .slice(0, 5);

  const rows = latest.map((r) => {
    const repo = mdLink(r.name, r.html_url);
    const langBadge = `![lang](https://img.shields.io/github/languages/top/${login}/${r.name}?style=flat-square)`;
    const lastCommit = `![last](https://img.shields.io/github/last-commit/${login}/${r.name}?style=flat-square&label=%C3%BAltimo%20commit)`;
    const activity = `![act](https://img.shields.io/github/commit-activity/m/${login}/${r.name}?style=flat-square&label=commits%2Fmes)`;
    const size = `![size](https://img.shields.io/github/repo-size/${login}/${r.name}?style=flat-square&label=size)`;
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
  prs: Awaited<ReturnType<typeof getRecentPRs>>;
  commits: Awaited<ReturnType<typeof getRecentCommits>>;
}) {
  const { user, repos, langSorted, prs, commits } = params;
  const { name, bio, html_url, login } = user;
  const displayName = name || login;

  const typing = `
<p align="left">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=24&duration=2300&pause=600&center=false&vCenter=true&repeat=true&width=720&lines=Systems+%26+Low-level+(C%2FC%2B%2B);Inteligencia+Artificial;Optimizaci%C3%B3n+y+Rendimiento;Aprendizaje+continuo" alt="typing" />
</p>
`.trim();

  // ---- Stats en columna: primero LANGS, luego STATS ----
  const cardWidth = 720;
  const cards = `
<p align="left">
  <img src="https://github-readme-stats.vercel.app/api/top-langs/?username=${login}&layout=compact&langs_count=8&theme=tokyonight&card_width=${cardWidth}" height="190" alt="Most used languages"/>
</p>
<p align="left">
  <img src="https://github-readme-stats.vercel.app/api?username=${login}&show_icons=true&include_all_commits=true&hide_title=true&theme=tokyonight&hide=stars,issues,contribs&card_width=${cardWidth}" height="190" alt="Stats (commits + PRs)"/>
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

  const langTable = langRows
    ? `
> Agregado de **bytes por lenguaje** en tus repos (GitHub no cuenta líneas).

| Lenguaje | % | Bytes |
|---|---:|---:|
${langRows}
`.trim()
    : "_Se llenará automáticamente con la actividad de repos._";

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

### 📈 GitHub Stats (commits + PRs)
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
  console.log(`Generando README para ${USERNAME}…`);
  const user = await getUser(USERNAME);
  const repos = await getAllRepos(USERNAME);

  // Agregado de lenguajes
  const langTotals: LanguagesMap = {};
  let analyzed = 0;
  for (const r of repos) {
    try {
      const langs = await getRepoLanguages(r.languages_url);
      for (const [lang, bytes] of Object.entries(langs)) {
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
  const [prs, commits] = await Promise.all([getRecentPRs(USERNAME, 5), getRecentCommits(USERNAME, 5)]);

  const next = buildReadme({
    user,
    repos,
    langSorted,
    totalBytes,
    analyzedRepos: analyzed,
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
