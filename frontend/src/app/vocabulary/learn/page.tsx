"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createLogger } from "../../../lib/logger";
import { getVocabulary } from "../../../lib/api";
import VocabDetailContent from "../../../components/VocabDetailContent";
import { ArrowLeftIcon, SettingsIcon, CheckIcon } from "../../../components/Icons";

const log = createLogger("VocabLearn");

interface VocabularyDetail {
  id: number;
  word: string;
  [key: string]: any;
}

interface LearnSettings {
  sortBy: 'priority_score' | 'newest' | 'alphabetical' | 'query_count';
  learnCount: number;
  rememberProgress: boolean;
}

interface LearnProgress {
  sortBy: string;
  currentIndex: number;
  lastStudyTime: string;
  completedWordIds: number[];
}

const LEARN_SETTINGS_KEY = "vocabulary_learn_settings";
const LEARN_PROGRESS_KEY = "vocabulary_learn_progress";

export default function LearnPage() {
  const router = useRouter();
  const [vocabList, setVocabList] = useState<VocabularyDetail[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showCompletion, setShowCompletion] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<LearnSettings>({
    sortBy: 'priority_score',
    learnCount: 50,
    rememberProgress: true,
  });

  const currentVocab = vocabList[currentIndex];

  const loadVocabList = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getVocabulary(
        undefined,
        1,
        settings.learnCount,
        'all',
        undefined,
        settings.sortBy,
      );

      const items = Array.isArray(data) ? data : (data.items || []);
      
      // Filter valid items
      const validItems = items.filter((item: any) => item && item.id && item.word);
      
      setVocabList(validItems);
    } catch (e) {
      log.error("加载单词列表失败:", e);
      setError("加载失败，请检查网络或刷新页面");
    } finally {
      setLoading(false);
    }
  }, [settings.learnCount, settings.sortBy]);

  // 加载设置和进度
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem(LEARN_SETTINGS_KEY);
      if (savedSettings) {
        setSettings(JSON.parse(savedSettings));
      }

      const savedProgress = localStorage.getItem(LEARN_PROGRESS_KEY);
      if (savedProgress && settings.rememberProgress) {
        const progress = JSON.parse(savedProgress) as LearnProgress;
        setSettings(prev => ({ ...prev, sortBy: progress.sortBy as any }));
        setCurrentIndex(progress.currentIndex);
      }
    } catch (e) {
      log.error("Failed to load settings:", e);
    }
  }, [settings.rememberProgress]);

  // 当词表变化时重置越界的 currentIndex，与加载逻辑解耦
  useEffect(() => {
    if (vocabList.length > 0 && currentIndex >= vocabList.length) {
      setCurrentIndex(0);
    }
  }, [vocabList.length, currentIndex]);

  // 加载单词列表
  useEffect(() => {
    loadVocabList();
  }, [loadVocabList]);

  // 保存进度
  useEffect(() => {
    if (settings.rememberProgress && vocabList.length > 0) {
      const progress: LearnProgress = {
        sortBy: settings.sortBy,
        currentIndex,
        lastStudyTime: new Date().toISOString(),
        completedWordIds: vocabList.slice(0, currentIndex).map(v => v.id),
      };
      localStorage.setItem(LEARN_PROGRESS_KEY, JSON.stringify(progress));
    }
  }, [currentIndex, settings.rememberProgress, settings.sortBy, vocabList]);

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex < vocabList.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      setShowCompletion(true);
    }
  };

  const handleExit = () => {
    router.push("/vocabulary");
  };

  const handleSaveSettings = (newSettings: LearnSettings) => {
    setSettings(newSettings);
    localStorage.setItem(LEARN_SETTINGS_KEY, JSON.stringify(newSettings));
    setShowSettings(false);
    loadVocabList();
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mb-4"></div>
        <div className="text-gray-500">正在准备学习内容...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-white flex flex-col overflow-hidden">
      {/* 顶部导航栏 - 始终显示 */}
      <header className="border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 bg-white z-50">
        <div className="flex items-center gap-4">
          <button
            onClick={handleExit}
            className="text-gray-600 hover:text-gray-900 flex items-center gap-1.5 transition-colors"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            返回生词本
          </button>
          <h1 className="font-bold text-gray-900">学习模式</h1>
        </div>
        <div className="flex items-center gap-4">
          {/* 排序选择 */}
          <select
            value={settings.sortBy}
            onChange={(e) => handleSaveSettings({ ...settings, sortBy: e.target.value as any })}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:outline-none"
            disabled={!!error || !currentVocab}
          >
            <option value="priority_score">优先级 ⭐</option>
            <option value="newest">最新添加</option>
            <option value="alphabetical">按字母排序</option>
            <option value="query_count">查询次数</option>
          </select>

          {/* 进度显示 - 仅在有内容时显示 */}
          {currentVocab && (
            <span className="text-sm text-gray-500 hidden sm:inline">
              {currentIndex + 1} / {vocabList.length}
            </span>
          )}

          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-500 hover:text-gray-700 transition-colors"
          >
            <SettingsIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 进度条 */}
      {vocabList.length > 0 && (
        <div className="w-full bg-gray-100 h-1 sticky top-[60px] z-40">
          <div
            className="bg-gray-900 h-1 transition-all"
            style={{
              width: `${((currentIndex + 1) / vocabList.length) * 100}%`,
            }}
          />
        </div>
      )}

      {/* 主要内容区 */}
      <main className="flex-1 overflow-hidden relative">
        {error ? (
          // 错误状态
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-4 text-red-500">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77-1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">加载失败</h3>
            <p className="text-gray-500 mb-6">{error}</p>
            <button
              onClick={() => loadVocabList()}
              className="px-6 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
            >
              重试
            </button>
          </div>
        ) : !currentVocab ? (
          // 空状态
          <div className="flex flex-col items-center justify-center h-full p-4">
            <div className="text-center max-w-md">
              <div className="mb-6 mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center text-gray-400">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332-.477-4.5-1.253" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">暂无需要学习的生词</h2>
              <p className="text-gray-500 mb-8">
                {settings.sortBy === 'priority_score' 
                  ? "当前优先级排序下没有找到单词。尝试切换排序方式？" 
                  : "去阅读一些书籍，遇到生词时添加到生词本，就可以在这里学习了。"}
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => router.push("/")}
                  className="px-6 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium transition-colors"
                >
                  去阅读
                </button>
                <button
                  onClick={() => router.push("/vocabulary")}
                  className="px-6 py-3 text-gray-600 hover:text-gray-900 font-medium transition-colors border border-gray-200 rounded-lg"
                >
                  查看生词本
                </button>
              </div>
            </div>
          </div>
        ) : (
          // 学习内容
          <VocabDetailContent
            vocabId={currentVocab.id}
            showBackButton={false}
            backUrl="/vocabulary"
            isLearnMode={true}
            onLearnModePrev={handlePrev}
            onLearnModeNext={handleNext}
            bottomBar={
              <div className="bg-white/70 backdrop-blur-xl shadow-xl rounded-full p-1.5 flex items-center gap-1 border border-white/20 scale-90 hover:scale-100 transition-transform">
                <button
                  onClick={handlePrev}
                  disabled={currentIndex === 0}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-gray-600"
                  title="上一个"
                >
                  <ArrowLeftIcon className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-gray-200 mx-1"></div>

                <button
                  onClick={handleExit}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-50 hover:text-red-500 text-gray-400 transition-all"
                  title="退出学习"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>

                <div className="w-px h-4 bg-gray-200 mx-1"></div>

                <button
                  onClick={handleNext}
                  disabled={currentIndex === vocabList.length - 1}
                  className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-900 text-white hover:bg-black disabled:opacity-30 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition-all"
                  title="下一个"
                >
                  <ArrowLeftIcon className="w-4 h-4 rotate-180" />
                </button>
              </div>
            }
          />
        )}
      </main>

      {/* 设置对话框 */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md shadow-2xl animate-in fade-in zoom-in duration-200">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">学习设置</h2>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                每次学习单词数量
              </label>
              <input
                type="number"
                min="10"
                max="200"
                value={settings.learnCount}
                onChange={(e) => setSettings({ ...settings, learnCount: parseInt(e.target.value) || 50 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                建议范围：10-200
              </p>
            </div>

            <div className="mb-6">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.rememberProgress}
                  onChange={(e) => setSettings({ ...settings, rememberProgress: e.target.checked })}
                  className="w-4 h-4 text-gray-900 focus:ring-gray-500 border-gray-300 rounded"
                />
                <span className="text-sm text-gray-700">记住学习进度</span>
              </label>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => handleSaveSettings(settings)}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 text-sm font-medium"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 完成对话框 */}
      {showCompletion && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-lg p-8 max-w-md w-full text-center shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex justify-center mb-6">
              <div className="p-4 bg-green-100 rounded-full">
                <CheckIcon className="w-12 h-12 text-green-600" />
              </div>
            </div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">
              学习完成
            </h2>
            <p className="text-gray-600 mb-8">
              本次学习了 {vocabList.length} 个单词！
            </p>
            <button
              onClick={handleExit}
              className="w-full px-8 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 font-medium transition-all"
            >
              返回生词本
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
