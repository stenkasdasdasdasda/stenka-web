// Runs in the public Pages repository. Fetches only anonymous public sitemap URLs.
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const root = process.env.STENKA_WEB_BUILD_ROOT || '.';
const out = path.join(root, 'site');
const source = process.env.STENKA_WEB_SOURCE || 'https://cf-stenka.furry.by';
if (!['https://cf-stenka.furry.by', 'https://dns.furry.by'].includes(source))
  throw Error('Unexpected source');
const template = await readFile(path.join(root, 'site-template.html'), 'utf8');
const get = async (pathname) => {
  const response = await fetch(source + pathname, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw Error('Public sitemap unavailable: ' + response.status);
  return response.text();
};
const locations = (xml) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const url = new URL(match[1].replaceAll('&amp;', '&'));
    if (
      url.origin !== 'https://stenka.furry.by' ||
      url.search ||
      url.hash ||
      url.pathname.includes('..')
    )
      throw Error('Invalid sitemap location');
    return url.pathname;
  });
const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const catalog = JSON.parse(await get('/site-metadata?batch=1'));
if (!Array.isArray(catalog.pages) || catalog.pages.length > 500)
  throw Error('Invalid public metadata catalog');
const metadataByPath = new Map();
for (const page of catalog.pages) {
  if (
    !/^\/(?:$|about$|rules$|privacy$|wall\d{1,16}$|u\/[a-zA-Z0-9_]{3,30}$)/.test(page.path) ||
    page.canonical !== 'https://stenka.furry.by' + page.path ||
    !['article', 'website'].includes(page.type) ||
    typeof page.title !== 'string' ||
    page.title.length > 4096 ||
    typeof page.description !== 'string' ||
    page.description.length > 4096 ||
    typeof page.image !== 'string' ||
    (page.image &&
      !/^https:\/\/cf-stenka\.furry\.by\/media\/[a-zA-Z0-9-]+\/(?:main|thumb)$/.test(page.image)) ||
    metadataByPath.has(page.path)
  )
    throw Error('Invalid public metadata');
  // Generate only the whitelist. Never retain raw source HTML or arbitrary attributes.
  metadataByPath.set(page.path, {
    title: '<title>' + escape(page.title) + '</title>',
    tags: `<meta name="description" content="${escape(page.description)}"><meta property="og:type" content="${page.type}"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}"><meta property="og:url" content="${escape(page.canonical)}">${page.image ? `<meta property="og:image" content="${escape(page.image)}">` : ''}<meta name="twitter:card" content="summary_large_image">`,
  });
}
await mkdir(out, { recursive: true });
for (const name of await readdir(root))
  if (
    /^(?:launch-[a-f0-9]{16}\.js|favicon\.(?:svg|png|ico)|apple-touch-icon\.png|CNAME|\.nojekyll)$/.test(
      name,
    )
  )
    await copyFile(path.join(root, name), path.join(out, name));
const index = await get('/sitemap.xml');
await writeFile(path.join(out, 'sitemap.xml'), index, 'utf8');
const pages = new Set(['/', '/about', '/rules', '/privacy']);
for (const pathname of locations(index)) {
  if (!/^\/sitemaps\/(?:pages|posts-\d+)\.xml$/.test(pathname))
    throw Error('Unexpected child sitemap');
  const xml = await get(pathname);
  await mkdir(path.dirname(path.join(out, pathname)), { recursive: true });
  await writeFile(path.join(out, pathname), xml, 'utf8');
  for (const location of locations(xml)) pages.add(location);
}
if (pages.size > 500) throw Error('Public metadata refresh exceeds the free-tier request ceiling');
for (const pathname of pages) {
  if (
    !/^\/(?:$|about$|rules$|privacy$|search$|wall\d+$|u\/[a-zA-Z0-9_.-]+$|p\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$|t\/[a-zA-Z0-9_.-]+$)/.test(
      pathname,
    )
  )
    throw Error('Unexpected public page');
  const metadata = metadataByPath.get(pathname);
  if (!metadata) continue; // A deletion/ban during the refresh never gets a generated page.
  const directory = path.join(out, pathname);
  await mkdir(directory, { recursive: true });
  let page = template.replace(
    'href="https://stenka.furry.by/"',
    'href="https://stenka.furry.by' + pathname + '"',
  );
  // Only public metadata is retained; source documents, CSRF and post bodies are never written.
  if (metadata.title) page = page.replace(/<title>[^<]*<\/title>/, () => metadata.title);
  page = page
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('</head>', () => metadata.tags + '</head>');
  await writeFile(path.join(directory, 'index.html'), page, 'utf8');
}
await writeFile(
  path.join(out, '404.html'),
  template.replace(
    '<meta name="description"',
    '<meta name="robots" content="noindex"><meta name="description"',
  ),
  'utf8',
);
await writeFile(
  path.join(out, 'robots.txt'),
  'User-agent: *\nAllow: /\nSitemap: https://stenka.furry.by/sitemap.xml\n',
  'utf8',
);
console.log(
  'Public entry routes and sitemap refreshed: ' +
    pages.size +
    ' pages. No sessions or post bodies exported.',
);
