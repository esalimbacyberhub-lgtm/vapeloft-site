#!/usr/bin/env node
// Static checks for the Vape Loft site. No dependencies. Run from anywhere:
//   node scripts/check-site.mjs
// Exits non-zero if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://vapeloft.co.ke';
const WA_NUMBER = '254742405841';
const NEW_PAGE = '/vape-delivery-kenya/';

let failures = 0, passes = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const ok = (m) => { passes++; if (process.env.VERBOSE) console.log('  ok    ' + m); };
const check = (cond, m) => (cond ? ok(m) : fail(m));
const section = (t) => console.log('\n' + t);

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile();

// ---- pages
const pages = ['index.html'];
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'scripts' && exists(`${d.name}/index.html`)) pages.push(`${d.name}/index.html`);
}
const urlPathOf = (file) => '/' + file.replace(/index\.html$/, '');
const html = Object.fromEntries(pages.map((p) => [p, read(p)]));

// ---- helpers
function inlineScripts(src) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) out.push({ attrs: m[1], code: m[2] });
  return out;
}
function resolveInternal(fromFile, ref) {
  // returns {file, hash} or null when external / non-file scheme
  if (/^(mailto:|tel:|javascript:|data:|#$)/i.test(ref)) return null;
  let u = ref;
  if (/^https?:\/\//i.test(u)) {
    if (!u.startsWith(ORIGIN)) return null;
    u = u.slice(ORIGIN.length) || '/';
  }
  if (u.startsWith('//')) return null;
  const hashIdx = u.indexOf('#');
  const hash = hashIdx >= 0 ? u.slice(hashIdx + 1) : '';
  let p = (hashIdx >= 0 ? u.slice(0, hashIdx) : u).split('?')[0];
  if (p === '') return { file: fromFile, hash };
  const base = p.startsWith('/') ? p : path.posix.join(path.posix.dirname('/' + fromFile), p);
  let rel = path.posix.normalize(base).replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  return { file: rel, hash };
}
const idsIn = (src) => new Set([...src.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

// ============ 1. internal links + asset paths in HTML ============
section('1. Internal links and asset paths (HTML)');
for (const [file, src] of Object.entries(html)) {
  const markup = src.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const refs = [...markup.matchAll(/\b(?:href|src|poster)=["']([^"']+)["']/g)].map((m) => m[1]);
  let n = 0;
  for (const ref of refs) {
    if (/^https?:\/\//i.test(ref) && !ref.startsWith(ORIGIN)) continue; // external
    const r = resolveInternal(file, ref);
    if (!r) continue;
    n++;
    if (!exists(r.file)) { fail(`${file}: "${ref}" -> missing file ${r.file}`); continue; }
    if (r.hash && r.file.endsWith('.html')) {
      const target = html[r.file] ?? read(r.file);
      if (!idsIn(target).has(r.hash)) fail(`${file}: "${ref}" -> #${r.hash} not found in ${r.file}`);
      else ok(`${file}: ${ref}`);
    } else ok(`${file}: ${ref}`);
  }
  console.log(`  ${file}: ${n} internal references checked`);
}

// ============ 2. asset paths used from JS (images/videos) ============
section('2. Image and video paths referenced from JS');
const indexScripts = inlineScripts(html['index.html']);
const dataBlock = indexScripts.find((s) => /id=["']vl-data["']/.test(s.attrs));
const appBlock = indexScripts.find((s) => /id=["']vl-app["']/.test(s.attrs));
check(!!dataBlock && !!appBlock, 'index.html has vl-data and vl-app script blocks');
const ctx = vm.createContext({});
let api = null;
try {
  api = vm.runInContext(dataBlock.code + '\n;({allProducts, moreDevices, waUrl, buildListMessage, buildNeedMessage, listTotal, parsePrice, fmtKsh})', ctx);
} catch (e) { fail('vl-data block failed to execute: ' + e.message); }
if (api) {
  const paths = new Set(api.allProducts.map((p) => p.img).filter(Boolean));
  for (const lit of html['index.html'].matchAll(/["'`((]((?:images|videos|logo)\/[A-Za-z0-9._\/-]+)["'`)]/g)) paths.add(lit[1]);
  let missing = 0;
  for (const p of paths) if (!exists(p)) { fail(`index.html JS: ${p} does not exist`); missing++; }
  console.log(`  ${paths.size} distinct asset paths, ${missing} missing`);
  if (!missing) ok('all JS asset paths exist');
  check(api.allProducts.length > 50, `catalog data loaded (${api.allProducts.length} products)`);
}

// ============ 3. sitemap / robots ============
section('3. sitemap.xml and robots.txt');
const sitemap = read('sitemap.xml');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check(locs.includes(ORIGIN + NEW_PAGE), `sitemap lists ${ORIGIN + NEW_PAGE}`);
for (const f of pages) check(locs.includes(ORIGIN + urlPathOf(f)), `sitemap lists ${urlPathOf(f)}`);
for (const l of locs) {
  const r = resolveInternal('index.html', l);
  check(r && exists(r.file), `sitemap URL resolves to a file: ${l}`);
}
check(new Set(locs).size === locs.length, 'sitemap has no duplicate URLs');
check(/Sitemap:\s*https:\/\/vapeloft\.co\.ke\/sitemap\.xml/.test(read('robots.txt')), 'robots.txt points to sitemap.xml');
// canonical matches sitemap
for (const [file, src] of Object.entries(html)) {
  const c = /<link rel="canonical" href="([^"]+)"/.exec(src)?.[1];
  check(c === ORIGIN + urlPathOf(file), `${file}: canonical is ${ORIGIN + urlPathOf(file)} (found ${c})`);
}
// unique titles / descriptions
const titles = Object.values(html).map((s) => /<title>([^<]*)<\/title>/.exec(s)?.[1]);
const descs = Object.values(html).map((s) => /<meta name="description" content="([^"]*)"/.exec(s)?.[1]);
check(new Set(titles).size === titles.length && titles.every(Boolean), 'page titles are unique');
check(new Set(descs).size === descs.length && descs.every(Boolean), 'meta descriptions are unique');
for (const [i, f] of pages.entries()) if (descs[i] && descs[i].length > 160) fail(`${f}: meta description is ${descs[i].length} chars (over 160)`);

// ============ 4. JS syntax + JSON-LD ============
section('4. Inline JavaScript syntax and JSON-LD');
for (const [file, src] of Object.entries(html)) {
  let i = 0;
  for (const s of inlineScripts(src)) {
    i++;
    if (/type=["']application\/ld\+json["']/.test(s.attrs)) {
      try {
        const j = JSON.parse(s.code);
        ok(`${file}: JSON-LD #${i} parses (${j['@type']})`);
        if (j['@type'] === 'FAQPage') {
          const q = j.mainEntity || [];
          check(q.length >= 5 && q.every((x) => x.name && x.acceptedAnswer?.text), `${file}: FAQPage has ${q.length} complete questions`);
        }
      } catch (e) { fail(`${file}: JSON-LD #${i} invalid: ${e.message}`); }
      continue;
    }
    if (!s.code.trim()) continue;
    try { new vm.Script(s.code, { filename: `${file}#script${i}` }); ok(`${file}: script #${i} syntax`); }
    catch (e) { fail(`${file}: script #${i} syntax error: ${e.message}`); }
  }
}
// FAQPage on the new page and areaServed on homepage
const kenyaHtml = html['vape-delivery-kenya/index.html'] || '';
check(/"@type":\s*"FAQPage"/.test(kenyaHtml), 'Kenya page has FAQPage JSON-LD');
check(/<h1>Vape delivery across Kenya, based in Nairobi<\/h1>/.test(kenyaHtml), 'Kenya page H1 is correct');
check(/property="og:title"/.test(kenyaHtml) && /property="og:description"/.test(kenyaHtml) && /property="og:url"/.test(kenyaHtml), 'Kenya page has Open Graph tags');
const homeLd = inlineScripts(html['index.html']).filter((s) => /ld\+json/.test(s.attrs)).map((s) => JSON.parse(s.code));
const store = homeLd.find((j) => j['@type'] === 'OnlineStore');
const areas = [].concat(store?.areaServed || []).map((a) => a.name);
check(areas.includes('Nairobi') && areas.includes('Kenya'), `homepage areaServed includes Nairobi and Kenya (${areas.join(', ')})`);
check(/Nairobi-based, delivering across Kenya/.test(store?.description || ''), 'homepage JSON-LD description says "Nairobi-based, delivering across Kenya"');

// ============ 5. wa.me encoding ============
section('5. wa.me links');
const STRICT = /^(?:[A-Za-z0-9\-_.~]|%[0-9A-F]{2})*$/; // uppercase hex, nothing else
function checkWa(url, where) {
  const m = /^https:\/\/wa\.me\/(\d+)(?:\?text=(.*))?$/.exec(url);
  if (!m) return fail(`${where}: malformed wa.me URL: ${url}`);
  if (m[1] !== WA_NUMBER) return fail(`${where}: wrong number ${m[1]}`);
  if (m[2] === undefined) return ok(`${where}: bare link`);
  if (!STRICT.test(m[2])) return fail(`${where}: not strictly percent-encoded: ${m[2]}`);
  try { decodeURIComponent(m[2]); } catch (e) { return fail(`${where}: invalid UTF-8 escape: ${m[2]}`); }
  ok(`${where}: ${decodeURIComponent(m[2])}`);
}
for (const [file, src] of Object.entries(html)) {
  const urls = [...src.matchAll(/(?:href|src)=["'](https?:\/\/wa\.me\/[^"']*)["']/g)].map((m) => m[1]);
  urls.forEach((u) => checkWa(u, file));
  console.log(`  ${file}: ${urls.length} static wa.me links checked`);
}
// no hand-built wa.me strings in JS (all must go through waUrl)
for (const s of indexScripts) {
  const lits = [...s.code.matchAll(/wa\.me\/[^\s"'`;)]*/g)].map((m) => m[0]);
  const bad = lits.filter((l) => !/^wa\.me\/"$/.test(l) && l !== 'wa.me/');
  check(bad.length === 0, `JS builds wa.me links only through waUrl()${bad.length ? ' (found ' + bad.join(', ') + ')' : ''}`);
}
if (api) {
  const nasty = [
    'Hi Vape Loft! What do you have available today?',
    "What's up? 100% sure & ok #1 + more = (yes) * ~ _ - .",
    'Emoji \u{1F44B}\u{1F3FD} \u{1F525} ✓ — café é Swahili: Habari, nataka pakiti mbili',
    'Line one\nLine two\r\nTab\there  "quoted" \\ slash / path ? query = x',
    '\u{1F600}'.repeat(30),
    'Lone surrogate \uD83D end \uDE00 start',
    '',
  ];
  for (const t of nasty) {
    const u = api.waUrl(t);
    checkWa(u, 'waUrl()');
    const decoded = decodeURIComponent(u.split('?text=')[1]);
    check(decoded === t.toWellFormed(), `waUrl round-trips ${JSON.stringify(t).slice(0, 50)}`);
  }
  // message builders
  const priced = [{ label: 'VOOM 70K Lemonade', price: 4500, qty: 2 }, { label: 'VOOM Orbis 15K Mixed Berry', price: 2000, qty: 1 }];
  const mixed = [...priced, { label: 'Nine Star Bar Plus Grape Ice', price: null, qty: 3 }];
  let msg = api.buildListMessage(priced, 'nairobi', 'Westlands');
  check(msg.includes('Estimated total (delivery fee not included): KSh 11,000'), 'list message: total when every item priced (2x4500 + 2000 = KSh 11,000)');
  check(msg.includes('Nairobi (our rider)') && msg.includes('Westlands'), 'list message: includes delivery type and town');
  msg = api.buildListMessage(mixed, 'outside', '');
  check(!/Estimated total/.test(msg), 'list message: no total when an item has no price');
  check(/- 3 x Nine Star Bar Plus Grape Ice(\n|$)/.test(msg) && !/Grape Ice @/.test(msg), 'list message: unpriced item listed without a price');
  check(msg.includes('Outside Nairobi (courier or PSV)'), 'list message: outside delivery type');
  const needs = api.buildNeedMessage({ name: ' Wanjiru \u{1F44B} ', town: 'Nakuru', type: 'outside', want: 'Two "Mango" & one mint\nplease #1' });
  checkWa(api.waUrl(needs), 'buildNeedMessage');
  check(needs.includes('Name: Wanjiru') && needs.includes('Nakuru') && needs.includes('Outside Nairobi'), 'need message includes the fields');
  checkWa(api.waUrl(api.buildNeedMessage({})), 'buildNeedMessage (empty form)');
  // every catalog + more-device item produces a clean link
  let bad = 0;
  for (const p of api.allProducts) { const u = api.waUrl(`Hi Vape Loft! I'd like to order: ${p.name} - ${p.price}.`); if (!STRICT.test(u.split('?text=')[1])) bad++; }
  for (const d of api.moreDevices) if (!STRICT.test(api.waUrl(`I'm interested in the ${d.name} (${d.price}).`).split('?text=')[1])) bad++;
  check(bad === 0, 'catalog-derived wa.me links are strictly encoded');
}

// ============ 6. content rules ============
section('6. Content rules');
for (const [file, src] of Object.entries(html)) {
  check(!/200 to (?:KSh |KES )?1,000/i.test(src), `${file}: no leftover "200 to 1,000" fee wording`);
  check(/18\+|18 or older/.test(src) && /nicotine/i.test(src), `${file}: adults-only / nicotine notice present`);
  check(!/\b(?:safer|healthier|healthy|quit smoking|cure|harmless|health benefit)/i.test(src.replace(/<script[\s\S]*?<\/script>/g, '')), `${file}: no health-claim wording`);
  check(/from KSh 200, depending on distance/i.test(src) || file === 'vape-delivery-kenya/index.html' && /from KSh 200/.test(src), `${file}: rider fee says "from KSh 200, depending on distance"`);
}
for (const f of pages) {
  if (f !== 'vape-delivery-kenya/index.html') check(html[f].includes(`href="${NEW_PAGE}"`), `${f} links to ${NEW_PAGE}`);
}
check((html['index.html'].match(/<a [^>]*href="\/vape-delivery-kenya\/"/g) || []).length >= 4, 'homepage links to the Kenya page from nav, delivery section, FAQ and footer');
check(html['vape-delivery-kenya/index.html'].includes('href="/vape-delivery-nairobi/"'), 'Kenya page links to the Nairobi page');

// ============ 7. image sizing + tap-target basics ============
section('7. Image dimensions (layout shift)');
for (const [file, src] of Object.entries(html)) {
  const tags = [...src.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const noDim = tags.filter((t) => !/\bwidth=/.test(t) || !/\bheight=/.test(t));
  check(noDim.length === 0, `${file}: all ${tags.length} static/template <img> tags have width and height${noDim.length ? ' - missing on ' + noDim[0].slice(0, 80) : ''}`);
  const lazyOk = tags.filter((t) => /loading=/.test(t)).length;
  console.log(`  ${file}: ${lazyOk}/${tags.length} <img> tags set loading=`);
}

// ============ 8. product pages ============
section('8. Product pages (links, images, JSON-LD, sitemap)');
const PRODUCT_PAGES_LIST = ['voom-70k-kenya', 'voom-orbis-15k-kenya', 'voom-aura-13k-pod-system-kenya', 'nine-star-bar-plus-kenya'];
const PRODUCT_PAGES = {
  'voom-70k-kenya': { price: '4500', name: 'VOOM 70K', flavours: 22 },
  'voom-orbis-15k-kenya': { price: '2000', name: 'VOOM Orbis 15K', flavours: 8 },
  'voom-aura-13k-pod-system-kenya': { price: '2600', name: 'VOOM Aura 13K', flavours: 16 },
  'nine-star-bar-plus-kenya': { price: null, name: 'Nine Star Bar Plus', flavours: 12 },
};
for (const [slug, spec] of Object.entries(PRODUCT_PAGES)) {
  const f = `${slug}/index.html`, u = `/${slug}/`;
  check(exists(f), `${f} exists`);
  if (!exists(f)) continue;
  const src = html[f] ?? read(f);
  const short = spec.name.split(' ').slice(0, 2).join(' ');
  check(locs.includes(ORIGIN + u), `${slug}: listed in sitemap.xml`);
  check((src.match(/<h1[\s>]/g) || []).length === 1, `${slug}: exactly one H1`);
  const t = /<title>([^<]*)<\/title>/.exec(src)?.[1] || '', d = /<meta name="description" content="([^"]*)"/.exec(src)?.[1] || '';
  check(/Kenya/.test(t) && t.includes(short), `${slug}: title names product and Kenya`);
  check(/Kenya|Nairobi/.test(d) && d.length <= 160, `${slug}: meta description mentions Kenya/Nairobi, <=160 chars`);
  check(src.includes(`property="og:url" content="${ORIGIN + u}"`) && /property="og:image"/.test(src), `${slug}: Open Graph url and image`);
  check(html['index.html'].split(`href="${u}"`).length - 1 >= 2, `${slug}: linked from homepage (tabs row and footer)`);
  for (const other of Object.keys(PRODUCT_PAGES)) if (other !== slug) check(src.includes(`href="/${other}/"`), `${slug}: links to /${other}/`);
  for (const l of ['/vape-delivery-nairobi/', '/vape-delivery-kenya/', '/']) check(src.includes(`href="${l}"`), `${slug}: links to ${l}`);
  const cards = (src.match(/<li class="card">/g) || []).length;
  check(cards === spec.flavours, `${slug}: ${cards} flavour cards (expected ${spec.flavours})`);
  const imgs = [...src.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  check(imgs.length > 0 && imgs.every((i) => /loading="lazy"/.test(i) && /alt="[^"]{8,}"/.test(i) && /width="\d+"/.test(i) && /height="\d+"/.test(i)), `${slug}: ${imgs.length} images lazy-loaded with alt, width, height`);
  const waLinks = [...src.matchAll(/href="(https:\/\/wa\.me\/[^"]*)"/g)].map((m) => m[1]);
  check(waLinks.some((l) => decodeURIComponent(l.split('?text=')[1] || '').includes(short)), `${slug}: WhatsApp message names the product`);
  const lds = inlineScripts(src).filter((x) => /ld\+json/.test(x.attrs)).map((x) => JSON.parse(x.code));
  const prod = lds.find((j) => j['@type'] === 'Product'), faq = lds.find((j) => j['@type'] === 'FAQPage');
  check(!!prod && prod.name && prod.brand?.name && prod.description && prod.image, `${slug}: Product JSON-LD has name, brand, description, image`);
  if (prod) {
    const o = prod.offers || {};
    check(o.priceCurrency === 'KES' && /InStock$/.test(o.availability || ''), `${slug}: Offer has KES and InStock`);
    check(spec.price ? o.price === spec.price : !('price' in o), `${slug}: Offer price ${spec.price ?? 'omitted (ask on WhatsApp)'}`);
    check(String(prod.image).startsWith(ORIGIN + '/') && exists(String(prod.image).slice(ORIGIN.length + 1)), `${slug}: Product image URL resolves to a file`);
    if (spec.price) check(src.includes('KSh ' + Number(spec.price).toLocaleString('en-US')), `${slug}: page shows the KSh price`);
    else check(/ask on WhatsApp/i.test(src), `${slug}: page says ask on WhatsApp`);
  }
  const nq = faq?.mainEntity?.length || 0;
  check(nq >= 4 && nq <= 8, `${slug}: FAQPage JSON-LD with ${nq} questions (4-8 expected)`);
  check((src.match(/<details class="faq">/g) || []).length === nq, `${slug}: visible FAQ count matches FAQPage JSON-LD`);
  check(/from KSh 200, depending on distance/.test(src) && /courier or PSV/.test(src), `${slug}: Delivery section has rider fee and courier facts`);
}
if (api) {
  const priceOf = (dev) => [...new Set(api.allProducts.filter((p) => p.device === dev).map((p) => p.price))];
  check(priceOf('70k')[0] === 'KSh 4,500' && priceOf('orbis')[0] === 'KSh 2,000' && priceOf('aura')[0] === 'KSh 2,600' && priceOf('ninestar')[0] === null, 'product page prices match homepage data');
}

// ============ 9. landing pages (vapes-nairobi, vapes-kenya) ============
section('9. Landing pages: vapes-nairobi, vapes-kenya');
for (const slug of ['vapes-nairobi', 'vapes-kenya']) {
  const f = `${slug}/index.html`, u = `/${slug}/`;
  check(exists(f), `${f} exists`);
  if (!exists(f)) continue;
  const src = html[f] ?? read(f);
  check(locs.includes(ORIGIN + u), `${slug}: listed in sitemap.xml`);
  check((src.match(/<h1[\s>]/g) || []).length === 1, `${slug}: exactly one H1`);
  check(html['index.html'].includes(`href="${u}"`), `${slug}: linked from homepage footer`);
  for (const l of ['voom-70k-kenya', 'voom-orbis-15k-kenya', 'voom-aura-13k-pod-system-kenya', 'nine-star-bar-plus-kenya', 'vape-delivery-nairobi', 'vape-delivery-kenya'])
    check(src.includes(`href="/${l}/"`), `${slug}: links to /${l}/`);
  for (const p of PRODUCT_PAGES_LIST) check((html[`${p}/index.html`] || '').includes(`href="${u}"`), `${p}: footer links to ${u}`);
  const lds = inlineScripts(src).filter((x) => /ld\+json/.test(x.attrs)).map((x) => JSON.parse(x.code));
  const nq = lds.find((j) => j['@type'] === 'FAQPage')?.mainEntity?.length || 0;
  check(nq >= 5 && (src.match(/<details class="faq">/g) || []).length === nq, `${slug}: FAQPage JSON-LD (${nq}) matches visible FAQ`);
  check(!!lds.find((j) => j['@type'] === 'BreadcrumbList'), `${slug}: BreadcrumbList JSON-LD`);
  check(/from KSh 200, depending on distance/.test(src) && /courier or PSV/.test(src), `${slug}: rider fee and courier facts`);
  // price table must match the homepage data
  if (api) for (const [dev, label] of [['70k', 'VOOM 70K'], ['ultra', 'VOOM 70K Ultra'], ['meteor', 'VOOM Meteor'], ['orbis', 'VOOM Orbis 15K'], ['aura', 'VOOM Aura 13K Pod + Battery']]) {
    const price = api.allProducts.find((p) => p.device === dev).price;
    check(new RegExp(`${label.replace(/[+]/g, '\\+')}</a><br>[\\s\\S]*?<td>\\d+</td><td>${price}</td>`).test(src), `${slug}: ${label} price ${price} matches homepage data`);
  }
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
