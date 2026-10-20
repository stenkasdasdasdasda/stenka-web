// Runs in the public Pages repository. Fetches only anonymous public sitemap URLs.
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
const mediaUrl = /^https:\/\/cf-stenka\.furry\.by\/media\/[a-zA-Z0-9-]{1,80}\/(?:main|thumb)$/;
const duration = (milliseconds) => 'PT' + milliseconds / 1000 + 'S';
// Hidden video posters otherwise download before the normal app iframe is ready.
const activateMedia =
  "document.addEventListener('DOMContentLoaded',()=>{if(document.documentElement.getAttribute('data-entry')==='public'){const media=document.getElementById('public-media');if(media)media.replaceWith(media.content.cloneNode(true))}},{once:true});";
const jsonForHtml = (value) =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
const mediaName = (page, media) => media.alt || page.title.replace(/ — Фурри Стенка$/, '');
function validateMedia(page) {
  const media = page.media || [];
  if (!Array.isArray(media) || media.length > 32 || (page.noindex && media.length))
    throw Error('Invalid public media');
  for (const item of media) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) ||
      !['image', 'video'].includes(item.kind) ||
      item.url !== 'https://cf-stenka.furry.by/media/' + item.id + '/main' ||
      item.thumbnail !== 'https://cf-stenka.furry.by/media/' + item.id + '/thumb' ||
      !mediaUrl.test(item.url) ||
      typeof item.alt !== 'string' ||
      item.alt.length > 500 ||
      !Number.isInteger(item.width) ||
      item.width <= 0 ||
      item.width > 32768 ||
      !Number.isInteger(item.height) ||
      item.height <= 0 ||
      item.height > 32768 ||
      !Number.isFinite(item.duration_ms) ||
      item.duration_ms < 0 ||
      item.duration_ms > 86400000 ||
      typeof item.uploadedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.uploadedAt))
    )
      throw Error('Invalid public media');
  }
  return media;
}
function renderMedia(page, media) {
  const canonical = publicUrl(page.path);
  const markup = [
    ...media.filter((item) => item.kind === 'video'),
    ...media.filter((item) => item.kind === 'image'),
  ]
    .map((item) => {
      const name = escape(mediaName(page, item));
      const caption = item.alt ? '<figcaption>' + escape(item.alt) + '</figcaption>' : '';
      if (item.kind === 'image')
        return `<figure id="media-${item.id}" itemscope itemtype="https://schema.org/ImageObject"><a href="${escape(item.url)}"><img itemprop="contentUrl" src="${escape(item.url)}" alt="${name}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a>${caption}</figure>`;
      return `<figure id="media-${item.id}" itemscope itemtype="https://schema.org/VideoObject"><meta itemprop="name" content="${name}"><meta itemprop="description" content="${escape(page.description)}"><link itemprop="url" href="${escape(canonical)}"><meta itemprop="uploadDate" content="${escape(item.uploadedAt)}"><meta itemprop="isFamilyFriendly" content="true">${item.duration_ms > 0 ? `<meta itemprop="duration" content="${duration(item.duration_ms)}">` : ''}<meta itemprop="thumbnailUrl" content="${escape(item.thumbnail)}"><span itemprop="thumbnail" itemscope itemtype="https://schema.org/ImageObject"><meta itemprop="contentUrl" content="${escape(item.thumbnail)}"></span><video itemprop="contentUrl" src="${escape(item.url)}" poster="${escape(item.thumbnail)}" width="${item.width}" height="${item.height}" controls playsinline preload="none" aria-label="${name}"></video>${caption}</figure>`;
    })
    .join('');
  const nodes = media.map((item) => ({
    '@type': item.kind === 'video' ? 'VideoObject' : 'ImageObject',
    '@id': canonical + '#media-' + item.id,
    name: mediaName(page, item),
    description: page.description,
    url: canonical,
    contentUrl: item.url,
    width: item.width,
    height: item.height,
    ...(item.kind === 'video'
      ? {
          thumbnailUrl: [item.thumbnail],
          uploadDate: item.uploadedAt,
          encodingFormat: 'video/mp4',
          isFamilyFriendly: true,
          ...(item.duration_ms > 0 ? { duration: duration(item.duration_ms) } : {}),
        }
      : { encodingFormat: 'image/webp' }),
  }));
  const json = nodes.length
    ? jsonForHtml({ '@context': 'https://schema.org', '@graph': nodes })
    : '';
  const video = media.find((item) => item.kind === 'video');
  const tags = video
    ? `<meta property="og:video" content="${escape(video.url)}"><meta property="og:video:secure_url" content="${escape(video.url)}"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="${video.width}"><meta property="og:video:height" content="${video.height}"><meta property="ya:ovs:upload_date" content="${escape(video.uploadedAt)}"><meta property="ya:ovs:adult" content="false">${video.duration_ms > 0 ? `<meta property="video:duration" content="${Math.max(1, Math.round(video.duration_ms / 1000))}">` : ''}`
    : '';
  const sitemap = media
    .map((item) =>
      item.kind === 'image'
        ? `<image:image><image:loc>${escape(item.url)}</image:loc></image:image>`
        : `<video:video><video:thumbnail_loc>${escape(item.thumbnail)}</video:thumbnail_loc><video:title>${escape(mediaName(page, item).slice(0, 100))}</video:title><video:description>${escape(page.description.slice(0, 2048))}</video:description><video:content_loc>${escape(item.url)}</video:content_loc><video:publication_date>${escape(item.uploadedAt)}</video:publication_date>${item.duration_ms >= 1000 && item.duration_ms <= 28800000 ? `<video:duration>${Math.round(item.duration_ms / 1000)}</video:duration>` : ''}</video:video>`,
    )
    .join('');
  return { markup, json, tags, sitemap, video };
}
const catalog = JSON.parse(await get('/site-metadata?batch=1'));
if (!Array.isArray(catalog.pages) || catalog.pages.length > 500)
  throw Error('Invalid public metadata catalog');
