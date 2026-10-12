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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 站点专属 UA：易车对普通浏览器 UA 弹验证码，百度蜘蛛 UA 可直接放行（页面结构不变）
function siteUA(url) {
  if (url.includes('yiche.com')) return 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
}

// 站点专属 Cookie（可选）：在 .env 配置 DONGCHEDI_COOKIE / YICHE_COOKIE
// 用于通过懂车帝登录墙、易车验证码等风控（从浏览器 F12 复制 Cookie 即可）
function siteCookie(url) {
  if (url.includes('dongchedi.com') && process.env.DONGCHEDI_COOKIE) return process.env.DONGCHEDI_COOKIE;
  if (url.includes('yiche.com') && process.env.YICHE_COOKIE) return process.env.YICHE_COOKIE;
  return null;
}

function fetchOnce(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.request(u, { headers }, res => {
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

async function fetch(url, timeout, redirects) {
  // 统一使用 https（汽车之家的 http URL 也能重定向到 https）
  if (url.startsWith('http:')) url = url.replace('http:', 'https:');
  const headers = {
    'User-Agent': siteUA(url),
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  const cookie = siteCookie(url);
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetchOnce(url, headers, timeout);

  // 跟随 3xx 重定向（最多 3 跳），否则拿到空页面会静默解析出 0 条
  if (res.status >= 300 && res.status < 400 && res.headers.location && (redirects || 0) < 3) {
    const next = res.headers.location.startsWith('http')
      ? res.headers.location
      : new URL(res.headers.location, url).href;
    return fetch(next, timeout, (redirects || 0) + 1);
  }
  return { status: res.status, headers: res.headers, body: res.body };
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

// 统一时间语义：文章时间一律为"北京时间墙钟"，格式 'YYYY-MM-DD HH:mm:ss'
// MySQL DATETIME 不带时区，读取端需按 Asia/Shanghai 解释；写入时原样入库，不做任何时区换算
function fmtBeijingWall(d) {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
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
    return `${date} ${h.padStart(2,'0')}:${mi}:00`;
  }

  // 格式2: og:published_time
  const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']article:published_time["'][^>]+content\s*=\s*["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']article:published_time["']/i);
  if (ogMatch) { const d = new Date(ogMatch[1]); if (!isNaN(d)) return fmtBeijingWall(d); }

  // 格式3: <span class="fn-left">2026-04-16 10:30:00</span>
  const fnMatch = html.match(/<span[^>]+class\s*=\s*["']fn-left["'][^>]*>\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/);
  if (fnMatch) {
    const [date, hm] = fnMatch[1].split(' ');
    const [h, mi] = hm.split(':');
    return `${date} ${h.padStart(2,'0')}:${mi}:00`;
  }

  // 格式4: 2026年04月16日 10:30 形式
  const cnMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s+\d{2}:\d{2}/);
  if (cnMatch) {
    const [, y, mo, d] = cnMatch;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')} 00:00:00`;
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
      publishTime = now.getFullYear() + '-' + timeInLi[1] + '-' + timeInLi[2] + ' ' + timeInLi[3] + ':' + timeInLi[4] + ':00';
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
        publishTime = fmtBeijingWall(now);
      } else {
        // fallback: 从 URL 只能拿到月，精确不到日
        const timeMatch = url.match(/\/(\d{4})(\d{2})\/(\d+)\.html/);
        if (timeMatch) publishTime = timeMatch[1] + '-' + timeMatch[2] + '-01 00:00:00';
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
        publishTime = now.getFullYear() + '-' + timeInDd[1] + '-' + timeInDd[2] + ' ' + timeInDd[3] + ':' + timeInDd[4] + ':00';
      } else {
        const monthOnly = url.match(/\/(\d{4})(\d{2})\/\d+\.html/);
        if (monthOnly) publishTime = monthOnly[1] + '-' + monthOnly[2] + '-01 00:00:00';
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
      ? timeMatch[1] + '-' + timeMatch[2] + '-' + timeMatch[3] + ' 00:00:00'
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
    a.source === 'autohome' && a.publishTime && a.publishTime.endsWith('-01 00:00:00')
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
      const updated = batch.filter(x => x.publishTime && !x.publishTime.endsWith('-01 00:00:00')).length;
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
      let fetched = null, lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          fetched = await fetch(cat.url);
          lastErr = null;
          break;
        } catch(err) {
          lastErr = err;
          if (attempt < 3) await sleep(2000 * attempt);
        }
      }
      try {
        if (!fetched) throw (lastErr || new Error('fetch failed'));
        const { status, headers, body } = fetched;
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
        if (articles.length === 0) {
          console.log('  ⚠ 0 条且 HTTP ' + status + '，可能是反爬/登录墙/页面改版'
            + (siteCookie(cat.url) ? '' : '（可尝试在 .env 配置该站 Cookie）'));
        }
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
  const exactDay = allArticles.filter(a => a.source === 'autohome' && a.publishTime && !a.publishTime.endsWith('-01 00:00:00')).length;
  console.log('（其中精确到日的汽车之家: ' + exactDay + ' 条）');
  console.log('\n各源示例:');
  for (const src of ['autohome', 'dongchedi', 'yiche']) {
    const a = allArticles.find(x => x.source === src && x.title && x.coverImage);
    if (a) console.log('  ' + src + ':', JSON.stringify(a, null, 2));
  }
}

const mysql = require('mysql2/promise');

// ─── MySQL 数据库初始化（幂等：表不存在则创建，存在则保留历史数据） ────────
async function initDatabase(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS auto_news (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      url         VARCHAR(512) NOT NULL,
      title       VARCHAR(512) DEFAULT NULL,
      source      VARCHAR(32) NOT NULL,
      category    VARCHAR(64) DEFAULT NULL,
      cover_image VARCHAR(1024) DEFAULT NULL,
      publish_time DATETIME DEFAULT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_url (url(191))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✅ MySQL 表 auto_news 就绪（增量写入，保留历史数据）');
}

// ─── 数据库配置（主库 + 备用库，主库连不上时自动切换备用库） ──────────────
function dbConfigs() {
  const list = [{
    label: '主库',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  }];
  if (process.env.DB2_HOST) {
    list.push({
      label: '备用库',
      host: process.env.DB2_HOST,
      port: Number(process.env.DB2_PORT || 3306),
      user: process.env.DB2_USER,
      password: process.env.DB2_PASSWORD,
      database: process.env.DB2_NAME,
    });
  }
  return list;
}

// 带重试的连接（默认 3 次，间隔递增 3s/6s）
async function createDbConn(cfg, attempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await mysql.createConnection({ ...cfg, charset: 'utf8mb4', connectTimeout: 15000 });
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) await sleep(3000 * attempt);
    }
  }
  throw lastErr;
}

// ─── MySQL 写入（增量 upsert：已存在的 URL 更新字段，不存在的插入） ───────
async function saveToDatabase(articles) {
  for (const cfg of dbConfigs()) {
    let conn;
    try {
      conn = await createDbConn(cfg);
    } catch (e) {
      console.warn('⚠️ ' + cfg.label + '(' + cfg.host + ') 连接失败（已重试 3 次）: ' + (e.code || e.message));
      continue; // 切换下一个库
    }

    try {
      await initDatabase(conn);

      let inserted = 0, updated = 0;
      for (const a of articles) {
        // publishTime 已是 'YYYY-MM-DD HH:mm:ss' 的北京时间墙钟，原样入库，不做时区换算
        const publishTime = a.publishTime ? String(a.publishTime).slice(0, 19) : null;

        try {
          // publish_time 只升级不降级：NULL→有值、月初占位(00:00:00)→精确到时分秒 才覆盖
          const [result] = await conn.execute(
            `INSERT INTO auto_news (url, title, source, category, cover_image, publish_time)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               title = VALUES(title),
               category = VALUES(category),
               cover_image = VALUES(cover_image),
               publish_time = IF(
                 VALUES(publish_time) IS NULL,
                 publish_time,
                 IF(publish_time IS NULL OR (RIGHT(publish_time, 8) = '00:00:00' AND RIGHT(VALUES(publish_time), 8) <> '00:00:00'),
                    VALUES(publish_time),
                    publish_time)
               )`,
            [a.url, a.title || null, a.source, a.category || null, a.coverImage || null, publishTime],
          );
          if (result.affectedRows === 1) inserted++;
          else if (result.affectedRows === 2) updated++;
        } catch(e) {
          console.warn('写入失败:', a.url, e.message);
        }
      }

      await conn.end();
      console.log('✅ 已写入 ' + cfg.label + '(' + cfg.host + '): 新增 ' + inserted + ' 条, 更新 ' + updated + ' 条');
      return cfg.label;
    } catch (e) {
      console.warn('⚠️ ' + cfg.label + '(' + cfg.host + ') 写入异常: ' + (e.code || e.message));
      try { await conn.end(); } catch (_) {}
      continue; // 切换下一个库
    }
  }

  console.error('❌ 主库与备用库均无法写入，本轮数据未入库');
  process.exitCode = 1; // 让定时任务日志能看到失败状态
}

main().catch(console.log);
