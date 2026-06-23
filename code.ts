// Figma Exporter for Godot - 核心逻辑
// 运行在 Figma 沙箱中

// 显示 UI
figma.showUI(__html__, { width: 320, height: 240 });

// 监听 UI 消息
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export') {
    await handleExport();
  }
  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

// 主导出函数
async function handleExport() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    figma.ui.postMessage({
      type: 'error',
      message: '请先选中一个节点'
    });
    return;
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在解析节点...',
    percent: 10
  });

  // 解析选中的节点
  const nodes: any[] = [];
  const imageRefs: Map<string, Uint8Array> = new Map();
  const vectorRefs: Map<string, string> = new Map();
  const fontRefs: Map<string, { family: string, style: string }> = new Map();

  for (const node of selection) {
    const parsed = await parseNode(node, imageRefs, vectorRefs, fontRefs);
    if (parsed) {
      nodes.push(parsed);
    }
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在导出图片...',
    percent: 50
  });

  // 导出图片资源
  const images: { [key: string]: string } = {};
  for (const [ref, bytes] of imageRefs) {
    const base64 = uint8ArrayToBase64(bytes);
    images[ref] = base64;
  }

  // 导出矢量图形��SVG 字符串）
  const vectors: { [key: string]: string } = {};
  for (const [nodeId, svgText] of vectorRefs) {
    vectors[nodeId] = svgText;
  }

  // 构建字体列表
  const fonts: { [key: string]: { family: string, style: string } } = {};
  for (const [key, fontInfo] of fontRefs) {
    fonts[key] = fontInfo;
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在打包...',
    percent: 90
  });

  // 构建导出数据
  const exportData = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    figmaFile: figma.fileKey || 'unknown',
    nodes: nodes,
    images: images,
    vectors: vectors,
    fonts: fonts
  };

  // 发送到 UI 进行下载
  figma.ui.postMessage({
    type: 'download',
    data: JSON.stringify(exportData, null, 2),
    filename: 'figma_export.json'
  });

  figma.ui.postMessage({
    type: 'progress',
    message: '导出完成！',
    percent: 100
  });
}

