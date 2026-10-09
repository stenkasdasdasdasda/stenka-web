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
const pagePath = (pathname) => pathname.replace(/\/+$/, '') || '/';
const publicUrl = (pathname) =>
  'https://stenka.furry.by' + (pathname === '/' ? '/' : pagePath(pathname) + '/');
const catalog = JSON.parse(await get('/site-metadata?batch=1'));
if (!Array.isArray(catalog.pages) || catalog.pages.length > 500)
  throw Error('Invalid public metadata catalog');
const metadataByPath = new Map();
for (const page of catalog.pages) {
  if (
    !/^\/(?:$|about$|rules$|privacy$|wall\d{1,16}$|u\/[a-zA-Z0-9_]{3,30}$)/.test(page.path) ||
    !['https://stenka.furry.by' + page.path, publicUrl(page.path)].includes(page.canonical) ||
    !['article', 'website'].includes(page.type) ||
    typeof page.title !== 'string' ||
    page.title.length > 4096 ||
    typeof page.description !== 'string' ||
    page.description.length > 4096 ||
    typeof page.image !== 'string' ||
    typeof page.text !== 'string' ||
    page.text.length > 4096 ||
    (page.links !== undefined && (!Array.isArray(page.links) || page.links.length > 50)) ||
    (page.image &&
      !/^https:\/\/cf-stenka\.furry\.by\/media\/[a-zA-Z0-9-]+\/(?:main|thumb)$/.test(page.image)) ||
    metadataByPath.has(page.path)
  )
    throw Error('Invalid public metadata');
  // Generate only the whitelist. Never retain raw source HTML or arbitrary attributes.
  metadataByPath.set(page.path, {
    title: '<title>' + escape(page.title) + '</title>',
    tags: `<meta name="description" content="${escape(page.description)}"><meta property="og:type" content="${page.type}"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}"><meta property="og:url" content="${escape(publicUrl(page.path))}">${page.image ? `<meta property="og:image" content="${escape(page.image)}">` : ''}<meta name="twitter:card" content="summary_large_image">`,
    content: `<section id="public-content" aria-label="Содержание страницы"><h1>${escape(page.title)}</h1><p>${escape(page.text || page.description)}</p>${(
      page.links || []
    )
      .map((link) => {
        if (
          !/^\/wall\d{1,16}$/.test(link.path) ||
          typeof link.title !== 'string' ||
          link.title.length > 4096 ||
          typeof link.description !== 'string' ||
          link.description.length > 4096
        )
          throw Error('Invalid public link');
        return `<article><h2><a href="${escape(link.path + '/')}">${escape(link.title)}</a></h2><p>${escape(link.description)}</p></article>`;
      })
      .join(
        '',
      )}<!--noindex--><div data-nosnippet><nav aria-label="О сайте"><a href="/">Главная</a> · <a href="/about/">О проекте</a> · <a href="/rules/">Правила</a> · <a href="/privacy/">Приватность</a></nav></div><!--/noindex--></section>`,
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
  const xml = (await get(pathname)).replace(/<loc>([^<]+)<\/loc>/g, (_match, value) => {
    const [location] = locations('<loc>' + value + '</loc>');
    return '<loc>' + publicUrl(location) + '</loc>';
  });
  await mkdir(path.dirname(path.join(out, pathname)), { recursive: true });
  await writeFile(path.join(out, pathname), xml, 'utf8');
  for (const location of locations(xml)) pages.add(pagePath(location));
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
    'href="' + publicUrl(pathname) + '"',
  );
  // Escape approved plain text; never export source documents, CSRF or private content.
  if (metadata.title) page = page.replace(/<title>[^<]*<\/title>/, () => metadata.title);
  page = page
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('</head>', () => metadata.tags + '</head>');
  // Public content must be outside the loading UI's noindex / data-nosnippet boundary.
  page = page.replace('</body>', () => metadata.content + '</body>');
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
// These application routes are intentionally absent from the public sitemap,
// but a direct visit or reload must still receive a real 200 launcher page.
for (const pathname of [
  '/search',
  '/login',
  '/settings',
  '/my',
  '/saved',
  '/notifications',
  '/new',
  '/admin',
  '/app',
]) {
  const directory = path.join(out, pathname);
  await mkdir(directory, { recursive: true });
  const page = template
    .replace('href="https://stenka.furry.by/"', 'href="https://stenka.furry.by' + pathname + '"')
    .replace('</head>', '<meta name="robots" content="noindex"></head>');
  await writeFile(path.join(directory, 'index.html'), page, 'utf8');
}
// Build the HTTP map from the same approved pages without changing HTTPS canonicals.
const httpPages = [...pages].filter((pathname) => metadataByPath.has(pathname));
await writeFile(
  path.join(out, 'sitemap-http.xml'),
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    httpPages
      .map(
        (pathname) =>
          '<url><loc>' + publicUrl(pathname).replace('https:', 'http:') + '</loc></url>',
      )
      .join('') +
    '</urlset>\n',
  'utf8',
);
await writeFile(
  path.join(out, 'robots.txt'),
  'User-agent: *\nAllow: /\nSitemap: https://stenka.furry.by/sitemap.xml\nSitemap: http://stenka.furry.by/sitemap-http.xml\n',
  'utf8',
);
console.log(
  'Public entry routes, approved content and sitemap refreshed: ' +
    pages.size +
    ' pages. No sessions or private content exported.',
);
