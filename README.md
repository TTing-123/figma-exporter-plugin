# Figma Exporter Plugin

Figma Plugin API 插件，将设计稿导出为 JSON 格式，供 [figma-to-godot](https://github.com/TTing-123/figma-to-godot) 导入插件使用。

## 使用方法

1. 在 Figma 中打开 **Plugins > Development > Import plugin from manifest...**
2. 选择 `manifest.json`
3. 运行插件，选中要导出的节点
4. 导出的 JSON 文件自动下载

## JSON 格式

导出的 JSON 包含：
- `nodes` — 节点树形结构（含坐标、样式、效果）
- `images` — 图片资源（Base64）
- `vectors` — 矢量资源（Base64 PNG）
