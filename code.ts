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
  // 矢量本体几何中心在导出 PNG(@3x)的像素坐标；含阴影/模糊外扩时供导入端精确对齐本体，替代不可靠的 alpha 扫描
  const vectorBodyCenter: Map<string, [number, number]> = new Map();
  const fontRefs: Map<string, { family: string, style: string }> = new Map();

  for (const node of selection) {
    const parsed = await parseNode(node, imageRefs, vectorRefs, fontRefs, vectorBodyCenter);
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

  // 矢量本体中心（PNG @3x 像素）：含阴影/模糊外扩的矢量，记录本体几何框在导出 PNG 中的精确中心
  const vectorBodyCenterOut: { [key: string]: number[] } = {};
  for (const [nodeId, center] of vectorBodyCenter) {
    vectorBodyCenterOut[nodeId] = center;
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
    vectorBodyCenter: vectorBodyCenterOut,
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
  fontRefs: Map<string, { family: string, style: string }>,
  vectorBodyCenter: Map<string, [number, number]>
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

  // 获取绝对位置：导出 absoluteTransform 平移分量（节点本地原点的页面坐标）。
  // 这是 Figma 最原始的几何量，也是导入端按 rotation 计算位置的正确输入。
  // 非旋转节点本地原点 == AABB 左上角，行为不变。
  if ('absoluteTransform' in node && node.absoluteTransform) {
    const transform = node.absoluteTransform;
    base.absoluteX = transform[0][2];
    base.absoluteY = transform[1][2];
  }
  // 补存完整变换矩阵(原始数据)：线性部分 [[m00,m01],[m10,m11]] 含翻转(det<0)。
  // rotation 标量 = atan2(-m10, m00) 无法区分翻转与旋转，导入端须用完整矩阵算几何中心。
  if ('relativeTransform' in node && node.relativeTransform) {
    base.relativeTransform = node.relativeTransform;
  }

  // GROUP 自身无几何尺寸：用 absoluteRenderBounds 补 width/height（原始 API）。
  // absoluteX/Y 已由上面的 absoluteTransform 提供（本地原点），x/y 保持原始相对值。
  if (node.type === 'GROUP' && (node as any).children && (node as any).children.length > 0) {
    const bounds = (node as any).absoluteRenderBounds;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      base.width = bounds.width;
      base.height = bounds.height;
    }
  }

  const vectorTypes = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON'];

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
    const _parent = (node as any).parent;
    const _isOperand = _parent && _parent.type === 'BOOLEAN_OPERATION';
    // mask 在 Figma 中只贡献裁剪形状、自身填充不渲染；导入端 mask 为透明裁剪 Control，无需可视填充。
    // 操作数子节点视觉已烘焙进父 BOOLEAN_OPERATION。两者均跳过导出。
    const _isMask = (node as any).isMask === true;
    if (!_isOperand && !_isMask) {
      const preferPng = _vectorNeedsPng(node);
      let exported = false;
      if (!preferPng) {
        try {
          const svgBytes = await node.exportAsync({ format: 'SVG' });
          const svgText = uint8ToUtf8(svgBytes);
          const hasVector = /<(?:path|circle|ellipse|rect|polygon|polyline|line|use)\b/.test(svgText);
          if (!hasVector || svgText.includes('<foreignObject')) {
            throw new Error('SVG has no vector content');
          }
          vectorRefs.set(node.id, svgText);
          exported = true;
        } catch (e) {
          console.error('Failed to export vector as SVG, will try PNG:', e);
        }
      }
      if (!exported) {
        try {
          const pngBytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 3 } });
          // 解析 PNG IHDR(width@16,height@20,大端)，丢弃空节点导出失败的 1×1 占位
          if (pngBytes.length >= 24) {
            const _dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + 16, 8);
            if (_dv.getUint32(0) >= 2 && _dv.getUint32(4) >= 2) {
              vectorRefs.set(node.id, 'PNG:' + uint8ArrayToBase64(pngBytes));
              exported = true;
              // 记录本体几何中心在导出 PNG(@3x)的像素坐标：PNG 范围 == absoluteRenderBounds(含阴影/模糊外扩)，
              // 本体框 absoluteBoundingBox 在其中的中心 = (bb.center - rb.topleft) * 3。
              // 导入端用此精确对齐本体，避开半透明/渐变本体下 alpha 扫描失准导致的位移。
              const _rb: any = (node as any).absoluteRenderBounds;
              const _bb: any = (node as any).absoluteBoundingBox;
              if (_rb && _bb && typeof _rb.x === 'number' && typeof _bb.x === 'number' && typeof _bb.width === 'number') {
                vectorBodyCenter.set(node.id, [
                  (_bb.x + _bb.width / 2 - _rb.x) * 3,
                  (_bb.y + _bb.height / 2 - _rb.y) * 3
                ]);
              }
            } else {
              console.error('Vector PNG is 1x1 placeholder, skipped:', node.id);
            }
          }
        } catch (e2) {
          console.error('Failed to export vector as PNG:', e2);
        }
      }
    }
  }

  // 处理裁剪
  if ('clipsContent' in node) {
    base.clipsContent = node.clipsContent;
  }

  // 蒙版标记（原始数据）：mask 形状遮罩同层级后续兄弟，导入端据此重组树实现裁剪
  if ('isMask' in node) {
    base.isMask = node.isMask;
  }

  // 递归处理子节点
  if ('children' in node) {
    base.children = [];
    for (const child of node.children) {
      const parsed = await parseNode(child, imageRefs, vectorRefs, fontRefs, vectorBodyCenter);
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

// 矢量智能选择 PNG vs SVG：带阴影/模糊/渐变/布尔运算 → Figma PNG（清晰+保真）；简单实心 → SVG（小）。
function _vectorNeedsPng(node: SceneNode): boolean {
  if (node.type === 'BOOLEAN_OPERATION') return true;
  const effects = (node as any).effects;
  if (Array.isArray(effects)) {
    for (const e of effects) {
      if (e.visible === false) continue;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ||
          e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return true;
    }
  }
  const fills = (node as any).fills;
  if (Array.isArray(fills)) {
    for (const f of fills) {
      if (f.visible === false) continue;
      if (typeof f.type === 'string' && f.type.indexOf('GRADIENT_') === 0) return true;
    }
  }
  return false;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return (globalThis as any).btoa(binary);
}
