figma.showUI(__html__, { width: 320, height: 240 });
let _exportDiagnostics: any[] = [];

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export') {
    await handleExport();
  }
  if (msg.type === 'cancel') {
    figma.closePlugin();
  }
};

async function handleExport() {
  const allTop: SceneNode[] = (figma.currentPage.children as SceneNode[])
    .filter(n => n.type !== 'SECTION' && 'width' in n && (n as any).width > 0);
  _exportDiagnostics = [];

  if (allTop.length === 0) {
    figma.ui.postMessage({
      type: 'error',
      message: '当前页无可导出的 top-level frame'
    });
    return;
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在解析节点...',
    percent: 10
  });

  const nodes: any[] = [];
  const imageRefs: Map<string, Uint8Array> = new Map();
  const vectorRefs: Map<string, string> = new Map();
  const vectorBodyCenter: Map<string, [number, number]> = new Map();
  const vectorBodyAbsCenter: Map<string, [number, number]> = new Map();
  const maskRenderBounds: Map<string, [number, number, number, number]> = new Map();
  const fontRefs: Map<string, { family: string, style: string }> = new Map();
  const reactionsAccum: any[] = [];

  for (const node of allTop) {
    const parsed = await parseNode(node, imageRefs, vectorRefs, fontRefs, vectorBodyCenter, vectorBodyAbsCenter, maskRenderBounds, reactionsAccum);
    if (parsed) {
      nodes.push(parsed);
    }
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在导出图片...',
    percent: 50
  });

  const images: { [key: string]: string } = {};
  for (const [ref, bytes] of imageRefs) {
    const base64 = uint8ArrayToBase64(bytes);
    images[ref] = base64;
  }

  const vectors: { [key: string]: string } = {};
  for (const [nodeId, svgText] of vectorRefs) {
    vectors[nodeId] = svgText;
  }

  const vectorBodyCenterOut: { [key: string]: number[] } = {};
  for (const [nodeId, center] of vectorBodyCenter) {
    vectorBodyCenterOut[nodeId] = center;
  }

  const vectorBodyAbsCenterOut: { [key: string]: number[] } = {};
  for (const [nodeId, center] of vectorBodyAbsCenter) {
    vectorBodyAbsCenterOut[nodeId] = center;
  }

  const maskRenderBoundsOut: { [key: string]: number[] } = {};
  for (const [nodeId, rb] of maskRenderBounds) {
    maskRenderBoundsOut[nodeId] = rb;
  }

  const fonts: { [key: string]: { family: string, style: string } } = {};
  for (const [key, fontInfo] of fontRefs) {
    fonts[key] = fontInfo;
  }

  figma.ui.postMessage({
    type: 'progress',
    message: '正在打包...',
    percent: 90
  });

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
    fonts: fonts,
    reactions: reactionsAccum
  };

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

