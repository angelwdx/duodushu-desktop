'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { uploadBook } from '../lib/api';

/**
 * 全局文件拖拽处理组件
 * 支持将 EPUB 或 PDF 文件直接拖入应用窗口进行上传和阅读
 */
export default function GlobalFileDropHandler() {
  const router = useRouter();
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 阻止浏览器的默认拖拽打开文件行为
  const preventDefault = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    preventDefault(e);
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }, [preventDefault]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    preventDefault(e);
    // 只有当拖拽离开主窗口范围时才取消状态（排除子元素导致的误触发）
    if (e.clientY === 0 || e.clientX === 0 || 
        e.clientX === window.innerWidth || e.clientY === window.innerHeight) {
      setIsDragging(false);
    }
  }, [preventDefault]);

  const handleDragOver = useCallback((e: DragEvent) => {
    preventDefault(e);
    if (!isDragging && e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }, [isDragging, preventDefault]);

  const handleDrop = useCallback(async (e: DragEvent) => {
    preventDefault(e);
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // 只取第一个文件
    const file = files[0];
    const fileName = file.name.toLowerCase();
    
    // 校验扩展名
    if (!fileName.endsWith('.epub') && !fileName.endsWith('.pdf')) {
      setUploadError('只支持 .epub 或 .pdf 格式的书籍');
      setTimeout(() => setUploadError(null), 3000);
      return;
    }

    // 上传流程
    setIsUploading(true);
    setUploadError(null);

    try {
      const { book_id } = await uploadBook(file, {});
      
      // 发送全局事件让书架页刷新（如果当时在书架页）
      window.dispatchEvent(new Event('book-uploaded'));
      
      // 上传成功后直接跳转到阅读页
      router.push(`/read?id=${book_id}`);
    } catch (err: any) {
      console.error('拖拽上传失败:', err);
      setUploadError(err.message || '上传失败');
      setTimeout(() => setUploadError(null), 3000);
    } finally {
      setIsUploading(false);
    }
  }, [preventDefault, router]);

  useEffect(() => {
    // 在 window 级别注册全局事件
    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  // 如果什么状态都没有，不渲染任何 DOM
  if (!isDragging && !isUploading && !uploadError) return null;

  return (
    <div className="fixed inset-0 z-[99999] pointer-events-none flex items-center justify-center">
      {/* 拖拽中的遮罩层 */}
      {isDragging && !isUploading && (
        <div className="absolute inset-0 bg-blue-500/10 backdrop-blur-[2px] border-4 border-blue-500/50 border-dashed transition-all">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white/90 px-8 py-6 rounded-2xl shadow-2xl flex flex-col items-center gap-4 animate-in zoom-in-95 duration-200">
            <div className="p-4 bg-blue-100 text-blue-600 rounded-full animate-bounce">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <p className="text-xl font-bold text-gray-900">松开鼠标打开此书</p>
            <p className="text-sm text-gray-500">支持 EPUB / PDF 格式</p>
          </div>
        </div>
      )}

      {/* 上传中的提示 */}
      {isUploading && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gray-900/95 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-4 animate-in fade-in zoom-in-95 duration-200">
          <svg className="w-6 h-6 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="font-medium">正在导入，请稍候...</span>
        </div>
      )}

      {/* 错误提示 */}
      {uploadError && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-red-600 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-in shake duration-300">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">{uploadError}</span>
        </div>
      )}
    </div>
  );
}