// 解析节点
async function parseNode(
  node: SceneNode,
  imageRefs: Map<string, Uint8Array>,
  vectorRefs: Map<string, string>,
  fontRefs: Map<string, { family: string, style: string }>
): Promise<any> {
  const base: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    opacity: 'opacity' in node ? node.opacity : 1,
    rotation: 'rotation' in node ? node.rotation : 0,
    x: 'x' in node ? node.x : 0,
    y: 'y' in node ? node.y : 0,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
  };

  // 获取��对位置
  // absoluteTransform.translation 是节点「本地原点(0,0)」的页面坐标，对旋转节点
  // 它落在 bbox 某个角（-90° 时在左下角），与 Figma UI 显示的 Position（AABB
  // 左上角）不一致——这正是 Vector 40 的 Y 比图上差一个高度(28.44)的原因。
  // 改用 absoluteBoundingBox 左上角，与 Figma UI 的 X/Y 一致；无旋转时
  // 本地原点 == bbox 左上角，非旋转节点行为不变。
  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) {
    base.absoluteX = node.absoluteBoundingBox.x;
    base.absoluteY = node.absoluteBoundingBox.y;
  } else if ('absoluteTransform' in node) {
    const transform = node.absoluteTransform;
    base.absoluteX = transform[0][2];
    base.absoluteY = transform[1][2];
  }

  // GROUP 特殊处理：Figma Plugin API 返回的 GROUP.x/y/width/height 可能不是
  // UI 显示的真实 bbox（被旋转/变形过的 GROUP 其 transform.translation 不对应
  // bbox.top-left）。用 absoluteRenderBounds 覆盖，让 JSON 中的数据与 Figma UI
  // 显示的 X/Y/W/H 一致。
  if (node.type === 'GROUP' && (node as any).children && (node as any).children.length > 0) {
    const bounds = (node as any).absoluteRenderBounds;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      base.absoluteX = bounds.x;
      base.absoluteY = bounds.y;
      base.width = bounds.width;
      base.height = bounds.height;
      const parent = (node as any).parent;
      if (parent && parent.type !== 'PAGE' && 'absoluteTransform' in parent) {
        const pt = parent.absoluteTransform;
        base.x = bounds.x - pt[0][2];
        base.y = bounds.y - pt[1][2];
      } else {
        base.x = bounds.x;
        base.y = bounds.y;
      }
    }
  }

  // VECTOR 特殊处理：SVG 栅格化后是否含旋转待验证（见导入端）。
  // 暂按「SVG 已烘焙旋转」假设：JSON 里 rotation 设为 0，width/height 改为 AABB 尺寸。
  // 若验证发现 SVG 未旋转，需删此块并在导入端恢复 rotation 处理。
  const vectorTypes = ['VECTOR', 'BOOLEAN', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON'];
  if (vectorTypes.includes(node.type) && base.rotation !== 0) {
    const rot = base.rotation % 360;
    // ±90°: AABB 宽高对换
    if (Math.abs(Math.abs(rot) - 90) < 0.01 || Math.abs(Math.abs(rot) - 270) < 0.01) {
      const tmp = base.width;
      base.width = base.height;
      base.height = tmp;
    }
    base.rotation = 0;
  }

  // 处理自动布局
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    base.layoutMode = node.layoutMode;
    base.itemSpacing = 'itemSpacing' in node ? node.itemSpacing : 0;
    base.paddingLeft = 'paddingLeft' in node ? node.paddingLeft : 0;
    base.paddingRight = 'paddingRight' in node ? node.paddingRight : 0;
    base.paddingTop = 'paddingTop' in node ? node.paddingTop : 0;
    base.paddingBottom = 'paddingBottom' in node ? node.paddingBottom : 0;
    base.primaryAxisAlignItems = 'primaryAxisAlignItems' in node ? node.primaryAxisAlignItems : 'MIN';
    base.counterAxisAlignItems = 'counterAxisAlignItems' in node ? node.counterAxisAlignItems : 'MIN';
  }

  // 处理圆角
  if ('cornerRadius' in node) {
    base.cornerRadius = node.cornerRadius;
  }
  if ('topLeftRadius' in node) {
    base.topLeftRadius = node.topLeftRadius;
    base.topRightRadius = node.topRightRadius;
    base.bottomLeftRadius = node.bottomLeftRadius;
    base.bottomRightRadius = node.bottomRightRadius;
  }

  // 处理填充
  if ('fills' in node && Array.isArray(node.fills)) {
    base.fills = [];
    for (const fill of node.fills) {
      if (fill.visible === false) continue;
      const fillData: any = { type: fill.type };

      if (fill.type === 'SOLID') {
        fillData.color = {
          r: fill.color.r,
          g: fill.color.g,
          b: fill.color.b,
          a: fill.opacity !== undefined ? fill.opacity : 1
        };
      }

      if (fill.type === 'IMAGE' && 'imageHash' in fill) {
        fillData.imageRef = fill.imageHash;
        // 导出原始图片位图（而非节点渲染截图，避免被圆角/叠加填充裁切）
        if (!imageRefs.has(fill.imageHash)) {
          try {
            const image = figma.getImageByHash(fill.imageHash);
            if (image) {
              const bytes = await image.getBytesAsync();
              imageRefs.set(fill.imageHash, bytes);
            }
          } catch (e) {
            console.error('Failed to export image:', e);
          }
        }
      }

      if (fill.type?.startsWith('GRADIENT_')) {
        fillData.gradientType = fill.type; // GRADIENT_LINEAR / GRADIENT_RADIAL / GRADIENT_ANGULAR / GRADIENT_DIAMOND
        fillData.gradientStops = fill.gradientStops?.map((stop: any) => ({
          position: stop.position,
          color: {
            r: stop.color.r,
            g: stop.color.g,
            b: stop.color.b,
            a: stop.color.a
          }
        }));
        fillData.gradientTransform = fill.gradientTransform;
      }

      base.fills.push(fillData);
    }
  }

  // 处理描边
  if ('strokes' in node && Array.isArray(node.strokes)) {
    base.strokes = [];
    for (const stroke of node.strokes) {
      if (stroke.visible === false) continue;
      if (stroke.type === 'SOLID') {
        base.strokes.push({
          type: 'SOLID',
          color: {
            r: stroke.color.r,
            g: stroke.color.g,
            b: stroke.color.b,
            a: stroke.opacity !== undefined ? stroke.opacity : 1
          }
        });
      }
    }
  }

  if ('strokeWeight' in node) {
    base.strokeWeight = typeof node.strokeWeight === 'number' ? node.strokeWeight : 0;
  }

  // 处理效果（阴影等）
  if ('effects' in node && Array.isArray(node.effects)) {
    base.effects = [];
    for (const effect of node.effects) {
      if (effect.visible === false) continue;
      const effectData: any = { type: effect.type };

      if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
        effectData.color = {
          r: effect.color.r,
          g: effect.color.g,
          b: effect.color.b,
          a: effect.color.a
        };
        effectData.offset = effect.offset;
        effectData.radius = effect.radius;
        effectData.spread = effect.spread;
      }

      if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
        effectData.radius = effect.radius;
      }

      base.effects.push(effectData);
    }
  }

  // 处理文本
  if (node.type === 'TEXT') {
    base.characters = node.characters;

    // 获取字体信息
    const fontFamily = node.fontName !== figma.mixed ? (node.fontName as FontName).family : '';
    const fontWeight = node.fontName !== figma.mixed ? (node.fontName as FontName).style : '';

    base.style = {
      fontFamily: fontFamily,
      fontWeight: fontWeight,
      fontSize: node.fontSize !== figma.mixed ? node.fontSize : 16,
      lineHeight: node.lineHeight !== figma.mixed ? node.lineHeight : null,
      letterSpacing: node.letterSpacing !== figma.mixed ? node.letterSpacing : null,
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
    };

    // 文本行为属性（影响尺寸和溢出）
    base.textAutoResize = node.textAutoResize;  // NONE | WIDTH_AND_HEIGHT | HEIGHT | TRUNCATE
    base.textDecoration = node.textDecoration !== figma.mixed ? node.textDecoration : 'NONE';
    base.textCase = node.textCase !== figma.mixed ? node.textCase : 'ORIGINAL';

    // 收集字体信息
    if (fontFamily && fontWeight) {
      const fontKey = `${fontFamily}_${fontWeight}`;
      if (!fontRefs.has(fontKey)) {
        fontRefs.set(fontKey, { family: fontFamily, style: fontWeight });
      }
    }

    // 文本节点保持为 Label（由导入端还原字体/字号/颜色），不再导出为 PNG
    // —— 旧逻辑会导出 3x PNG，但导入端会跳过 TEXT，纯属浪费体积与时间。
  }

  // 处理矢量节点 - 导出为 SVG（含完整路径数据，不被 bounding box 裁剪）
  if (vectorTypes.includes(node.type)) {
    try {
      // SVG 是 UTF-8 文本，exportAsync ��回 Uint8Array
      const svgBytes = await node.exportAsync({ format: 'SVG' });
      const svgText = uint8ToUtf8(svgBytes);
      vectorRefs.set(node.id, svgText);
    } catch (e) {
      console.error('Failed to export vector as SVG:', e);
    }
  }

  // 处理裁剪
  if ('clipsContent' in node) {
    base.clipsContent = node.clipsContent;
  }

  // 递归处理子节点
  if ('children' in node) {
    base.children = [];
    for (const child of node.children) {
      const parsed = await parseNode(child, imageRefs, vectorRefs, fontRefs);
      if (parsed) {
        base.children.push(parsed);
      }
    }
  }

  return base;
}

// 工具函数：Uint8Array 转 Base64
// 工具函数：Uint8Array(UTF-8) 转字符串（Figma 沙箱无 TextDecoder）
function uint8ToUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length;) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
    } else if (b1 < 0xE0) {
      const b2 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x1F) << 6) | (b2 & 0x3F));
    } else if (b1 < 0xF0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      result += String.fromCharCode(((b1 & 0x0F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F));
    } else {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3F) << 12) | ((b3 & 0x3F) << 6) | (b4 & 0x3F);
      const adj = cp - 0x10000;
      result += String.fromCharCode(0xD800 | (adj >> 10), 0xDC00 | (adj & 0x3FF));
    }
  }
  return result;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return (globalThis as any).btoa(binary);
}
