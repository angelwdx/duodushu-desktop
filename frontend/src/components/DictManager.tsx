import { useState, useEffect, useRef, useCallback } from 'react';
import { DictImportDialog } from './DictImportDialog';
import { fetchDicts, deleteDict, toggleDict, setDictPriority, DictInfo } from '../lib/api';

export function DictManager() {
  const [dicts, setDicts] = useState<DictInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null); // 正在删除的词典名
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 显示Toast提示
  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const loadDicts = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setLoading(true);
    try {
      setDicts(await fetchDicts());
    } catch (error) {
      console.error('Failed to load dicts:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDicts();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadDicts]);

  const handleDelete = async (dictName: string) => {
    if (!confirm(`确定要删除词典 "${dictName}" 吗？`)) return;

    setDeleting(dictName);
    try {
      await deleteDict(dictName);
      showToast(`词典 "${dictName}" 已删除`, 'success');
      // 重新加载词典列表
      await loadDicts();
    } catch (error) {
      showToast('删除失败,请重试', 'error');
      console.error('Failed to delete dict:', error);
    } finally {
      setDeleting(null);
    }
  };

  const handleToggle = async (dictName: string, active: boolean) => {
    try {
      await toggleDict(dictName, active);
      await loadDicts();
    } catch (error) {
      console.error('Failed to toggle dict:', error);
      showToast('操作失败', 'error');
    }
  };

  const handleDragStart = (dictName: string) => {
    setDraggedItem(dictName);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (targetDictName: string) => {
    if (!draggedItem || draggedItem === targetDictName) {
      setDraggedItem(null);
      return;
    }

    // 找到拖拽项和目标项的索引
    const draggedIndex = dicts.findIndex(d => d.name === draggedItem);
    const targetIndex = dicts.findIndex(d => d.name === targetDictName);

    if (draggedIndex === -1 || targetIndex === -1) {
      setDraggedItem(null);
      return;
    }

    // 创建新的排序列表
    const newDicts = [...dicts];
    const [draggedDict] = newDicts.splice(draggedIndex, 1);
    newDicts.splice(targetIndex, 0, draggedDict);

    // 更新本地状态
    setDicts(newDicts);
    setDraggedItem(null);

    // 保存到后端
    setSaving(true);
    try {
      // 只保存导入词典的顺序（排除内置词典）
      const importedDictNames = newDicts
        .filter(d => d.type === 'imported')
        .map(d => d.name);

      await setDictPriority(importedDictNames);
      showToast('排序已保存', 'success');
    } catch (error) {
      console.error('Failed to save priority:', error);
      showToast('保存排序失败', 'error');
      // 恢复原来的顺序
      await loadDicts();
    } finally {
      setSaving(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(2)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-6">
        <div className="text-sm text-gray-500">
          提示：拖拽导入词典可调整查词时的顺序
        </div>
        <button
          onClick={() => setShowImportDialog(true)}
          className="bg-gray-900 text-white px-4 py-2 rounded hover:bg-gray-800 transition-colors"
        >
          导入词典
        </button>
      </div>

      {loading ? (
        <div className="text-center py-8">加载中...</div>
      ) : (
        <div className="space-y-4">
          {dicts.map((dict) => (
            <div
              key={dict.name}
              draggable={dict.type === 'imported'}
              onDragStart={() => handleDragStart(dict.name)}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(dict.name)}
              className={`bg-white border border-gray-200 rounded-lg hover:border-gray-300 hover:shadow-md transition-all ${
                draggedItem === dict.name ? 'opacity-50 bg-gray-50' : ''
              } ${dict.type === 'imported' ? 'cursor-move' : ''}`}
            >
              <div className="p-6">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {dict.type === 'imported' && (
                        <svg className="w-5 h-5 text-gray-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" />
                        </svg>
                      )}
                      <h3 className="text-lg font-semibold text-gray-900">{dict.name}</h3>
                      {dict.is_builtin && (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                          内置
                        </span>
                      )}
                      {dict.type === 'imported' && (
                        <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                          导入
                        </span>
                      )}
                    </div>
                    <div className="mt-3 space-y-1 text-sm text-gray-600">
                      <div>单词数：{dict.word_count.toLocaleString()}</div>
                      <div>大小：{formatSize(dict.size)}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {!dict.is_builtin && (
                      <>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={dict.is_active}
                            onChange={(e) => handleToggle(dict.name, e.target.checked)}
                            className="w-4 h-4"
                          />
                          <span className="text-sm">启用</span>
                        </label>
                        <button
                          onClick={() => handleDelete(dict.name)}
                          disabled={deleting === dict.name}
                          className={`text-sm transition-colors ${deleting === dict.name ? 'text-gray-400 cursor-not-allowed' : 'text-red-500 hover:text-red-700'}`}
                        >
                          {deleting === dict.name ? '删除中...' : '删除'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {dicts.length === 0 && (
            <div className="text-center py-12 text-gray-400 bg-gray-50 border border-dashed border-gray-300 rounded-lg">
              暂无词典，点击右上角&ldquo;导入词典&rdquo;添加您的第一个词典
            </div>
          )}
        </div>
      )}

      {showImportDialog && (
        <DictImportDialog
          onClose={() => setShowImportDialog(false)}
          onImportComplete={(dictName) => {
            showToast(`词典 "${dictName}" 导入成功`, 'success');
            loadDicts();
          }}
        />
      )}

      {/* Toast 提示 */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className={`px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 ${
            toast.type === 'success' 
              ? 'bg-green-50 text-green-800 border border-green-200' 
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {toast.type === 'success' ? (
              <svg className="w-5 h-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
            <span className="text-sm font-medium">{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}
