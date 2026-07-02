# Figma Exporter Plugin

Figma 插件，将设计稿（含原型 reactions）导出为 JSON，供 [figma-to-godot](https://github.com/TTing-123/figma-to-godot) 导入。

## 使用

1. Figma 中 **Plugins > Development > Import plugin from manifest...**，选择 `manifest.json`
2. 切换到含原型 Frame 的页面
3. 运行插件，点击 Export → 导出**整页所有顶层 Frame + 原型连线**为 JSON

## JSON 格式

- `nodes` — 节点树（坐标/样式/效果/文本）
- `images` / `vectors` — 图片与矢量资源（Base64 PNG；矢量 SVG→PNG@3x）
- `reactions` — 原型连线平表（sourceId / destinationId / trigger / transition，含 overlayRelativePosition / keyCodes / url）
- `vectorBodyCenter` / `vectorBodyAbsCenter` — 矢量本体中心（导入端精确对齐）
- `maskRenderBounds` — 遮罩几何范围
- `fonts` — 字体引用

## 开发

```bash
npm install
npm run build   # tsc 编译 code.ts → code.js
```

`code.js` 是构建产物（`.gitignore` 忽略），改 `code.ts` 后需重新 build。

## 关联项目

- [figma-to-godot](https://github.com/TTing-123/figma-to-godot) — Godot 端导入插件
