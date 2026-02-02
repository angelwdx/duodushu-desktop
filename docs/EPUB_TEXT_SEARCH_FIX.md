# EPUB 文本搜索跳转修复记录

**最后更新**: 2026-02-03

## 问题描述

在 EPUB 阅读器中，从词汇本点击单词跳转到原文位置时，会出现以下问题：

1. **页面停在两页之间**：`window.find()` 的自动滚动行为与 epub.js 的分页模式冲突，导致页面停在两页之间，显示"前一页还有留个屁股"
2. **高亮位置不正确**：overlay 的坐标计算错误，导致高亮显示在视口之外

## 根本原因

1. epub.js 使用 `flow: 'paginated'` 分页模式，通过 CSS columns 实现分页
2. `window.find()` 找到文本后会自动滚动，但这个滚动不会对齐到 epub.js 的页面边界
3. `getBoundingClientRect()` 返回的坐标是相对于整个文档的，而不是当前可见页面

## 解决方案

### 关键代码位置

`frontend/src/components/EPUBReader.tsx` 中的 `handleTextSearch` 函数

### 核心修复逻辑

在 `window.find()` 找到文本后，使用 `contentsObj.cfiFromNode()` 生成 CFI，然后调用 `rendition.display(cfi)` 来强制对齐到正确的页面边界。

```typescript
// 1. 保存完整的 Contents 对象（它有 cfiFromNode 和 cfiFromRange 方法）
const contentsObj = contents[0];
const win = contentsObj.window;
const doc = contentsObj.document;

// 2. 使用 window.find() 搜索文本
if (win.find(query, false, false, true, false, true, false)) {
    const selection = win.getSelection();
    if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);

        // 3. 关键修复：使用 contentsObj.cfiFromNode() 生成 CFI 并对齐页面
        try {
            let cfi;
            try {
                const node = range.startContainer;
                const element = node.nodeType === 3 ? node.parentElement : (node as Element);
                if (element) {
                    cfi = contentsObj.cfiFromNode(element);  // 关键！
                }
            } catch (cfiErr) {
                // 降级：使用 cfiFromRange
                const simpleRange = doc.createRange();
                const node = range.startContainer;
                const maxOff = node.nodeType === 3 ? (node.textContent?.length || 0) : node.childNodes.length;
                simpleRange.setStart(node, Math.min(range.startOffset, maxOff));
                simpleRange.collapse(true);
                cfi = contentsObj.cfiFromRange(simpleRange);  // 关键！
            }

            if (cfi) {
                // 4. 调用 display(cfi) 强制对齐到页面边界
                renditionRef.current!.display(cfi).catch((e) => {
                    // IndexSizeError 是 epub.js 内部错误，可以忽略
                });
            }
        } catch (e) {
            // 对齐失败，但搜索已成功
        }

        // 5. 显示高亮 overlay
        const searchOverlay = doc.getElementById('search-highlight-overlay');
        if (searchOverlay) {
            const rect = range.getBoundingClientRect();
            searchOverlay.style.width = `${rect.width + 4}px`;
            searchOverlay.style.height = `${rect.height + 4}px`;
            searchOverlay.style.top = `${rect.top + win.scrollY - 2}px`;
            searchOverlay.style.left = `${rect.left + win.scrollX - 2}px`;
            searchOverlay.style.display = 'block';
        }
    }
}
```

## 常见错误

### 1. `contents.cfiFromNode is not a function`

**原因**：使用了错误的变量。`renditionRef.current.getContents()` 返回的是数组，需要使用 `contents[0]` 来获取 Contents 对象。

**错误代码**：
```typescript
const contents = renditionRef.current.getContents();
const win = contents[0].window;
// 然后错误地使用 contents.cfiFromNode()  // ❌ 错误！
```

**正确代码**：
```typescript
const contents = renditionRef.current.getContents();
const contentsObj = contents[0];  // 保存完整的 Contents 对象
const win = contentsObj.window;
// 使用 contentsObj.cfiFromNode()  // ✅ 正确！
```

### 2. `IndexSizeError: Failed to execute 'setEnd' on 'Range'`

**原因**：这是 epub.js 内部的错误，在 `display(cfi)` 时可能会触发。

**处理方式**：使用 `.catch()` 捕获并忽略，不影响功能。

```typescript
renditionRef.current!.display(cfi).catch((e) => {
    log.info('CFI display failed (epub.js internal error):', e);
});
```

### 3. 高亮位置不正确（left: 1212.875）

**原因**：在分页模式下，`getBoundingClientRect()` 返回的是相对于整个文档的坐标，而不是当前可见页面。

**解决方案**：在 `display(cfi)` 对齐页面后，高亮位置会自动正确。

## 参考：旧版本工作代码

旧版本（`EPUBReader-old.tsx`）的关键代码在第 153-182 行：

```typescript
const contents = renditionRef.current.getContents()[0];
// ...
cfi = contents.cfiFromNode(element);
// ...
renditionRef.current.display(cfi).catch((e) => log.debug('CFI display failed:', e));
```

## 调试技巧

1. 添加日志查看 `contentsObj` 是否有 `cfiFromNode` 方法：
   ```typescript
   log.info('contentsObj methods:', {
       hasCfiFromNode: typeof contentsObj.cfiFromNode === 'function',
       hasCfiFromRange: typeof contentsObj.cfiFromRange === 'function'
   });
   ```

2. 查看生成的 CFI 格式：
   ```typescript
   log.info('Generated CFI:', cfi);
   // 正确格式示例：epubcfi(/6/22!/4/28/2)
   ```

3. 检查页面是否正确对齐：
   - 如果页面停在两页之间，说明 `display(cfi)` 没有被调用或失败
   - 如果高亮位置不对，说明 `getBoundingClientRect()` 在页面对齐前被调用

## 相关文件

- `frontend/src/components/EPUBReader.tsx` - EPUB 阅读器组件
- `EPUBReader-old.tsx` - 旧版本参考代码（项目根目录）
