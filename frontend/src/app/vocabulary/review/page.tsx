"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createLogger } from "../../../lib/logger";
import {
  getDueVocabulary,
  updateVocabularyMastery,
  loadReviewSettings,
  saveReviewSettings,
  DEFAULT_REVIEW_COUNT,
} from "../../../lib/api";
import {
  ArrowLeftIcon,
  CheckIcon,
  SettingsIcon,
} from "../../../components/Icons";
import VocabDetailContent from "../../../components/VocabDetailContent";

const log = createLogger("VocabReview");

interface DueWord {
  id: number;
  word: string;
  phonetic?: string;
  translation?: string;
  mastery_level: number;
  review_count: number;
  difficulty_score: number;
  priority_score: number;
  learning_status: string;
  next_review_at?: string;
  overdue_days?: number;
  srs_interval: number;
  srs_repetitions: number;
}

export default function ReviewPage() {
  const router = useRouter();
  const [vocabList, setVocabList] = useState<DueWord[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showDefinition, setShowDefinition] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCompletionDialog, setShowCompletionDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reviewCount, setReviewCount] = useState<number>(DEFAULT_REVIEW_COUNT);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // SRS 反馈提示：显示"下次复习：N 天后"
  const [srsToast, setSrsToast] = useState<string | null>(null);

  const currentVocab = vocabList[currentIndex];

  useEffect(() => {
    const settings = loadReviewSettings();
    setReviewCount(settings.reviewCount);
  }, []);

  const loadVocab = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getDueVocabulary(reviewCount);
      const items = data.items ?? [];
      setVocabList(items);
      setCurrentIndex(0);
      setShowDefinition(false);
    } catch (e) {
      log.error("加载到期单词失败:", e);
      alert("加载失败");
    } finally {
      setLoading(false);
    }
  }, [reviewCount]);

  useEffect(() => {
    loadVocab();
  }, [loadVocab]);

  const showSrsToast = (days: number) => {
    const text = days === 1 ? "下次复习：明天" : `下次复习：${days} 天后`;
    setSrsToast(text);
    setTimeout(() => setSrsToast(null), 2200);
  };

  const handleRate = async (quality: 0 | 3 | 5) => {
    if (!currentVocab || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await updateVocabularyMastery(currentVocab.id, { quality });
      if (quality < 3) {
        // 忘了：展示释义后停在当前词
        setShowDefinition(true);
        if (result?.next_review_days != null) showSrsToast(result.next_review_days);
      } else {
        if (result?.next_review_days != null) showSrsToast(result.next_review_days);
        goToNext();
      }
    } catch (e) {
      log.error("更新复习结果失败:", e);
      setSrsToast("提交失败，请重试");
      setTimeout(() => setSrsToast(null), 2200);
    } finally {
      setIsSubmitting(false);
    }
  };

  const goToNext = () => {
    setShowDefinition(false);
    if (vocabList.length === 0) return;
    if (currentIndex < vocabList.length - 1) {
      setCurrentIndex((c) => c + 1);
    } else {
      setShowCompletionDialog(true);
    }
  };

  const handleReviewCountChange = (value: number) => {
    setReviewCount(value);
    saveReviewSettings({ reviewCount: value });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-gray-500">加载中...</div>
      </div>
    );
  }

  if (vocabList.length === 0 && !loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">🎉</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">今日复习完成！</h2>
          <p className="text-gray-500 mb-6 text-sm">暂无到期单词，保持学习节奏！</p>
          <button
            onClick={() => router.push("/vocabulary")}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            返回生词本
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-white flex flex-col overflow-hidden">
      {/* SRS 反馈 Toast */}
      {srsToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-gray-900 text-white text-sm px-4 py-2 rounded-full shadow-lg animate-fade-in-out pointer-events-none">
          {srsToast}
        </div>
      )}

      {/* 顶部导航栏 */}
      <header className="border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 bg-white z-50">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/vocabulary")}
            className="text-gray-600 hover:text-gray-900 flex items-center gap-1.5 transition-colors"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            退出复习
          </button>
          <h1 className="font-bold text-gray-900">单词复习</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">
            {currentIndex + 1} / {vocabList.length}
          </span>
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-500 hover:text-gray-700 transition-colors"
          >
            <SettingsIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 进度条 */}
      <div className="w-full bg-gray-100 h-1 sticky top-[60px] z-40">
        <div
          className="bg-gray-900 h-1 transition-all"
          style={{ width: `${((currentIndex + 1) / vocabList.length) * 100}%` }}
        />
      </div>

      {/* 逾期提示（调试/信息用） */}
      {currentVocab?.overdue_days != null && currentVocab.overdue_days > 1 && (
        <div className="text-center py-1 text-xs text-amber-600 bg-amber-50">
          已逾期 {currentVocab.overdue_days} 天
        </div>
      )}

      {/* 主要内容区 */}
      <main className="flex-1 overflow-hidden relative">
        {!showDefinition ? (
          <div className="h-full flex flex-col items-center justify-center p-4">
            <div className="text-center mb-16 scale-110">
              <h1 className="text-6xl font-bold text-gray-900 mb-6 tracking-tight">
                {currentVocab.word}
              </h1>
              {currentVocab.phonetic && (
                <p className="text-2xl text-gray-400 font-mono">
                  /{currentVocab.phonetic}/
                </p>
              )}
            </div>

            <div className="flex gap-6 w-full max-w-lg">
              <button
                onClick={() => handleRate(0)}
                disabled={isSubmitting}
                className="flex-1 py-4 bg-white border-2 border-gray-200 hover:border-red-400 hover:text-red-600 text-gray-900 rounded-xl font-medium transition-all hover:-translate-y-1 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                忘了
              </button>
              <button
                onClick={() => handleRate(3)}
                disabled={isSubmitting}
                className="flex-1 py-4 bg-white border-2 border-gray-200 hover:border-amber-400 hover:text-amber-600 text-gray-900 rounded-xl font-medium transition-all hover:-translate-y-1 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                模糊
              </button>
              <button
                onClick={() => handleRate(5)}
                disabled={isSubmitting}
                className="flex-1 py-4 bg-white border-2 border-gray-200 hover:border-green-500 hover:text-green-700 text-gray-900 rounded-xl font-medium transition-all hover:-translate-y-1 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                记得
              </button>
            </div>
          </div>
        ) : (
          <VocabDetailContent
            vocabId={currentVocab.id}
            showBackButton={false}
            backUrl="/vocabulary"
            isLearnMode={true}
            bottomBar={
              <div className="bg-white/70 backdrop-blur-xl shadow-xl rounded-full p-1.5 flex items-center gap-1 border border-white/20">
                <button
                  onClick={() => router.push("/vocabulary")}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-red-50 hover:text-red-500 text-gray-400 transition-all"
                  title="退出复习"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
                <div className="w-px h-4 bg-gray-200 mx-1"></div>
                <button
                  onClick={goToNext}
                  className="w-10 h-10 flex items-center justify-center rounded-full bg-gray-900 text-white hover:bg-black shadow-md hover:shadow-lg transition-all"
                  title="下一词"
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
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">复习设置</h2>
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                每次最多加载单词数
              </label>
              <input
                type="number"
                min="5"
                max="100"
                value={reviewCount}
                onChange={(e) => setReviewCount(parseInt(e.target.value) || DEFAULT_REVIEW_COUNT)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-500"
              />
              <p className="text-xs text-gray-400 mt-1">实际数量取决于当日到期单词数</p>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowSettings(false)} className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50">取消</button>
              <button
                onClick={() => { handleReviewCountChange(reviewCount); setShowSettings(false); }}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 text-sm font-medium"
              >确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 完成对话框 */}
      {showCompletionDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white border border-gray-200 rounded-lg p-8 max-w-md w-full text-center">
            <div className="flex justify-center mb-6">
              <CheckIcon className="w-16 h-16 text-gray-900" />
            </div>
            <h2 className="text-2xl font-semibold text-gray-900 mb-3">本轮复习完成</h2>
            <p className="text-gray-600 mb-8">已完成 {vocabList.length} 个单词的复习</p>
            <button
              onClick={() => router.push("/vocabulary")}
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

