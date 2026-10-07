// Runs in the public Pages repository. Fetches only anonymous public sitemap URLs.
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.env.STENKA_WEB_BUILD_ROOT || '.';
const out = path.join(root, 'site');
const source = process.env.STENKA_WEB_SOURCE || 'https://cf-stenka.furry.by';
if (!['https://cf-stenka.furry.by', 'https://dns.furry.by'].includes(source)) throw Error('Unexpected source');
const template = await readFile(path.join(root, 'site-template.html'), 'utf8');
const get = async (pathname) => {
  const response = await fetch(source + pathname, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw Error('Public sitemap unavailable: ' + response.status);
  return response.text();
};
const locations = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
  const url = new URL(match[1].replaceAll('&amp;', '&'));
  if (url.origin !== 'https://stenka.furry.by' || url.search || url.hash || url.pathname.includes('..')) throw Error('Invalid sitemap location');
  return url.pathname;
});
const publicHead = (html) => {
  const head = html.slice(0, html.indexOf('</head>'));
  const title = head.match(/<title>[^<]*<\/title>/)?.[0];
  const tags = [...head.matchAll(/<meta\b[^>]*>/g)].map(match => match[0]).filter(tag =>
    /(?:name="description"|property="og:(?:title|description|image|type|url)"|name="twitter:(?:card|title|description|image)")/.test(tag) &&
    !/\bon[a-z]+\s*=/i.test(tag));
  return { title, tags: tags.join('') };
};
await mkdir(out, { recursive: true });
for (const name of await readdir(root))
  if (/^(?:launch-[a-f0-9]{16}\.js|favicon\.(?:svg|png|ico)|apple-touch-icon\.png|CNAME|\.nojekyll)$/.test(name))
    await copyFile(path.join(root, name), path.join(out, name));
const index = await get('/sitemap.xml');
await writeFile(path.join(out, 'sitemap.xml'), index, 'utf8');
const pages = new Set(['/']);
for (const pathname of locations(index)) {
  if (!/^\/sitemaps\/(?:pages|posts-\d+)\.xml$/.test(pathname)) throw Error('Unexpected child sitemap');
  const xml = await get(pathname);
  await mkdir(path.dirname(path.join(out, pathname)), { recursive: true });
  await writeFile(path.join(out, pathname), xml, 'utf8');
  for (const location of locations(xml)) pages.add(location);
}
for (const pathname of pages) {
  if (!/^\/(?:$|about$|rules$|privacy$|search$|wall\d+$|u\/[a-zA-Z0-9_.-]+$|p\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$|t\/[a-zA-Z0-9_.-]+$)/.test(pathname)) throw Error('Unexpected public page');
  const directory = path.join(out, pathname);
  await mkdir(directory, { recursive: true });
  let page = template.replace('href="https://stenka.furry.by/"', 'href="https://stenka.furry.by' + pathname + '"');
  // Only public metadata is retained; source documents, CSRF and post bodies are never written.
  if (pages.size > 500) throw Error('Public metadata refresh exceeds the free-tier request ceiling');
  const metadata = publicHead(await get(pathname));
  if (metadata.title) page = page.replace(/<title>[^<]*<\/title>/, metadata.title);
  page = page.replace(/<meta name="description"[^>]*>/, '').replace('</head>', metadata.tags + '</head>');
  await writeFile(path.join(directory, 'index.html'), page, 'utf8');
}
await writeFile(path.join(out, '404.html'), template.replace('<meta name="description"', '<meta name="robots" content="noindex"><meta name="description"'), 'utf8');
await writeFile(path.join(out, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: https://stenka.furry.by/sitemap.xml\n', 'utf8');
console.log('Public entry routes and sitemap refreshed: ' + pages.size + ' pages. No sessions or post bodies exported.');
