# j-ai-kit

[English](./README.md) | 中文

PichurChill 的 AI 工具集 monorepo——MCP server、skill 以及其他 AI 小工具。`packages/` 下的每个目录都是独立的 npm 包,拥有独立版本与 CHANGELOG,在各包目录内单独发布。

各包的中文文档见包内 `README.zh-CN.md`。

## 包列表

| 包 | npm | 说明 |
|:---|:---|:---|
| [`packages/j-agy-mcp`](./packages/j-agy-mcp) | [j-agy-mcp](https://www.npmjs.com/package/j-agy-mcp) | 把 Antigravity CLI(`agy`)包装为 MCP 工具——将探索、检索或编码任务派发给 AGY 作为外部子代理,附搜索/识图/编码三种可直接复制的 AGENTS.md 预设 |
| [`packages/j-can-see`](./packages/j-can-see) | [j-can-see](https://www.npmjs.com/package/j-can-see) | 给纯文本 AI 编码代理的视觉工具集:识图/OCR、按像素坐标定位元素、图像差异对比、精确取色、图形矢量化 |

## 仓库结构

```
packages/   # 独立 npm 包(一个目录 = 一个包)
skills/     # agent skill,不发布 npm(陆续添加)
```

## 开发

```bash
npm install        # 安装全部 workspace
npm test           # 跑所有包的测试套件
```