async function parseNode(
  node: SceneNode,
  imageRefs: Map<string, Uint8Array>,
  vectorRefs: Map<string, string>,
  fontRefs: Map<string, { family: string, style: string }>,
  vectorBodyCenter: Map<string, [number, number]>,
  vectorBodyAbsCenter: Map<string, [number, number]>,
  maskRenderBounds: Map<string, [number, number, number, number]>,
  reactionsAccum: any[]
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

    // absoluteX/Y: node local origin in page coords (translation of absoluteTransform), not AABB top-left.
    // relativeTransform encodes flip: det([[m00,m01],[m10,m11]])<0 means a flip axis the rotation scalar can't recover.
  if ('absoluteTransform' in node && node.absoluteTransform) {
    const transform = node.absoluteTransform;
    base.absoluteX = transform[0][2];
    base.absoluteY = transform[1][2];
  }
  if ('relativeTransform' in node && node.relativeTransform) {
    base.relativeTransform = node.relativeTransform;
  }

  if (node.type === 'GROUP' && (node as any).children && (node as any).children.length > 0) {
    const bounds = (node as any).absoluteRenderBounds;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      base.width = bounds.width;
      base.height = bounds.height;
    }
  }

  const vectorTypes = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON'];

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

  if ('cornerRadius' in node) {
    base.cornerRadius = node.cornerRadius;
  }
  if ('topLeftRadius' in node) {
    base.topLeftRadius = node.topLeftRadius;
    base.topRightRadius = node.topRightRadius;
    base.bottomLeftRadius = node.bottomLeftRadius;
    base.bottomRightRadius = node.bottomRightRadius;
  }

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
        fillData.scaleMode = (fill as any).scaleMode;
        if ((fill as any).filters) { fillData.filters = (fill as any).filters; }
        if ((fill as any).scalingFactor !== undefined) { fillData.scalingFactor = (fill as any).scalingFactor; }
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
        fillData.gradientType = fill.type;
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

  if (node.type === 'TEXT') {
    base.characters = node.characters;

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

    base.textAutoResize = node.textAutoResize;
    base.textDecoration = node.textDecoration !== figma.mixed ? node.textDecoration : 'NONE';
    base.textCase = node.textCase !== figma.mixed ? node.textCase : 'ORIGINAL';

    if (fontFamily && fontWeight) {
      const fontKey = `${fontFamily}_${fontWeight}`;
      if (!fontRefs.has(fontKey)) {
        fontRefs.set(fontKey, { family: fontFamily, style: fontWeight });
      }
    }
  }

  if (vectorTypes.includes(node.type)) {
    const _parent = (node as any).parent;
    const _isOperand = _parent && _parent.type === 'BOOLEAN_OPERATION';
    const _isMask = (node as any).isMask === true;
    if (!_isOperand) {
      // Vector body center MUST use absoluteRenderBounds.center, not absoluteBoundingBox.
      // absoluteBoundingBox is the VECTOR "defining frame", which paths may not fill (e.g. 10x15 frame, 5x5 path);
      // multiple nodes sharing one frame would collapse to the same center and mis-place distinct parts.
      const _rbAbs: any = (node as any).absoluteRenderBounds;
      if (_rbAbs && typeof _rbAbs.x === 'number' && typeof _rbAbs.width === 'number') {
        vectorBodyAbsCenter.set(node.id, [_rbAbs.x + _rbAbs.width / 2, _rbAbs.y + _rbAbs.height / 2]);
      }
      let exported = false;
      // isMask nodes render 1x1 themselves (mask doesn't paint); clone with isMask=false to export the shape.
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
          // PNG IHDR: width/height are big-endian uint32 at byte offsets 16/20; reject 1x1 (empty-node placeholder).
          if (pngBytes.length >= 24) {
            const _dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + 16, 8);
            if (_dv.getUint32(0) >= 2 && _dv.getUint32(4) >= 2) {
              vectorRefs.set(node.id, 'PNG:' + uint8ArrayToBase64(pngBytes));
              _exportDiagnostics.push({ id: node.id, type: node.type, isMask: _isMask, kind: 'png_ok' });
              exported = true;
              const _rb: any = (node as any).absoluteRenderBounds;
              if (_rb && typeof _rb.x === 'number' && typeof _rb.width === 'number') {
                vectorBodyCenter.set(node.id, [_rb.width / 2 * 3, _rb.height / 2 * 3]);
              }
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

  if ('isMask' in node) {
    base.isMask = node.isMask;
  }

  try {
    if ('reactions' in node && Array.isArray((node as any).reactions)) {
      for (const r of (node as any).reactions) {
        _extract_reaction(node.id, r, reactionsAccum);
      }
    }
  } catch (e) {
    console.error('reactions read failed:', node.id, e);
  }

  if ('children' in node) {
    base.children = [];
    for (const child of node.children) {
      const parsed = await parseNode(child, imageRefs, vectorRefs, fontRefs, vectorBodyCenter, vectorBodyAbsCenter, maskRenderBounds, reactionsAccum);
      if (parsed) {
        base.children.push(parsed);
      }
    }
  }

  return base;
}

// Figma Plugin API reaction shape (@figma/plugin-typings):
//   action.type union: NODE | BACK | CLOSE | URL. NODE carries destinationId/navigation/transition/
//     overlayRelativePosition/preserveScrollPosition as PEER fields; navigation is a string literal
//     (NAVIGATE|SWAP|OVERLAY|SCROLL_TO|CHANGE_TO), not a nested object.
//   transition.duration is in SECONDS (multiplied by 1000 below for ms).
//   trigger.type variants: ON_KEY_DOWN (keyCodes[]) / AFTER_TIMEOUT (timeout ms) / ON_HOVER|PRESS|CLICK|DRAG.
function _extract_reaction(sourceId: string, r: any, out: any[]): void {
  if (!r || typeof r !== 'object') return;
  const trigger = r.trigger || {};
  const action = r.action || {};
  const entry: any = {
    sourceId: sourceId,
    triggerType: trigger.type || 'ON_CLICK',
    actionType: action.type || 'NODE',
  };
  if (trigger.type === 'AFTER_TIMEOUT' && typeof trigger.timeout === 'number') {
    entry.triggerDelayMs = trigger.timeout;
  }
  if (action.type === 'NODE') {
    entry.navigationType = action.navigation || 'NAVIGATE';
    if (action.destinationId) {
      entry.destinationId = action.destinationId;
    }
    if (action.preserveScrollPosition) {
      entry.preserveScrollPosition = true;
    }
    if (action.overlayRelativePosition) {
      entry.overlayRelativePosition = action.overlayRelativePosition;
    }
  } else if (action.type === 'BACK' || action.type === 'CLOSE') {
    entry.navigationType = action.type;
  }
  const tr = action.transition;
  if (tr && typeof tr === 'object') {
    if (tr.type) entry.transitionType = tr.type;
    if (tr.direction) entry.direction = tr.direction;
    if (typeof tr.duration === 'number') entry.durationMs = Math.round(tr.duration * 1000);
    const ease = tr.easing;
    if (ease && ease.type) entry.easingType = ease.type;
  }
  if (action.type === 'URL' && action.url) {
    entry.url = action.url;
  }
  if (trigger.type === 'ON_KEY_DOWN' && Array.isArray(trigger.keyCodes) && trigger.keyCodes.length > 0) {
    entry.keyCodes = trigger.keyCodes;
  }
  out.push(entry);
}

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

// Pre-rasterize to PNG when Figma's renderer is needed for fidelity: boolean-op, shadow/blur effects, or gradient fills.
// Flat solid vectors stay SVG (smaller, path-exact).
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
  const _id = (node as any).id;
  let _cloneReason = '';
  try {
    const clone = node.clone();
    (clone as any).isMask = false;
    // The clone MUST be appended to currentPage (not left under its parent): clip frames up the original
    // parent chain crop clone.exportAsync + absoluteRenderBounds (observed: 134x134 circle cropped to 43x125).
    // rb.x/y from the original node's absoluteTransform translation; node.absoluteX/Y is undefined for some mask nodes.
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
