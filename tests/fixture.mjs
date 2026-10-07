const repo = {
  name: 'demo', full_name: 'GonxKZ/demo', owner: { login: 'GonxKZ' },
  fork: false, archived: false, private: false, description: 'Ejemplo',
  html_url: 'https://github.com/GonxKZ/demo',
  languages_url: 'https://api.github.com/repos/GonxKZ/demo/languages',
  pushed_at: '2026-10-08T10:00:00Z', language: 'TypeScript',
};
globalThis.fetch = async (input) => {
  const url = new URL(input);
  let body;
  if (process.env.FIXTURE_FAILURE) return new Response(JSON.stringify({ errors: [{ message: 'secret-project' }] }), { status: 200 });
  if (url.pathname === '/users/GonxKZ') body = { login: 'GonxKZ', name: 'Gonzalo', bio: '', html_url: 'https://github.com/GonxKZ' };
  else if (url.pathname.endsWith('/languages')) body = { TypeScript: 100 };
  else if (url.pathname.endsWith('/repos')) body = [repo];
  else if (url.pathname === '/graphql') body = { data: { user: { contributionsCollection: {
    startedAt: '2025-10-08T00:00:00Z', endedAt: '2026-10-08T00:00:00Z',
    totalCommitContributions: 20, totalPullRequestContributions: 4,
    totalIssueContributions: 2, totalPullRequestReviewContributions: 1,
    restrictedContributionsCount: 30, contributionCalendar: { totalContributions: 57 },
  } } } };
  else if (url.pathname.startsWith('/search/')) body = { items: [], incomplete_results: false, total_count: 0 };
  else if (url.pathname.endsWith('/orgs') || url.pathname.endsWith('/events/public')) body = [];
  else throw new Error(`Ruta inesperada: ${url.pathname}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
