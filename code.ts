// Figma Exporter for Godot - 核心逻辑
// 运行在 Figma 沙箱中

// 显示 UI
figma.showUI(__html__, { width: 320, height: 240 });
// 矢量/mask 导出诊断（临时）：记录每个矢量节点导出尝试结果，定位 mask PNG 失败根因
let _exportDiagnostics: any[] = [];

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
  _exportDiagnostics = [];

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
  // 矢量本体几何中心(全局绝对坐标 = absoluteBoundingBox.center)：所有矢量节点(SVG+PNG)统一记录，
  // 导入端据此精确定位本体中心(_cx=x+(absCx-node.absoluteX))，替代 relativeTransform+尺寸推算
  // (反射 VECTOR 路径在定义框内偏移每节点不同，width/height/SVG viewBox 均无法推算)。
  const vectorBodyAbsCenter: Map<string, [number, number]> = new Map();
  // mask 形状的 renderBounds(绝对 x,y,w,h)：mask 用 PNG 导出，PNG 范围=renderBounds(含描边/效果外扩)，
  // 导入端据此精确对齐 mask alpha 蒙版（PNG 像素范围对应此几何框）。
  const maskRenderBounds: Map<string, [number, number, number, number]> = new Map();
  const fontRefs: Map<string, { family: string, style: string }> = new Map();

  for (const node of selection) {
    const parsed = await parseNode(node, imageRefs, vectorRefs, fontRefs, vectorBodyCenter, vectorBodyAbsCenter, maskRenderBounds);
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

  // 矢量本体中心(全局绝对坐标)：导入端精确定位本体几何中心
  const vectorBodyAbsCenterOut: { [key: string]: number[] } = {};
  for (const [nodeId, center] of vectorBodyAbsCenter) {
    vectorBodyAbsCenterOut[nodeId] = center;
  }

  // mask renderBounds（绝对坐标）：导入端用于 mask alpha 蒙版 UV 对齐
  const maskRenderBoundsOut: { [key: string]: number[] } = {};
  for (const [nodeId, rb] of maskRenderBounds) {
    maskRenderBoundsOut[nodeId] = rb;
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
    vectorBodyAbsCenter: vectorBodyAbsCenterOut,
    maskRenderBounds: maskRenderBoundsOut,
    exportDiagnostics: _exportDiagnostics,
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
  vectorBodyCenter: Map<string, [number, number]>,
  vectorBodyAbsCenter: Map<string, [number, number]>,
  maskRenderBounds: Map<string, [number, number, number, number]>
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
        fillData.scaleMode = (fill as any).scaleMode;  // FILL(cover,默认)/FIT(contain)/CROP/TILE
        if ((fill as any).filters) { fillData.filters = (fill as any).filters; }
        if ((fill as any).scalingFactor !== undefined) { fillData.scalingFactor = (fill as any).scalingFactor; }  // TILE ƽر��������  // ImageFilters: exposure/contrast/saturation/temperature/tint/highlights/shadows (各 -1..1)
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
      } else if (stroke.type?.startsWith('GRADIENT_')) {
        // 渐变描边（GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND），与 fill 渐变处理对齐
        base.strokes.push({
          type: stroke.type,
          gradientStops: stroke.gradientStops?.map((stop: any) => ({
            position: stop.position,
            color: {
              r: stop.color.r,
              g: stop.color.g,
              b: stop.color.b,
              a: stop.color.a
            }
          })),
          gradientTransform: stroke.gradientTransform
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
    const _isMask = (node as any).isMask === true;
    // mask 形状用 PNG 导出：alpha 精确匹配 Figma 实际裁剪(填充+描边+效果)，SVG 的 viewBox 会裁掉描边外扩
    // 且不含效果，与 Figma 不一致。导入端 mask 节点为透明 Control，形状 PNG 供被遮罩节点 shader alpha 蒙版。
    // 操作数(BOOLEAN_OPERATION 子)视觉已烘焙进父，仍跳过。
    if (!_isOperand) {
      // 记录本体几何中心(全局 absoluteRenderBounds.center)：SVG+PNG 统一，导入端精确定位。
      // 必须用 renderBounds ��非 absoluteBoundingBox：VECTOR 的 absoluteBoundingBox 是"定义框"，
      // 路径可能不填满(2:704 定义框 10×15 / 路径 10×9；2:705 定义框 10×15 / 路径 5×5)，
      // 共享定义框的节点会��出相同中心(2:704/705/706 都=定义框中心)→导入端把不同部件钉在同一点。
      // renderBounds 是真实渲染范围(无效果时=路径 bbox)，中心每节点不同，定位准确。
      const _rbAbs: any = (node as any).absoluteRenderBounds;
      if (_rbAbs && typeof _rbAbs.x === 'number' && typeof _rbAbs.width === 'number') {
        vectorBodyAbsCenter.set(node.id, [_rbAbs.x + _rbAbs.width / 2, _rbAbs.y + _rbAbs.height / 2]);
      }
      let exported = false;
      // mask 形状单独导出：isMask 节��自身 exportAsync 是 1x1（不渲染自身），clone ���取消 mask 再导出
      if (_isMask) {
        const _ms = await _exportMaskShape(node);
        if (_ms) {
          vectorRefs.set(node.id, _ms.content);
          maskRenderBounds.set(node.id, _ms.rb);
          exported = true;
        }
      }
      const preferPng = _vectorNeedsPng(node);
      if (!exported && !preferPng) {
        try {
          const svgBytes = await node.exportAsync({ format: 'SVG' });
          const svgText = uint8ToUtf8(svgBytes);
          const hasVector = /<(?:path|circle|ellipse|rect|polygon|polyline|line|use)\b/.test(svgText);
          if (!hasVector || svgText.includes('<foreignObject')) {
            throw new Error('SVG has no vector content');
          }
          vectorRefs.set(node.id, svgText);
          _exportDiagnostics.push({ id: node.id, type: node.type, isMask: _isMask, kind: 'svg_ok' });
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
              _exportDiagnostics.push({ id: node.id, type: node.type, isMask: _isMask, kind: 'png_ok' });
              exported = true;
              // 记录本体几何中心在导出 PNG(@3x)的像素坐标：PNG 范围 == absoluteRenderBounds(含阴影/模糊外扩)。
              // 导入端据此把 rect 锚到 renderBounds 左上(_cx - rb.w/2 = rb.topleft)，rect=renderBounds 范围，
              // 纹理填满 rect，路径在纹理内位置由烘焙自然正确。用 renderBounds 中心(PNG 中心)而非定义框中心——
              // 定义框中心对"路径不填满定义框"的矢量会偏(定义框中心 ≠ 路径中心)，导致整体位移。
              const _rb: any = (node as any).absoluteRenderBounds;
              if (_rb && typeof _rb.x === 'number' && typeof _rb.width === 'number') {
                vectorBodyCenter.set(node.id, [_rb.width / 2 * 3, _rb.height / 2 * 3]);
              }
              // mask 形状 PNG 范围=renderBounds(含描边/效果外扩)；记录绝对坐标供��入端 UV 对齐
              if (_isMask && _rb && typeof _rb.x === 'number') {
                maskRenderBounds.set(node.id, [_rb.x, _rb.y, _rb.width, _rb.height]);
              }
            } else {
              console.error('Vector PNG is 1x1 placeholder, skipped:', node.id);
              _exportDiagnostics.push({ id: node.id, type: node.type, isMask: _isMask, kind: '1x1', w: _dv.getUint32(0), h: _dv.getUint32(4) });
            }
          }
        } catch (e2) {
          console.error('Failed to export vector as PNG:', e2);
          _exportDiagnostics.push({ id: node.id, type: node.type, isMask: _isMask, kind: 'png_error', err: String(e2) });
        }
      }
    }
  }

  // 处理裁剪
  // 非矢量类型 mask（RECTANGLE/FRAME 等）：自身 exportAsync 同样 1x1，clone 导出形状
  if (!vectorTypes.includes(node.type) && (node as any).isMask === true) {
    const _ms2 = await _exportMaskShape(node);
    if (_ms2) {
      vectorRefs.set(node.id, _ms2.content);
      maskRenderBounds.set(node.id, _ms2.rb);
    }
  }
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
      const parsed = await parseNode(child, imageRefs, vectorRefs, fontRefs, vectorBodyCenter, vectorBodyAbsCenter, maskRenderBounds);
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

async function _exportMaskShape(node: SceneNode): Promise<{ content: string; rb: [number, number, number, number]; format: string } | null> {
  // mask 节点 isMask=true ���身不渲染，node.exportAsync 返回 1x1。优先 clone+isMask=false 导 PNG(含描边/效果)；
  // clone 失败则回退 SVG(SVG 描述路径不受渲染状态影响，范围=boundingBox)。全程记录诊断供定位。
  const _id = (node as any).id;
  let _cloneReason = '';
  try {
    const clone = node.clone();
    (clone as any).isMask = false;
    // clone 放到 currentPage(无父级裁剪)导出：原 parent 链上的 clip frame 会裁 clone 的 exportAsync 与
    // absoluteRenderBounds（134×134 圆曾被裁成 43×125）。currentPage 无裁剪 → 形状完整。clone 在 page 的
    // 位置无关(exportAsync 导出节点自身)；rb.w/h 用 clone.absoluteRenderBounds(尺寸正确)，
    // rb.x/y 用原节点 absoluteTransform 平移分量(=本地原点画布坐标)；node.absoluteX/Y 对部分节点返回
    // undefined(实测所有 mask 烘出 [null,null,w,h]，导入端 float(null) 崩溃→material 没挂上)。clone 的
    // renderBounds.x/y 不随 appendChild 定位更新(曾读到 0,0)，不可用。
    const _tr = (node as any).absoluteTransform;
    const _absX = _tr ? _tr[0][2] : 0;
    const _absY = _tr ? _tr[1][2] : 0;
    figma.currentPage.appendChild(clone);
    const pngBytes = await clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 3 } });
    const _crb = (clone as any).absoluteRenderBounds;
    clone.remove();
    if (pngBytes.length < 24) { _cloneReason = 'png_small(' + pngBytes.length + ')'; }
    else {
      const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + 16, 8);
      const w = dv.getUint32(0), h = dv.getUint32(4);
      if (w < 2 || h < 2) { _cloneReason = 'png_1x1(' + w + 'x' + h + ')'; }
      else {
        if (!_crb || typeof _crb.x !== 'number') { _cloneReason = 'no_clone_rb'; }
        else {
          _exportDiagnostics.push({ id: _id, isMask: true, kind: 'mask_clone_png_ok' });
          return { content: 'PNG:' + uint8ArrayToBase64(pngBytes), rb: [_absX, _absY, _crb.width, _crb.height], format: 'png' };
        }
      }
    }
  } catch (e) {
    _cloneReason = 'err:' + String(e);
  }
  let _svgReason = '';
  try {
    const svgBytes = await node.exportAsync({ format: 'SVG' });
    const svgText = uint8ToUtf8(svgBytes);
    if (/<(?:path|circle|ellipse|rect|polygon|polyline|line|use)\b/.test(svgText)) {
      const _bb = (node as any).absoluteBoundingBox;
      if (_bb && typeof _bb.x === 'number') {
        _exportDiagnostics.push({ id: _id, isMask: true, kind: 'mask_svg_ok', clone_reason: _cloneReason });
        return { content: svgText, rb: [_bb.x, _bb.y, _bb.width, _bb.height], format: 'svg' };
      }
      _svgReason = 'no_bb';
    } else { _svgReason = 'no_vector(len=' + svgText.length + ')'; }
  } catch (e2) {
    _svgReason = 'err:' + String(e2);
  }
  _exportDiagnostics.push({ id: _id, isMask: true, kind: 'mask_fail', clone_reason: _cloneReason, svg_reason: _svgReason });
  return null;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return (globalThis as any).btoa(binary);
}
