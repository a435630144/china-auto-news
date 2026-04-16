# Auto News Crawler

汽车资讯文章爬虫，抓取**汽车之家**、**懂车帝**、**易车**三大平台的热文列表，支持标题、封面图、发布时间、分类信息，输出 JSON 文件。

---

## 技术栈

- **Node.js**（原生模块，无外部爬虫框架）
- **https** — HTTP 请求
- **zlib** — gzip / brotli 解压（这些平台默认返回压缩内容）
- **iconv-lite** — GBK → UTF8 编码转换（汽车之家使用 GBK）
- **fs** — 文件写入

---

## 快速开始

```bash
npm install
# 本地模式（默认）- 输出到 ./hot-articles.json
npm start

# 在线模式 - 输出到 MySQL 数据库（需要配置 .env）
npm run start:online
```

> 配置数据库：在 `.env` 文件中设置 `DB_TYPE`、`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`

---

## 支持的平台与分类

### 汽车之家（autohome.com.cn）

| 分类 | URL |
|------|-----|
| 最新 | autohome.com.cn/all/ |
| 新闻 | autohome.com.cn/news/ |
| 咨询 | autohome.com.cn/advice/ |
| 试驾 | autohome.com.cn/drive/ |
| 用车 | autohome.com.cn/use/ |
| 文化 | autohome.com.cn/culture/ |
| 科技 | autohome.com.cn/tech/ |
| 改装 | autohome.com.cn/tuning/ |
| 新能源 | autohome.com.cn/ev/ |
| 行业 | autohome.com.cn/hangye/list/ |
| 新车 | autohome.com.cn/newbrand/ |

### 懂车帝（dongchedi.com）

| 分类 | URL |
|------|-----|
| 最新 | dongchedi.com/news |
| 新车 | dongchedi.com/news/newcar |
| 行业 | dongchedi.com/news/industry |
| 导购 | dongchedi.com/news/guide |
| 评测 | dongchedi.com/news/review |
| 用车 | dongchedi.com/news/usage |
| 文化 | dongchedi.com/news/culture |
| 二手车 | dongchedi.com/news/used |

### 易车（news.yiche.com）

| 分类 | URL |
|------|-----|
| 最新 | news.yiche.com/ |
| 新车 | news.yiche.com/xinche/ |
| 评测 | news.yiche.com/pingce/ |
| 导购 | news.yiche.com/daogou/ |
| 综合新闻 | news.yiche.com/zonghexinwen/ |
| 新车消息 | news.yiche.com/xinchexiaoxi/ |

---

## 输出格式

### 本地模式（默认）

```json
{
  "timestamp": "2026-04-16T04:53:00.000Z",
  "total": 247,
  "stats": {
    "autohome": { "total": 89, "categories": { ... } },
    "dongchedi": { "total": 98, "categories": { ... } },
    "yiche": { "total": 60, "categories": { ... } }
  },
  "articles": [...]
}
```

### 在线模式（`npm run start:online`）

数据写入 MySQL `auto_news` 表（需提前配置 `.env`），表结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | BIGINT | 主键 |
| `url` | VARCHAR(512) | 文章链接（唯一索引） |
| `title` | VARCHAR(512) | 标题 |
| `source` | VARCHAR(32) | 来源 autohome / dongchedi / yiche |
| `category` | VARCHAR(64) | 分类名称 |
| `cover_image` | VARCHAR(1024) | 封面图 URL |
| `publish_time` | DATETIME | 发布时间 |
| `created_at` | DATETIME | 入库时间 |

```json
[
  {
    "url": "https://www.autohome.com.cn/news/202604/1313579.html",
    "title": "吉利全新SUV曝光，或售12万起",
    "source": "autohome",
    "category": "新闻",
    "coverImage": "https://www.autoimg.cn/xxx.jpg",
    "publishTime": "2026-04-15T00:00:00.000Z"
  },
  {
    "url": "https://www.dongchedi.com/article/7628641165520142872",
    "title": "比亚迪海豹DM-i实拍图赏",
    "source": "dongchedi",
    "category": "新车",
    "coverImage": "https://p9-dcd-sign.byteimg.com/xxx.jpg",
    "publishTime": null
  },
  {
    "url": "https://news.yiche.com/xinche/20260415/12109131664.html",
    "title": "小米汽车二季度交付量预计翻倍",
    "source": "yiche",
    "category": "新车",
    "coverImage": "https://img.bitautoimg.com/xxx.jpg",
    "publishTime": "2026-04-15T00:00:00.000Z"
  }
]
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `url` | string | 文章链接 |
| `title` | string\|null | 标题，从列表页 `<a title>` 或 `og:title` 获取 |
| `source` | string | 来源平台：`autohome` / `dongchedi` / `yiche` |
| `category` | string | 列表页所属分类名称 |
| `coverImage` | string\|null | 封面图 URL |
| `publishTime` | string\|null | 发布时间（ISO 8601），汽车之家和易车可从 URL 路径日期推断，懂车帝为 null |

---

## 实现细节

### 编码处理

汽车之家返回 **GBK** 编码（`Content-Type: text/html; charset=gb2312`），其他两家为 UTF8。`smartDecode()` 自动识别 `Content-Type` header 和 HTML 中的 `<meta charset>`，分别走 iconv 或直接 UTF8 解码。

### 压缩处理

三家平台均启用 **gzip / brotli** 压缩，`Accept-Encoding: gzip, deflate, br` 随请求发出，服务端返回压缩流，客户端自动解压后再解码。

### 标题提取

- **汽车之家**：列表页 `<li data-artidanchor>` 内嵌 `<h3>` 标签，直接正则匹配
- **懂车帝**：`<a title="...">` 属性，fallback 到全局 `og:title`（在 `<head>` 中）
- **易车**：同懂车帝，优先 `<a title>`，其次 `og:title`，再 fallback 到 `<h3/h4>`

### 封面图提取

- **汽车之家**：列表页 `<img src="...">` 内直接可见
- **懂车帝**：懒加载，图片 URL 形如 `p9-dcd-sign.byteimg.com`，从 `<a>` 标签周围 1500 字符内查找
- **易车**：`data-src` 懒加载属性，fallback 到 `<img src>` 中含 `bitautoimg` 或 `yiche.com` 的地址

### 时间提取

- **汽车之家**：URL 路径含 `/202604/15/`，精确到日
- **懂车帝**：文章 ID 无法推断时间，`publishTime` 为 `null`
- **易车**：URL 路径含 `/20260415/`，精确到日

---

## 已知局限

- **懂车帝无时间**：懂车帝文章 URL 为 `/article/{数字ID}`，无法从中推断发布日期
- **懂车帝标题依赖页面结构**：若网站改版 `<a title>` 属性丢失，只能靠 `og:title`（需要在列表页注入）
- **易车懒加载图**：部分占位图含 `loading` / `blank` 关键字，已过滤但无法保证 100%
- **同一文章多分类出现**：会在 `stats` 中重复计数，已做 URL 去重，最终 `total` 为去重后数量

---

## 文件结构

```
├── crawl_v4.js        # 主爬虫脚本（使用此文件）
├── hot-articles.json # 爬取结果（运行后自动生成）
├── README.md          # 本文档
└── package.json       # 依赖声明（iconv-lite ^0.7.2）
```
