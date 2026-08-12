# 知识之海 (The Sea of Knowledge)

> 轻量级知识管理工具，支持思维导图可视化、云端同步的知识点管理系统。

## ✨ 功能

- **知识点管理** — 创建、查看、编辑、删除知识点，支持 Markdown 正文和 LaTeX 数学公式
- **双向关联** — 每个知识点可以设置"前相关知识"和"后相关知识"，自动建立双向链接
- **思维导图** — 三种模式可视化知识点网络：
  - 🔗 后延式 — 沿后相关方向展开
  - 🔄 周围式 — 显示前后各 N 层
  - 🎛 自由式 — 自定义前后层数
- **图片支持** — 知识点可附带图片，统一管理
- **云端同步** — HTTP API + Basic Auth，支持上传/下载整个知识库
- **公式渲染** — KaTeX 渲染 `$...$` 和 `$$...$$` 格式的 LaTeX 公式

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) ≥ 16

### 安装

```bash
git clone https://github.com/musouboshiasa/zhi-shi-zhi-hai-si-wei-dao-tu.git
cd zhi-shi-zhi-hai-si-wei-dao-tu
npm install
```

### 启动

```bash
node server.js
```

浏览器打开 `http://localhost:3000`

或双击运行 `启动软件.bat`

### 部署到服务器（网页版）

支持两种方式：
- **独立域名部署**：`https://musouboshiasa.com`（见 `deploy/nginx.conf`）
- **子路径部署**：与现有网站/网盘共存，`https://musouboshiasa.com/ruanjian/`（见 `deploy/nginx-子路径.conf` 和 `deploy/服务器部署指南.md`）

详细步骤见 `deploy/服务器部署指南.md`

## 📖 使用指南

### 创建知识点

点击"新建知识点"，填写：
- **编号**：唯一标识，支持层级编号（如 `1-2-1`），用 `-` 分隔
- **名称**：知识点名称（可含 `/`、中文等特殊字符）
- **正文**：Markdown 格式，支持 LaTeX 公式

### 编辑关系

在知识点编辑页面：
- **前相关知识** — 指向当前知识点的基础/前期知识
- **后相关知识** — 当前知识点引出的后续/扩展知识

关联规则：若 A 是 B 的前相关知识，则 B 自动成为 A 的后相关知识。

### 思维导图

在知识点查看页面点击"思维导图"，选择模式即可。

### 云端同步

1. 按 `软件使用与迁移指南.md` 在阿里云或其他服务器部署云端 API
2. 在软件中配置云端地址
3. 点击"上传到云端" / "从云端下载"

## 💻 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | 原生 HTML/CSS/JS + Canvas |
| 公式 | KaTeX (CDN) |
| Markdown | marked.js (CDN) |
| 打包 | archiver + extract-zip |

## 📁 文件格式

知识点文件储存在 `知识点库/储存文件/`，文件名格式：`编号：名称.md`

每个文件结构：
```
（（编号区））
编号
（（名称区））
名称
（（正文区））
Markdown 正文
（（前相关区））
- 编号：关系：名称
（（后相关区））
- 编号：关系：名称
（（结束））
```

## 📝 License

MIT
