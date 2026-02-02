"use client";

import { useState } from "react";

/**
 * 笔记数据结构
 */
export interface Note {
  id: string;
  bookId: string;
  pageNumber: number;
  highlightedText: string;
  comment: string;
  createdAt: number;
  color: string;
}

interface NotesSidebarProps {
  bookId: string;
  bookTitle?: string;
  notes: Note[];
  onDeleteNote: (noteId: string) => void;
  onUpdateComment: (noteId: string, comment: string) => void;
  onJumpToPage?: (pageNumber: number) => void;
}

/**
 * 笔记侧边栏组件
 * 显示划线笔记列表，支持添加评论和导出 Markdown
 */
export default function NotesSidebar({
  bookId,
  bookTitle,
  notes,
  onDeleteNote,
  onUpdateComment,
  onJumpToPage,
}: NotesSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editComment, setEditComment] = useState("");

  // 开始编辑评论
  const startEditing = (note: Note) => {
    setEditingId(note.id);
    setEditComment(note.comment);
  };

  // 保存评论
  const saveComment = () => {
    if (editingId) {
      onUpdateComment(editingId, editComment);
      setEditingId(null);
      setEditComment("");
    }
  };

  // 导出为 Markdown
  const exportMarkdown = () => {
    const bookNotes = notes.filter((n) => n.bookId === bookId);
    if (bookNotes.length === 0) {
      alert("没有笔记可导出");
      return;
    }

    let md = `# ${bookTitle || '阅读笔记'}\n\n`;
    md += `导出时间: ${new Date().toLocaleString()}\n\n---\n\n`;

    bookNotes.forEach((note, index) => {
      md += `## 笔记 ${index + 1} (第 ${note.pageNumber} 页)\n\n`;
      md += `> ${note.highlightedText}\n\n`;
      if (note.comment) {
        md += `**评论:** ${note.comment}\n\n`;
      }
      md += `---\n\n`;
    });

    // 创建下载链接
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // 使用书籍名称作为文件名，如果不存在则使用 bookId
    const safeTitle = (bookTitle || bookId || "notes").replace(/[\\/:*?"<>|]/g, "_");
    a.download = `${safeTitle}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const bookNotes = notes.filter((n) => n.bookId === bookId);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
          <span className="text-sm font-medium text-gray-700">
            笔记 ({bookNotes.length})
          </span>
        </div>
        <button
          onClick={exportMarkdown}
          disabled={bookNotes.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="导出为 Markdown"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          导出
        </button>
      </div>

      {/* Notes List */}
      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {bookNotes.length === 0 ? (
          <div className="text-center text-gray-300 py-12">
            <svg
              className="w-8 h-8 mx-auto mb-3 opacity-20"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <p className="text-[13px]">暂无笔记</p>
            <p className="text-[11px] opacity-60 mt-1">选取文字后点击&ldquo;记笔记&rdquo;</p>
          </div>
        ) : (
          bookNotes.map((note) => (
            <div
              key={note.id}
              className="relative bg-white border border-gray-100 rounded-xl p-4 shadow-sm/5 group hover:border-gray-200 transition-all"
            >
              {/* Highlighted Text */}
              <div
                className="text-[13px] text-gray-800 mb-2.5 cursor-pointer leading-relaxed italic border-l-2 border-gray-200 pl-3"
                onClick={() => onJumpToPage?.(note.pageNumber)}
                title={`跳转到第 ${note.pageNumber} 页`}
              >
                &ldquo;{note.highlightedText}&rdquo;
              </div>

               {/* Page Number */}
              <div className="text-[10px] text-gray-400 mb-3 flex items-center justify-between">
                <span>第 {note.pageNumber} 页</span>
                <span>{new Date(note.createdAt).toLocaleDateString()}</span>
              </div>

              {/* Comment */}
              {editingId === note.id ? (
                <div className="mt-3">
                  <textarea
                    value={editComment}
                    onChange={(e) => setEditComment(e.target.value)}
                    className="w-full p-3 text-[13px] bg-gray-50 border-transparent rounded-lg focus:bg-white focus:border-gray-200 transition-all outline-none resize-none"
                    rows={3}
                    placeholder="添加评论..."
                    autoFocus
                  />
                  <div className="flex gap-2 mt-2.5">
                    <button
                      onClick={saveComment}
                      className="px-4 py-1.5 text-[11px] bg-gray-900 text-white rounded-lg hover:bg-black transition-all"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-4 py-1.5 text-[11px] text-gray-500 hover:bg-gray-50 rounded-lg transition-all"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : note.comment ? (
                <div
                  className="text-[13px] text-gray-500 mt-3 p-3 bg-gray-50/50 rounded-lg border border-transparent hover:border-gray-100 transition-all cursor-pointer leading-relaxed"
                  onClick={() => startEditing(note)}
                >
                  {note.comment}
                </div>
              ) : (
                <button
                  onClick={() => startEditing(note)}
                  className="text-[11px] text-gray-400 hover:text-gray-600 mt-2 flex items-center gap-1 transition-all"
                >
                  <span className="text-lg leading-none">+</span> 添加评论
                </button>
              )}

              {/* Delete Button */}
              <button
                onClick={() => onDeleteNote(note.id)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity"
                title="删除笔记"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