const metadataByPath = new Map();
for (const page of catalog.pages) {
  if (
    !/^\/(?:$|about$|rules$|privacy$|wall\d{1,16}$|(?:u|photo)\/[a-zA-Z0-9_]{3,30}$)/.test(
      page.path,
    ) ||
    !['https://stenka.furry.by' + page.path, publicUrl(page.path)].includes(page.canonical) ||
    !['article', 'website'].includes(page.type) ||
    typeof page.title !== 'string' ||
    page.title.length > 4096 ||
    typeof page.description !== 'string' ||
    page.description.length > 4096 ||
    typeof page.image !== 'string' ||
    typeof page.text !== 'string' ||
    (page.noindex !== undefined && typeof page.noindex !== 'boolean') ||
    page.text.length > 4096 ||
    (page.links !== undefined && (!Array.isArray(page.links) || page.links.length > 50)) ||
    (page.image &&
      !/^https:\/\/cf-stenka\.furry\.by\/media\/[a-zA-Z0-9-]+\/(?:main|thumb)$/.test(page.image)) ||
    metadataByPath.has(page.path)
  )
    throw Error('Invalid public metadata');
  const media = renderMedia(page, validateMedia(page));
  const image = media.video?.thumbnail || page.image || page.media?.[0]?.url;
  // Generate only the whitelist. Never retain raw source HTML or arbitrary attributes.
  metadataByPath.set(page.path, {
    title: '<title>' + escape(page.title) + '</title>',
    tags: `${page.noindex ? '<meta name="robots" content="noindex,follow">' : ''}<meta name="description" content="${escape(page.description)}"><meta name="robots" content="max-image-preview:large,max-video-preview:-1"><meta property="og:type" content="${media.video ? 'video.other' : page.type}"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}"><meta property="og:url" content="${escape(publicUrl(page.path))}">${image ? `<meta property="og:image" content="${escape(image)}">` : ''}<meta name="twitter:card" content="summary_large_image">${media.tags}${media.json ? `<script type="application/ld+json">${media.json}</script>` : ''}`,
    media,
    content: `<section id="public-content" aria-label="Содержание страницы"><h1>${escape(page.title)}</h1>${media.markup ? `<template id="public-media">${media.markup}</template><noscript>${media.markup}</noscript>` : ''}<p>${escape(page.text || page.description)}</p>${(
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
    /^(?:launch-[a-f0-9]{16}\.js|favicon(?:-dfl|-pxl)\.svg|favicon(?:-pxl)?\.(?:svg|png|ico)|apple-touch-icon(?:-pxl)?\.png|CNAME|\.nojekyll)$/.test(
      name,
    )
  )
    await copyFile(path.join(root, name), path.join(out, name));
const index = await get('/sitemap.xml');
await writeFile(path.join(out, 'sitemap.xml'), index, 'utf8');
const pages = new Set(['/', '/about', '/rules', '/privacy']);
for (const entry of catalog.pages) if (entry.path.startsWith('/photo/')) pages.add(entry.path);
for (const pathname of locations(index)) {
  if (!/^\/sitemaps\/(?:pages|posts-\d+)\.xml$/.test(pathname))
    throw Error('Unexpected child sitemap');
  let xml = (await get(pathname)).replace(/<loc>([^<]+)<\/loc>/g, (_match, value) => {
    const [location] = locations('<loc>' + value + '</loc>');
    return '<loc>' + publicUrl(location) + '</loc>';
  });
  xml = xml.replace(/<url>([\s\S]*?)<\/url>/g, (entry, body) => {
    const location = body.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!location) return entry;
    const media = metadataByPath.get(
      pagePath(new URL(location.replaceAll('&amp;', '&')).pathname),
    )?.media;
    return '<url>' + body + (media?.sitemap || '') + '</url>';
  });
  if (xml.includes('<image:image>') || xml.includes('<video:video>'))
    xml = xml.replace(
      '<urlset',
      '<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"',
    );
  await mkdir(path.dirname(path.join(out, pathname)), { recursive: true });
  await writeFile(path.join(out, pathname), xml, 'utf8');
  for (const location of locations(xml)) pages.add(pagePath(location));
}
if (pages.size > 500) throw Error('Public metadata refresh exceeds the free-tier request ceiling');
for (const pathname of pages) {
  if (
    !/^\/(?:$|about$|rules$|privacy$|search$|wall\d+$|(?:u|photo)\/[a-zA-Z0-9_.-]+$|p\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9_.-]+)?$|t\/[a-zA-Z0-9_.-]+$)/.test(
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
  if (metadata.media.json) {
    const hash = createHash('sha256').update(metadata.media.json).digest('base64');
    const activationHash = createHash('sha256').update(activateMedia).digest('base64');
    page = page.replace(
      "script-src 'self'",
      "script-src 'self' 'sha256-" + hash + "' 'sha256-" + activationHash + "'",
    );
    page = page.replace('</head>', '<script>' + activateMedia + '</script></head>');
  }
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
  '/communities',
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
