const https = require('https');
const zlib = require('zlib');
const iconv = require('iconv-lite');
const fs = require('fs');

function fetch(url, timeout) {
  return new Promise((resolve, reject) => {
    try {
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
  if (url.startsWith('//')) return 'https:' + url;
  if (!url.match(/^https?:\/\//)) return null;
  return url.split('#')[0].replace(/\?.*$/, '');
}

// ─── 预处理：全局提取 OG title ─────────────────────────────────────────────────
// 懂车帝和易车的 og:title 在 <head> 里，列表页每个 article 附近搜不到
// 提前扫描全页建立 urlPath → title 的映射
function extractOgTitleMap(html) {
  const map = {};
  // og:title 可能以多种形式出现：property="og:title" content="标题" 或 content="标题" property="og:title"
  // 也可能是 name="title"（易车旧形式）
  const re1 = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/gi;
  const re2 = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/gi;
  const re3 = /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/gi;
  const re4 = /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']title["']/gi;
  // 兼容含空格的属性写法
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

// 从全局 OG title map 里找匹配给定 urlPath 的标题
function findOgTitle(ogMap, urlPath) {
  // urlPath 形如 /article/123 或 /xinche/20260415/12345678901.html
  for (const [ctx, title] of Object.entries(ogMap)) {
    if (ctx.includes(urlPath)) return title;
  }
  return null;
}

// ─── AUTOHOME ────────────────────────────────────────────────────────────────
// 标准列表页：<li data-artidanchor="ID"><a href="URL"><div class="article-pic"><img src="COVER"/></div><h3>title</h3>
// 新车页：<dl class="all-list"><dt class="month">YYYY年MM月</dt><dd class="carinfo"><a href="URL"><img data-src="COVER"/><h4>title</h4>
function parseAutohome(html, catName) {
  const articles = [];

  // 修复：URL 正则补上 newbrand 分类
  const validUrlRe = /\/(?:news|drive|use|advice|culture|tech|tuning|ev|hangye|newbrand)\/\d{6}\/\d+\.html/;

  // 标准 li 模式
  const liRe = /<li\s+data-artidanchor\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const liContent = m[2];
    const urlMatch = liContent.match(/href\s*=\s*["']([^"']+)["']/);
    if (!urlMatch) continue;
    const url = normalize(urlMatch[1]);
    if (!url || !validUrlRe.test(url)) continue;

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

    // URL 路径两种形式：
    // 1. /news/202604/15/1313635.html  （精确到日）
    // 2. /news/202604/1313635.html     （只到月份，无日期）
    const timeMatch = url.match(/\/(\d{4})(\d{2})\/(\d{2})\/\d+\.html/);
    const publishTime = timeMatch
      ? timeMatch[1] + '-' + timeMatch[2] + '-' + timeMatch[3] + 'T00:00:00.000Z'
      : (() => {
          const monthOnly = url.match(/\/(\d{4})(\d{2})\/\d+\.html/);
          return monthOnly ? monthOnly[1] + '-' + monthOnly[2] + '-01T00:00:00.000Z' : null;
        })();

    articles.push({ url, source: 'autohome', category: catName, title, coverImage, publishTime });
  }

  // 新车 newbrand 模式：<dl class="all-list"> + <dd class="carinfo">
  const dlRe = /<dl\s+class\s*=\s*["']all-list["'][^>]*>([\s\S]*?)<\/dl>/gi;
  let dl;
  while ((dl = dlRe.exec(html)) !== null) {
    const dlContent = dl[1];
    const ddRe = /<dd\s+class\s*=\s*["']carinfo["']([^>]*)>([\s\S]*?)<\/dd>/gi;
    let dd;
    while ((dd = ddRe.exec(dlContent)) !== null) {
      const ddContent = dd[2];
      const urlMatch = ddContent.match(/href\s*=\s*["']([^"']+)["']/);
      if (!urlMatch) continue;
      const url = normalize(urlMatch[1]);
      if (!url || !/\/www\.autohome\.com\.cn\/news\/\d{6}\/\d+\.html/.test(url)) continue;

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

      const timeMatch = url.match(/\/(\d{4})(\d{2})\/(\d{2})\/\d+\.html/);
      const publishTime = timeMatch
        ? timeMatch[1] + '-' + timeMatch[2] + '-' + timeMatch[3] + 'T00:00:00.000Z'
        : (() => {
            const monthOnly = url.match(/\/(\d{4})(\d{2})\/\d+\.html/);
            return monthOnly ? monthOnly[1] + '-' + monthOnly[2] + '-01T00:00:00.000Z' : null;
          })();

      articles.push({ url, source: 'autohome', category: catName, title, coverImage, publishTime });
    }
  }

  return articles;
}

// ─── DONGCHEDI ───────────────────────────────────────────────────────────────
// 文章卡片 <a href="/article/ID" title="标题">...<img src="cover"/>
// og:title 在 <head>，需全局搜索后再关联
function parseDongchedi(html, catName, ogTitleMap) {
  const articles = [];
  const seen = new Set();

  // 收集所有文章路径及其在 HTML 中的起始位置
  const hrefPositions = [];
  const hrefRe = /href\s*=\s*["'](\/article\/\d+)["']/gi;
  let hm;
  while ((hm = hrefRe.exec(html)) !== null) {
    hrefPositions.push({ urlPath: hm[1], start: hm.index });
  }

  for (const { urlPath, start } of hrefPositions) {
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);

    // 取该 <a> 标签的完整内容（向前 100，向后 1500 字符，足够覆盖图片和标题属性）
    const anchorStart = Math.max(0, start - 100);
    const anchorEnd = Math.min(html.length, start + 1500);
    const anchorBlock = html.substring(anchorStart, anchorEnd);

    // 标题优先从 <a title="..."> 属性读取，其次查全局 OG title map
    let title = null;
    const anchorTitleMatch = anchorBlock.match(/<a[^>]+title\s*=\s*["']([^"']{3,100})["']/i);
    if (anchorTitleMatch) title = anchorTitleMatch[1].trim();
    if (!title) title = findOgTitle(ogTitleMap, urlPath);

    // 封面图：优先找 p3-dcd-sign.byteimg.com / p9-dcd-sign.byteimg.com
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
      publishTime: null, // ID 形式，无法从 URL 推断时间
    });
  }

  return articles;
}

// ─── YICHE ───────────────────────────────────────────────────────────────────
// 文章路径 /分类/YYYYMMDD/ID.html，og:title 在 <head>，封面图在 data-src（懒加载）
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

    // 标题：优先 <a title="...">，其次全局 OG title map
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

    // 封面图：data-src（懒加载）优先，其次 src
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

const sites = [
  {
    name: 'autohome',
    categories: [
      { name: '最新',     url: 'https://www.autohome.com.cn/all/' },
      { name: '新闻',     url: 'https://www.autohome.com.cn/news/' },
      { name: '咨询',     url: 'https://www.autohome.com.cn/advice/' },
      { name: '试驾',     url: 'https://www.autohome.com.cn/drive/' },
      { name: '用车',     url: 'https://www.autohome.com.cn/use/' },
      { name: '文化',     url: 'https://www.autohome.com.cn/culture/' },
      { name: '科技',     url: 'https://www.autohome.com.cn/tech/' },
      { name: '改装',     url: 'https://www.autohome.com.cn/tuning/' },
      { name: '新能源',   url: 'https://www.autohome.com.cn/ev/' },
      { name: '行业',     url: 'https://www.autohome.com.cn/hangye/list/' },
      { name: '新车',     url: 'https://www.autohome.com.cn/newbrand/' },
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
      { name: '评测',     url: 'https://news.yiche.com/pingce/' },
      { name: '导购',     url: 'https://news.yiche.com/daogou/' },
      { name: '综合新闻', url: 'https://news.yiche.com/zonghexinwen/' },
      { name: '新车消息', url: 'https://news.yiche.com/xinchexiaoxi/' },
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

        // 预处理：建立全局 OG title 映射（用于懂车帝和易车）
        const ogTitleMap = extractOgTitleMap(html);

        // 调用对应平台的解析函数
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
    outputPath: 'D:\\OneDrive\\自学编程\\claude code\\work\\hot-articles.json',
    articles: allArticles,
  };

  fs.writeFileSync('D:\\OneDrive\\自学编程\\claude code\\work\\hot-articles.json',
    JSON.stringify(result, null, 2), 'utf8');

  console.log('\n=== 完成 ===');
  console.log('总计: ' + allArticles.length + ' 条');
  console.log('有标题: ' + allArticles.filter(a => a.title).length);
  console.log('有封面: ' + allArticles.filter(a => a.coverImage).length);
  console.log('有时间: ' + allArticles.filter(a => a.publishTime).length);
  console.log('\n各源示例:');
  for (const src of ['autohome', 'dongchedi', 'yiche']) {
    const a = allArticles.find(x => x.source === src && x.title && x.coverImage);
    if (a) console.log('  ' + src + ':', JSON.stringify(a, null, 2));
  }
}

main().catch(console.log);
