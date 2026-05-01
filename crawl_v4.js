require('dotenv').config();

// 解析 --env 参数（如 npm run start:online 传入 --env online）
const envIdx = process.argv.indexOf('--env');
if (envIdx !== -1 && process.argv[envIdx + 1]) {
  process.env.CRAWLER_MODE = process.argv[envIdx + 1];
}

const https = require('https');
const zlib = require('zlib');
const iconv = require('iconv-lite');
const fs = require('fs');

function fetch(url, timeout) {
  return new Promise((resolve, reject) => {
    try {
      // 统一使用 https（汽车之家的 http URL 也能重定向到 https）
      if (url.startsWith('http:')) url = url.replace('http:', 'https:');
      const u = new URL(url);
      const req = https.request(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const enc = res.headers['content-encoding'];
          let body;
          try {
            if (enc === 'gzip') body = zlib.gunzipSync(buf);
            else if (enc === 'deflate') body = zlib.inflateSync(buf);
            else if (enc === 'br') body = zlib.brotliDecompressSync(buf);
            else body = buf;
          } catch(e) { body = buf; }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeout || 15000, () => { try { req.destroy(); } catch(e){} reject(new Error('timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

function smartDecode(buf, headers) {
  const ct = headers['content-type'] || '';
  if (ct.includes('gbk') || ct.includes('gb2312') || ct.includes('charset=gb')) return iconv.decode(buf, 'gbk');
  const sample = buf.toString('binary').substring(0, 1000);
  const mc = sample.match(/<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9\-_]+)/i) ||
             sample.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([a-zA-Z0-9\-_]+)/i);
  if (mc) { const cs = mc[1].toLowerCase(); if (cs==='gbk'||cs==='gb2312'||cs==='gb18030') return iconv.decode(buf, 'gbk'); }
  return iconv.decode(buf, 'utf8');
}

function normalize(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (!url.match(/^https?:\/\//)) return null;
  return url.split('#')[0];
}

// 判断是否是汽车之家文章 URL（旧格式 /news/YYYYMM/ID.html 或新格式 /article?id=xxx）
function isAutohomeArticle(u) {
  if (!u) return false;
  return /autohome\.com\.cn\/(?:article\?id=[a-zA-Z0-9_=]+|\w+\/\d{6}\/\d+\.html)/.test(u);
}

// ─── 汽车之家文章详情页：提取真实发布时间 ───────────────────────────────────────
// 实际页面格式: <span ...>2026-04-16 13:07</span>
function extractAutohomePublishTime(html) {
  // 格式1: <span class=" tw-ml-[4px]">2026-04-16 13:07</span>  （新版 SSR）
  const ssrMatch = html.match(/<span[^>]+>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*<\/span>/);
  if (ssrMatch) {
    const [date, hm] = ssrMatch[1].split(' ');
    const [h, mi] = hm.split(':');
    return `${date}T${h.padStart(2,'0')}:${mi}:00.000Z`;
  }

  // 格式2: og:published_time
  const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']article:published_time["'][^>]+content\s*=\s*["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']article:published_time["']/i);
  if (ogMatch) { const d = new Date(ogMatch[1]); if (!isNaN(d)) return d.toISOString(); }

  // 格式3: <span class="fn-left">2026-04-16 10:30:00</span>
  const fnMatch = html.match(/<span[^>]+class\s*=\s*["']fn-left["'][^>]*>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/);
  if (fnMatch) {
    const [date, hm] = fnMatch[1].split(' ');
    const [h, mi] = hm.split(':');
    return `${date}T${h.padStart(2,'0')}:${mi}:00.000Z`;
  }

  // 格式4: 2026年04月16日 10:30 形式
  const cnMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+\d{2}:\d{2}/);
  if (cnMatch) {
    const [, y, mo, d] = cnMatch;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00.000Z`;
  }

  return null;
}

// ─── 预处理：全局提取 OG title ─────────────────────────────────────────────────
function extractOgTitleMap(html) {
  const map = {};
  const re1 = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/gi;
  const re2 = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/gi;
  const re3 = /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/gi;
  const re4 = /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']title["']/gi;
  const re5 = /<meta[^>]+\bproperty\s*=\s*["']og:title["'][^>]+\bcontent\s*=\s*["']([^"']+)["']/gi;
  const re6 = /<meta[^>]+\bcontent\s*=\s*["']([^"']+)["'][^>]+\bproperty\s*=\s*["']og:title["']/gi;
  for (const re of [re1, re2, re3, re4, re5, re6]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]) map[html.substring(m.index, m.index + 200)] = m[1].trim();
    }
  }
  return map;
}

function findOgTitle(ogMap, urlPath) {
  for (const [ctx, title] of Object.entries(ogMap)) {
    if (ctx.includes(urlPath)) return title;
  }
  return null;
}

// ─── AUTOHOME ────────────────────────────────────────────────────────────────
function parseAutohome(html, catName) {
  const articles = [];
  // 支持两种URL格式：/news/202605/1314075.html 和 /article?id=xxx（无分类前缀）
  const validUrlRe = /\/(?:news|drive|use|advice|culture|tech|tuning|ev|hangye|newbrand)\/(?:\d{6}\/\d+\.html|article\?id=[a-zA-Z0-9_=]+)|article\?id=[a-zA-Z0-9_=]+/;

  const liRe = /<li\s+data-artidanchor\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const liContent = m[2];
    const urlMatch = liContent.match(/href\s*=\s*["']([^"']+)["']/);
    if (!urlMatch) continue;
    const url = normalize(urlMatch[1]);
    if (!url || !isAutohomeArticle(url)) continue;

    let coverImage = null;
    const imgMatch = liContent.match(/<img\s+[^>]*src\s*=\s*["']([^"']+)["']/i);
    if (imgMatch) {
      let src = imgMatch[1];
      if (src.startsWith('//')) src = 'https:' + src;
      if (src.match(/\.(?:jpg|png|jpeg|webp)/i) && !src.includes('blank.gif') && !src.includes('loading')) {
        coverImage = src;
      }
    }

    let title = null;
    const h3Match = liContent.match(/<h3[^>]*>\s*([^<]+)\s*<\/h3>/i);
    if (h3Match) title = h3Match[1].trim();

    // 从 HTML 中提取真实日期
    let publishTime = null;
    // 格式1: 绝对时间 <span class="time">05-01 14:38</span>
    const timeInLi = liContent.match(/<span[^>]*time[^>]*>\s*(\d{2})-(\d{2})\s*(\d{2}):(\d{2})/i);
    if (timeInLi) {
      const now = new Date();
      publishTime = now.getFullYear() + '-' + timeInLi[1] + '-' + timeInLi[2] + 'T' + timeInLi[3] + ':' + timeInLi[4] + ':00.000Z';
    } else {
      // 格式2: 相对时间 <span class="fn-left">37分钟前</span>
      const relativeMatch = liContent.match(/<span[^>]*fn-left[^>]*>\s*(\d+)(分钟|小时|天)前/);
      if (relativeMatch) {
        const amount = parseInt(relativeMatch[1]);
        const unit = relativeMatch[2];
        const now = new Date();
        if (unit === '分钟') now.setMinutes(now.getMinutes() - amount);
        else if (unit === '小时') now.setHours(now.getHours() - amount);
        else if (unit === '天') now.setDate(now.getDate() - amount);
        publishTime = now.toISOString();
      } else {
        // fallback: 从 URL 只能拿到月，精确不到日
        const timeMatch = url.match(/\/(\d{4})(\d{2})\/(\d+)\.html/);
        if (timeMatch) publishTime = timeMatch[1] + '-' + timeMatch[2] + '-01T00:00:00.000Z';
      }
    }

    articles.push({ url, source: 'autohome', category: catName, title, coverImage, publishTime });
  }

  const dlRe = /<dl\s+class\s*=\s*["']all-list["'][^>]*>([\s\S]*?)<\/dl>/gi;
  let dl;
  while ((dl = dlRe.exec(html)) !== null) {
    const dlContent = dl[1];
    const ddRe = /<dd\s+class\s*=\s*["']carinfo["'][^>]*>([\s\S]*?)<\/dd>/gi;
    let dd;
    while ((dd = ddRe.exec(dlContent)) !== null) {
      const ddContent = dd[1];
      const urlMatch = ddContent.match(/href\s*=\s*["']([^"']+)["']/);
      if (!urlMatch) continue;
      const url = normalize(urlMatch[1]);
      if (!url || !isAutohomeArticle(url)) continue;

      let coverImage = null;
      const dataSrcMatch = ddContent.match(/data-src\s*=\s*["']([^"']+)["']/);
      const srcMatch = ddContent.match(/<img\s+[^>]*src\s*=\s*["']([^"']+)["']/i);
      if (dataSrcMatch) {
        let src = dataSrcMatch[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src.match(/\.(?:jpg|png|jpeg|webp)/i) && !src.includes('blank.gif')) coverImage = src;
      } else if (srcMatch) {
        let src = srcMatch[1];
        if (src.startsWith('//')) src = 'https:' + src;
        if (src.match(/\.(?:jpg|png|jpeg|webp)/i) && !src.includes('blank.gif')) coverImage = src;
      }

      let title = null;
      const titleMatch = ddContent.match(/<span\s+class\s*=\s*["']title["'][^>]*>\s*([^<]+)\s*<\/span>/i) ||
                         ddContent.match(/title\s*=\s*["']([^"']{3,100})["']/i);
      if (titleMatch) title = titleMatch[1].trim();

      // 从 HTML 中提取真实日期
      let publishTime = null;
      const timeInDd = ddContent.match(/<span[^>]*time[^>]*>\s*(\d{2})-(\d{2})\s*(\d{2}):(\d{2})/i);
      if (timeInDd) {
        const now = new Date();
        publishTime = now.getFullYear() + '-' + timeInDd[1] + '-' + timeInDd[2] + 'T' + timeInDd[3] + ':' + timeInDd[4] + ':00.000Z';
      } else {
        const monthOnly = url.match(/\/(\d{4})(\d{2})\/\d+\.html/);
        if (monthOnly) publishTime = monthOnly[1] + '-' + monthOnly[2] + '-01T00:00:00.000Z';
      }

      articles.push({ url, source: 'autohome', category: catName, title, coverImage, publishTime });
    }
  }

  return articles;
}

// ─── DONGCHEDI ───────────────────────────────────────────────────────────────
function parseDongchedi(html, catName, ogTitleMap) {
  const articles = [];
  const seen = new Set();
  const hrefRe = /href\s*=\s*["'](\/article\/\d+)["']/gi;
  let hm;
  while ((hm = hrefRe.exec(html)) !== null) {
    const urlPath = hm[1];
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);

    const anchorStart = Math.max(0, hm.index - 100);
    const anchorEnd = Math.min(html.length, hm.index + 1500);
    const anchorBlock = html.substring(anchorStart, anchorEnd);

    let title = null;
    const anchorTitleMatch = anchorBlock.match(/<a[^>]+title\s*=\s*["']([^"']{3,100})["']/i);
    if (anchorTitleMatch) title = anchorTitleMatch[1].trim();
    if (!title) title = findOgTitle(ogTitleMap, urlPath);

    let coverImage = null;
    const byteimgMatch = anchorBlock.match(/(?:src|data-src)\s*=\s*["']([^"']*p\d+-dcd-sign\.byteimg\.com[^"']*)["']/i) ||
                         anchorBlock.match(/(https?:\/\/p\d+-dcd-sign\.byteimg\.com[^"'\s>]+)/gi);
    if (byteimgMatch) {
      let url = byteimgMatch[1] || byteimgMatch[0];
      url = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      if (url.startsWith('//')) url = 'https:' + url;
      coverImage = url;
    }

    articles.push({
      url: 'https://www.dongchedi.com' + urlPath,
      source: 'dongchedi',
      category: catName,
      title,
      coverImage,
      publishTime: null,
    });
  }
  return articles;
}

// ─── YICHE ───────────────────────────────────────────────────────────────────
function parseYiche(html, catName, ogTitleMap) {
  const articles = [];
  const seen = new Set();
  const hrefRe = /href\s*=\s*["'](\/[^"']*\/\d{8}\/\d{7,}\.html)["']/gi;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const urlPath = m[1];
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);

    const fullUrl = 'https://news.yiche.com' + urlPath;
    const timeMatch = urlPath.match(/\/(\d{4})(\d{2})(\d{2})\//);
    const publishTime = timeMatch
      ? timeMatch[1] + '-' + timeMatch[2] + '-' + timeMatch[3] + 'T00:00:00.000Z'
      : null;

    const anchorStart = Math.max(0, m.index - 100);
    const anchorEnd = Math.min(html.length, m.index + 1200);
    const anchorBlock = html.substring(anchorStart, anchorEnd);

    let title = null;
    const anchorTitleMatch = anchorBlock.match(/<a[^>]+title\s*=\s*["']([^"']{3,100})["']/i);
    if (anchorTitleMatch) title = anchorTitleMatch[1].trim();
    if (!title) title = findOgTitle(ogTitleMap, urlPath);
    if (!title) {
      const hMatch = anchorBlock.match(/<h[34][^>]*>\s*([^<]{5,100})\s*<\//i);
      if (hMatch) title = hMatch[1].trim();
    }
    if (!title) {
      const dataTitleMatch = anchorBlock.match(/data-title\s*=\s*["']([^"']{3,100})["']/i);
      if (dataTitleMatch) title = dataTitleMatch[1].trim();
    }

    let coverImage = null;
    const dataSrcMatch = anchorBlock.match(/data-src\s*=\s*["']([^"']+)["']/i) ||
                        anchorBlock.match(/data-original\s*=\s*["']([^"']+)["']/i) ||
                        anchorBlock.match(/data-img\s*=\s*["']([^"']+)["']/i);
    const srcMatches = anchorBlock.match(/<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi) || [];
    for (const imgTag of srcMatches) {
      const srcM = imgTag.match(/src\s*=\s*["']([^"']+)["']/);
      if (!srcM) continue;
      let src = srcM[1];
      if (src.startsWith('//')) src = 'https:' + src;
      if ((src.includes('bitautoimg') || src.includes('appimage') || src.includes('yiche.com')) &&
          !src.includes('loading') && !src.includes('blank') && !src.includes('placeholder')) {
        coverImage = src;
        break;
      }
    }
    if (!coverImage && dataSrcMatch) {
      let src = dataSrcMatch[1];
      if (src.startsWith('//')) src = 'https:' + src;
      if ((src.includes('bitautoimg') || src.includes('appimage') || src.match(/\.(jpg|png|webp)$/i)) &&
          !src.includes('loading')) {
        coverImage = src;
      }
    }

    articles.push({ url: fullUrl, source: 'yiche', category: catName, title, coverImage, publishTime });
  }
  return articles;
}

// ─── 批量抓取汽车之家文章详情页，补充真实发布时间 ───────────────────────────────
async function fetchAutohomeDetailTimes(articles) {
  // 找所有需要补充的汽车之家文章（当前为 month-01 的）
  const needDetail = articles.filter(a =>
    a.source === 'autohome' && a.publishTime && a.publishTime.endsWith('-01T00:00:00.000Z')
  );

  if (needDetail.length === 0) return;
  console.log('\n开始抓取汽车之家文章详情，补充真实发布时间（' + needDetail.length + ' 条）...');

  for (let i = 0; i < needDetail.length; i += 10) {
    const batch = needDetail.slice(i, i + 10);
    const results = await Promise.all(batch.map(a => fetchDetailTime(a.url)));

    for (let j = 0; j < batch.length; j++) {
      if (results[j]) batch[j].publishTime = results[j];
    }

    if ((i + 10) % 50 === 0 || i + 10 >= needDetail.length) {
      const updated = batch.filter(x => x.publishTime && !x.publishTime.endsWith('-01T00:00:00.000Z')).length;
      console.log('  进度 ' + Math.min(i + 10, needDetail.length) + '/' + needDetail.length + '，本批更新 ' + updated + ' 条');
    }
  }
}

async function fetchDetailTime(url) {
  try {
    const { status, headers, body } = await fetch(url, 10000);
    if (status !== 200) return null;
    const html = smartDecode(body, headers);
    return extractAutohomePublishTime(html);
  } catch(e) {
    return null;
  }
}

const sites = [
  {
    name: 'autohome',
    categories: [
      { name: '最新',   url: 'https://www.autohome.com.cn/all/' },
      { name: '新闻',   url: 'https://www.autohome.com.cn/news/' },
      { name: '咨询',   url: 'https://www.autohome.com.cn/advice/' },
      { name: '试驾',   url: 'https://www.autohome.com.cn/drive/' },
      { name: '用车',   url: 'https://www.autohome.com.cn/use/' },
      { name: '文化',   url: 'https://www.autohome.com.cn/culture/' },
      { name: '科技',   url: 'https://www.autohome.com.cn/tech/' },
      { name: '改装',   url: 'https://www.autohome.com.cn/tuning/' },
      { name: '新能源', url: 'https://www.autohome.com.cn/ev/' },
      { name: '行业',   url: 'https://www.autohome.com.cn/hangye/list/' },
      { name: '新车',   url: 'https://www.autohome.com.cn/newbrand/' },
    ],
    parse: parseAutohome,
  },
  {
    name: 'dongchedi',
    categories: [
      { name: '最新',   url: 'https://www.dongchedi.com/news' },
      { name: '新车',   url: 'https://www.dongchedi.com/news/newcar' },
      { name: '行业',   url: 'https://www.dongchedi.com/news/industry' },
      { name: '导购',   url: 'https://www.dongchedi.com/news/guide' },
      { name: '评测',   url: 'https://www.dongchedi.com/news/review' },
      { name: '用车',   url: 'https://www.dongchedi.com/news/usage' },
      { name: '文化',   url: 'https://www.dongchedi.com/news/culture' },
      { name: '二手车', url: 'https://www.dongchedi.com/news/used' },
    ],
    parse: parseDongchedi,
  },
  {
    name: 'yiche',
    categories: [
      { name: '最新',     url: 'https://news.yiche.com/' },
      { name: '新车',     url: 'https://news.yiche.com/xinche/' },
      { name: '技术',     url: 'https://news.yiche.com/jishu/' },
      { name: '游记',     url: 'https://news.yiche.com/youji/' },
      { name: '评测',     url: 'https://news.yiche.com/pingce/' },
      { name: '导购',     url: 'https://news.yiche.com/daogou/' },
      { name: '综合新闻', url: 'https://news.yiche.com/zonghexinwen/' },
    ],
    parse: parseYiche,
  },
];

async function main() {
  const seen = new Set();
  const allArticles = [];

  for (const site of sites) {
    for (const cat of site.categories) {
      console.log('抓取 ' + site.name + ' ' + cat.name + '...');
      try {
        const { status, headers, body } = await fetch(cat.url);
        const html = smartDecode(body, headers);
        const ogTitleMap = extractOgTitleMap(html);
        const parse = site.name === 'autohome' ? parseAutohome : site.parse;
        const articles = site.name === 'autohome'
          ? parse(html, cat.name)
          : parse(html, cat.name, ogTitleMap);

        let newCount = 0;
        for (const a of articles) {
          if (!seen.has(a.url)) {
            seen.add(a.url);
            allArticles.push(a);
            newCount++;
          }
        }

        const hasTitle = articles.length > 0 && articles[0].title ? '✓' : '✗';
        const hasCover = articles.length > 0 && articles[0].coverImage ? '✓' : '✗';
        console.log('  -> ' + articles.length + ' 条, 新增 ' + newCount
          + ' (标题:' + hasTitle + ' 封面:' + hasCover + ')');
      } catch(e) {
        console.log('  -> ERR: ' + e.message);
      }
    }
  }

  // 补充汽车之家文章真实发布时间
  await fetchAutohomeDetailTimes(allArticles);

  // 统计
  const stats = {};
  for (const a of allArticles) {
    if (!stats[a.source]) stats[a.source] = { total: 0, categories: {} };
    stats[a.source].total++;
    stats[a.source].categories[a.category] = (stats[a.source].categories[a.category] || 0) + 1;
  }

  const result = {
    timestamp: new Date().toISOString(),
    total: allArticles.length,
    stats,
    articles: allArticles,
  };

  // ─── 本地 JSON 输出（默认） ───────────────────────────────────────────────
  if (process.env.CRAWLER_MODE !== 'online') {
    fs.writeFileSync('./hot-articles.json', JSON.stringify(result, null, 2));
    console.log('已写入本地 JSON: ./hot-articles.json');
  }

  // ─── MySQL 输出（npm run start:online） ───────────────────────────────────
  if (process.env.CRAWLER_MODE === 'online') {
    await saveToDatabase(allArticles);
  }

  console.log('\n=== 完成 ===');
  console.log('总计: ' + allArticles.length + ' 条');
  console.log('有标题: ' + allArticles.filter(a => a.title).length);
  console.log('有封面: ' + allArticles.filter(a => a.coverImage).length);
  console.log('有时间: ' + allArticles.filter(a => a.publishTime).length);
  const exactDay = allArticles.filter(a => a.source === 'autohome' && a.publishTime && !a.publishTime.endsWith('-01T00:00:00.000Z')).length;
  console.log('（其中精确到日的汽车之家: ' + exactDay + ' 条）');
  console.log('\n各源示例:');
  for (const src of ['autohome', 'dongchedi', 'yiche']) {
    const a = allArticles.find(x => x.source === src && x.title && x.coverImage);
    if (a) console.log('  ' + src + ':', JSON.stringify(a, null, 2));
  }
}

const mysql = require('mysql2/promise');

// ─── MySQL 数据库初始化（幂等：表存在则清空，不存在则创建） ────────
async function initDatabase(conn) {
  // 先判断表是否存在
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS cnt FROM information_schema.tables
     WHERE table_schema = ? AND table_name = 'auto_news'`,
    [process.env.DB_NAME],
  );

  if (rows[0].cnt > 0) {
    // 表已存在，TRUNCATE（比 DROP+CREATE 更快，auto_increment 也重置）
    await conn.execute('TRUNCATE TABLE auto_news');
    console.log('已清空旧表 auto_news');
  } else {
    // 表不存在，新建
    await conn.execute(`
      CREATE TABLE auto_news (
        id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        url         VARCHAR(512) NOT NULL,
        title       VARCHAR(512) DEFAULT NULL,
        source      VARCHAR(32) NOT NULL,
        category    VARCHAR(64) DEFAULT NULL,
        cover_image VARCHAR(1024) DEFAULT NULL,
        publish_time DATETIME DEFAULT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE INDEX idx_url (url)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ MySQL 表 auto_news 已创建');
  }
}

// ─── MySQL 写入 ───────────────────────────────────────────────────────────
async function saveToDatabase(articles) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
  });

  // 复用同一连接初始化表
  await initDatabase(conn);

  let inserted = 0;
  for (const a of articles) {
    const publishTime = a.publishTime
      ? new Date(a.publishTime).toISOString().slice(0, 19).replace('T', ' ')
      : null;

    try {
      await conn.execute(
        `INSERT IGNORE INTO auto_news (url, title, source, category, cover_image, publish_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [a.url, a.title || null, a.source, a.category || null, a.coverImage || null, publishTime],
      );
      inserted++;
    } catch(e) {
      if (e.code !== 'ER_DUP_ENTRY') console.warn('写入失败:', e.message);
    }
  }

  await conn.end();
  console.log('✅ 已写入 MySQL: ' + inserted + ' 条');
}

main().catch(console.log);
