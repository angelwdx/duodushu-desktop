'use client';

import { useDrag } from '@use-gesture/react';
import { useCallback } from 'react';

/**
 * 阅读器手势 Hook - 支持左右滑动翻页
 * @param onPrevPage 上一页回调
 * @param onNextPage 下一页回调
 * @returns 手势绑定 props
 */
export const useReaderGestures = (
  onPrevPage: () => void,
  onNextPage: () => void,
  enabled: boolean = true
) => {
  const bind = useDrag(
    ({ down, movement: [mx], direction: [xDir], swipe: [swipeX], event }) => {
      // 如果目标是文本层元素，则忽略手势，允许原生文本选择
      const target = event.target as HTMLElement;
      if (target?.closest('.react-pdf__Page__textContent')) {
        return;
      }

      // 左右滑动阈值: 50px
      const threshold = 50;

      // 左滑（下一页）
      if (!down && mx < -threshold && (xDir < 0 || swipeX < 0)) {
        onNextPage();
      }

      // 右滑（上一页）
      if (!down && mx > threshold && (xDir > 0 || swipeX > 0)) {
        onPrevPage();
      }
    },
    {
      // 配置选项
      filterTaps: true,        // 忽略点击
      rubberband: true,       // 橡皮筋效果
      axis: 'x',             // 只响应水平方向
      pointer: { touch: true }, // 显式启用触摸支持
      swipe: {                // 滑动配置
        distance: 50,         // 滑动距离阈值
        duration: 250,        // 滑动时间阈值（毫秒）
      },
      enabled,               // 是否启用
    }
  );

  return bind;
};

export default useReaderGestures;
