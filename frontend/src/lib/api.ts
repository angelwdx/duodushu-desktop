// 尝试从 Electron 获取后端 URL（便携版使用）
// 在开发环境或 Electron 未提供 URL 时，使用默认值
let API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

// 如果在 Electron 环境中（检测 window.electronAPI）
// 注意：避免在模块顶层使用 await 以免阻塞 Next.js 渲染
if (typeof window !== 'undefined' && (window as any).electronAPI) {
  (window as any).electronAPI.getBackendUrl().then((backendUrl: string) => {
    if (backendUrl) {
      API_URL = backendUrl;
      console.log('[API] Using backend URL from Electron:', backendUrl);
    }
  }).catch((e: any) => {
    console.warn('[API] Failed to get backend URL from Electron:', e);
  });
}

// 注意：不建议在没有 electronAPI 的情况下强制覆盖 API_URL，
// 除非确定在非开发环境下需要这样做。
// 这里保留 localhost 作为最后的退路
if (typeof window !== 'undefined' && API_URL === "http://localhost:8000" && !(window as any).electronAPI) {
  // 可能是网页直播预览模式，保持默认 localhost
  console.log('[API] Using default localhost URL');
}

console.log('[API] Initial API URL configured:', API_URL);

// 带超时的 fetch 函数
async function fetchWithTimeout(url: string, timeout: number, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

 export interface Book {
  id: string;
  title: string;
  author: string;
  format: string;
  cover_image: string | null;
  total_pages: number;
  status: "processing" | "completed" | "failed";
  book_type?: string;
}

 export async function uploadBook(
  file: File,
  data: { book_type?: string },
): Promise<{ book_id: string; status: string }> {
  const formData = new FormData();
  formData.append("file", file);
  if (data.book_type) {
    formData.append("book_type", data.book_type);
  }

  const res = await fetch(`${API_URL}/api/books/upload`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.detail || "Upload failed");
  }

  return res.json();
}

export async function deleteBook(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/books/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete book");
  return res.json();
}

export async function getBooks(): Promise<Book[]> {
  const url = `${API_URL}/api/books/?_t=${Date.now()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch books");
  return res.json();
}

export async function updateBookType(
  bookId: string,
  bookType: "normal" | "example_library",
): Promise<{ status: string; book_id: string; book_type: string }> {
  const res = await fetch(`${API_URL}/api/books/${bookId}/type`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ book_type: bookType }),
  });
  if (!res.ok) throw new Error("Failed to update book type");
  return res.json();
}

// Dictionary source check result
export type SourceAvailability = {
  [key: string]: boolean;
};

// Dictionary lookup
export async function lookupWord(word: string, source?: string) {
  let url = `${API_URL}/api/dict/${word}`;
  if (source) {
    url += `?source=${encodeURIComponent(source)}`;
  }
  console.log(
    `Looking up word: ${word}${source ? ` (source: ${source})` : ""}`,
  );

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error("Lookup failed");
  }
  return res.json();
}

// Dictionary lookup for multiple sources (parallel queries)
export async function lookupWordMultipleSources(word: string, sources: string[]) {
  if (!sources || sources.length === 0) {
    return null;
  }

  console.log(`Looking up word: ${word} from ${sources.length} source(s): ${sources.join(", ")}`);

  // Parallel queries for all sources
  const promises = sources.map((source) =>
    fetch(`${API_URL}/api/dict/${word}?source=${encodeURIComponent(source)}`, {
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) return null;
          throw new Error(`Lookup failed for source: ${source}`);
        }
        return res.json();
      })
      .catch((err) => {
        console.warn(`Failed to lookup from ${source}:`, err);
        return null;
      })
  );

  const results = await Promise.all(promises);

  // Filter out null results and merge them
  const validResults = results.filter((r) => r !== null);

  if (validResults.length === 0) {
    return null;
  }

  // If only one result, return it directly
  if (validResults.length === 1) {
    return validResults[0];
  }

  // If multiple results, merge them with source information
  // Return an array of results with source labels
  return {
    word,
    multiple_sources: true,
    results: validResults.map((result, index) => ({
      ...result,
      source_index: index,
      source_label: sources[index],
    })),
  };
}

// Check word sources
export async function checkWordSources(
  word: string,
): Promise<SourceAvailability> {
  const res = await fetch(`${API_URL}/api/dict/${word}/sources`, { cache: "no-store" });
  if (!res.ok) {
    console.error("Failed to check sources");
    return {};
  }
  return res.json();
}

export async function addVocabulary(data: {
  word: string;
  book_id?: string;
  context_sentence?: string;
  definition?: any;
  translation?: string;
  page_number?: number;
}) {
  const response = await fetch(`${API_URL}/api/vocabulary/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error("Failed to add vocabulary");
  }
  return response.json();
}

export async function getVocabulary(
  bookId?: string,
  page: number = 1,
  limit: number = 20,
  filterType: "webnovel" | "normal" | "all" = "all",
  search?: string,
  sortBy:
    | "newest"
    | "alphabetical"
    | "review_count"
    | "query_count"
    | "priority_score" = "newest",
) {
  const query = new URLSearchParams({
    page: page.toString(),
    per_page: limit.toString(),
    filter_type: filterType,
    sort_by: sortBy,
  });
  if (bookId) query.append("book_id", bookId);
  if (search) query.append("search", search);
  query.append("_t", Date.now().toString()); // Add cache-busting parameter

  const res = await fetch(`${API_URL}/api/vocabulary/?${query.toString()}`, {
    cache: "no-store", // Ensure fresh data
  });
  if (!res.ok) throw new Error("Failed to fetch vocabulary");
  return res.json();
}

export async function getVocabularyDetail(id: number) {
  const res = await fetch(`${API_URL}/api/vocabulary/${id}?_t=${Date.now()}`);
  if (!res.ok) throw new Error("Failed to fetch vocabulary detail");
  return res.json();
}

export async function updateVocabularyMastery(
  vocabId: number,
  data: {
    mastery_level?: number;
    review_count?: number;
    last_reviewed_at?: string;
    difficulty_score?: number;
  },
) {
  const res = await fetch(`${API_URL}/api/vocabulary/${vocabId}/mastery`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update vocabulary");
  return res.json();
}

export async function deleteVocabulary(id: number) {
  const res = await fetch(`${API_URL}/api/vocabulary/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete vocabulary");
  return res.json();
}

export async function generateSpeech(text: string, voice: string = "default") {
  // Sanitize text for TTS
  const sanitizedText = text.replace(/\//g, ", ");

  const res = await fetch(`${API_URL}/api/tts/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: sanitizedText, voice }),
  });
  if (!res.ok) throw new Error("Failed to generate speech");
  const data = await res.json();
  // Return absolute URL
  return `${API_URL}${data.url}`;
}

/**
 * Stream speech audio - faster for longer texts as audio plays while generating
 * Returns a Blob URL that can be used with HTMLAudioElement
 */
export async function streamSpeech(
  text: string,
  voice: string = "default",
): Promise<string> {
  // Sanitize text for TTS: replace slashes with commas to avoid reading "slash"
  const sanitizedText = text.replace(/\//g, ", ");

  const res = await fetch(`${API_URL}/api/tts/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: sanitizedText, voice }),
  });
  if (!res.ok) throw new Error("Failed to stream speech");

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export async function translateText(text: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s Timeout

  try {
    const res = await fetch(`${API_URL}/api/dict/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      let errorMessage = "Failed to translate text";
      try {
        const errorData = await res.json();
        errorMessage = errorData.detail || errorMessage;
      } catch {
        // 如果无法解析错误响应，使用状态码
        errorMessage = `Failed to translate text (HTTP ${res.status})`;
      }
      throw new Error(errorMessage);
    }

    const data = await res.json();
    return data; // Return full object {translation, source}
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error("翻译请求超时，请检查网络连接或稍后重试");
    }
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error("无法连接到服务器，请检查后端服务是否运行");
    }
    throw error;
  }
}

// Bookmark API functions
export async function addBookmark(
  bookId: string,
  pageNumber: number,
  title?: string,
  note?: string,
) {
  const res = await fetch(`${API_URL}/api/bookmarks/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      book_id: bookId,
      page_number: pageNumber,
      title,
      note,
    }),
  });
  if (!res.ok) throw new Error("Failed to add bookmark");
  return res.json();
}

export async function getBookmarks(bookId?: string) {
  const url = new URL(`${API_URL}/api/bookmarks/`);
  if (bookId) url.searchParams.append("book_id", bookId);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to fetch bookmarks");
  return res.json();
}

export async function deleteBookmark(id: number) {
  const res = await fetch(`${API_URL}/api/bookmarks/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete bookmark");
  return res.json();
}

export async function checkBookmark(bookId: string, pageNumber: number) {
  const url = new URL(`${API_URL}/api/bookmarks/check`);
  url.searchParams.append("book_id", bookId);
  url.searchParams.append("page_number", pageNumber.toString());

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error("Failed to check bookmark");
  return res.json();
}

export function getAudioUrl(dictName: string, path: string): string {
  // Get audio URL for dictionary pronunciation
  // Backend router: /audio/{dict_name}/{path:path}
  // FastAPI automatically handles URL encoding/decoding for dict_name

  // Clean path: ensure no leading slash if path already has it
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;

  // NOTE: Do NOT encode dictName! FastAPI handles it automatically.
  // MDD reader cache uses original dict_name ("韦氏", "牛津", etc.)
  // If we encode it, cache won't match and will fail to find files.

  return `${API_URL}/api/dict/audio/${dictName}/${cleanPath}`;
}

// 新增：跟踪单词查询（只对已收藏的单词）
export async function trackWordQuery(params: {
  word: string;
  bookId: string;
  pageNumber: number;
}) {
  const res = await fetch(`${API_URL}/api/vocabulary/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      word: params.word,
      book_id: params.bookId,
      page_number: params.pageNumber,
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to track word query");
  }

  return res.json();
}

// 新增：获取高优先级单词（智能提醒）
export async function getHighPriorityWords(
  threshold: number = 70,
  limit: number = 10,
) {
  const query = new URLSearchParams({
    threshold: threshold.toString(),
    limit: limit.toString(),
  });

  const res = await fetch(`${API_URL}/api/vocabulary/high_priority?${query}`);

  if (!res.ok) {
    throw new Error("Failed to fetch high priority words");
  }

  return res.json();
}

// 新增：批量更新优先级（手动触发或定时任务）
export async function updateAllPriorities() {
  const res = await fetch(`${API_URL}/api/vocabulary/update_priorities`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error("Failed to update priorities");
  }

  return res.json();
}

// 复习设置类型
export interface ReviewSettings {
  reviewCount: number;
}

// 默认复习数量
export const DEFAULT_REVIEW_COUNT = 20;

// 保存复习设置到 localStorage
export function saveReviewSettings(settings: ReviewSettings) {
  try {
    localStorage.setItem('review_settings', JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save review settings:", e);
  }
}

// 加载复习设置
export function loadReviewSettings(): ReviewSettings {
  try {
    const saved = localStorage.getItem('review_settings');
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.error("Failed to load review settings:", e);
  }
  return { reviewCount: DEFAULT_REVIEW_COUNT };
}

/**
 * 为已收藏的单词添加新的上下文
 */
export async function addWordContext(vocabId: number, data: {
  word: string;
  book_id: string;
  page_number: number;
  context_sentence: string;
  is_primary?: number;
}) {
  const response = await fetch(`${API_URL}/api/vocabulary/${vocabId}/context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Failed to add word context");
  }

  return response.json();
}

/**
 * 手动触发例句提取
 */
export async function extractExamplesManual(vocabId: number) {
  const res = await fetch(`${API_URL}/api/vocabulary/${vocabId}/extract_examples`, {
    method: "POST",
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.detail || "Failed to trigger extraction");
  }
  return res.json();
}

/**
 * 检查例句提取状态
 */
export async function checkExtractionStatus(vocabId: number) {
  const res = await fetch(`${API_URL}/api/vocabulary/${vocabId}/extraction_status`);
  if (!res.ok) {
    throw new Error("Failed to check extraction status");
  }
  return res.json();
}

export type ExtractionStatus = {
  word: string;
  vocab_id: number;
  total_examples: number;
  example_library_count: number;
  status: "completed" | "pending" | "failed";
  message: string;
};

/**
 * 词典信息接口
 */
export interface DictInfo {
  name: string;
  type: 'builtin' | 'imported';
  size: number;
  word_count: number;
  is_active: boolean;
  is_builtin: boolean;
}

/**
 * 获取所有已安装的词典列表
 */
export async function fetchDicts(): Promise<DictInfo[]> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/`, 5000);
  if (!res.ok) throw new Error('Failed to fetch dicts');
  return res.json();
}

/**
 * 删除词典（使用更长超时，因为删除大型词典数据库记录需要时间）
 */
export async function deleteDict(dictName: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/${dictName}`, 30000, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete dict');
}

/**
 * 导入词典
 * @param file - MDX 文件
 * @param name - 可选的词典名称
 */
export function importDict(
  file: File, 
  name?: string, 
  onProgress?: (progress: number) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    if (name) formData.append('name', name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/dicts/import`);
    xhr.timeout = 600000; // 10 minutes timeout for large files

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percentComplete = (event.loaded / event.total) * 100;
        onProgress(percentComplete);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response);
        } catch (e) {
          // If response is not JSON
          resolve(xhr.responseText);
        }
      } else {
        try {
           const errorData = JSON.parse(xhr.responseText);
           reject(new Error(errorData.detail || 'Import failed'));
        } catch {
           reject(new Error(`Import failed with status ${xhr.status}`));
        }
      }
    };

    xhr.onerror = () => reject(new Error('Network error during import'));
    xhr.ontimeout = () => reject(new Error('Import timed out (limit: 10 minutes)'));

    xhr.send(formData);
  });
}

/**
 * 设置词典优先级
 */
export async function setDictPriority(priority: string[]): Promise<{ message: string; priority: string[] }> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/priority`, 5000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority }),
  });
  if (!res.ok) throw new Error('Failed to set priority');
  return res.json();
}

/**
 * 切换词典启用状态
 */
export async function toggleDict(dictName: string, active: boolean): Promise<{ message: string; dict_name: string; is_active: boolean }> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/${dictName}/toggle`, 5000, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new Error('Failed to toggle dict');
  return res.json();
}

/**
 * 获取词典详细信息
 */
export async function getDictInfo(dictName: string): Promise<DictInfo> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/${dictName}/info`, 5000);
  if (!res.ok) throw new Error('Failed to get dict info');
  return res.json();
}

/**
 * 在指定词典中查询单词
 */
export async function lookupInDict(dictName: string, word: string): Promise<any> {
  const res = await fetchWithTimeout(`${API_URL}/api/dicts/${dictName}/lookup`, 5000, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word }),
  });
  if (!res.ok) throw new Error('Failed to lookup word in dict');
  return res.json();
}

/**
 * 获取当前 API URL
 */
export function getApiUrl(): string {
  return API_URL;
}

/**
 * 获取设置
 */
export function getSettings(): { apiUrl: string } {
  if (typeof window === 'undefined') {
    return { apiUrl: API_URL };
  }

  const stored = localStorage.getItem('duodushu_settings');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return { apiUrl: API_URL };
    }
  }

  return { apiUrl: API_URL };
}

/**
 * 保存设置
 */
export function saveSettings(settings: { apiUrl: string }): void {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem('duodushu_settings', JSON.stringify(settings));
}
/**
 * 检查翻译功能是否已配置（是否有活跃且有效的供应商）
 */
export async function checkTranslationConfigured(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/config/suppliers-status`);
    if (!res.ok) return false;
    const data = await res.json();
    
    // 必须有活跃的供应商
    if (!data.active_supplier) return false;
    
    // 且该供应商必须已配置
    const active = data.suppliers.find((s: any) => s.type === data.active_supplier);
    return active && active.configured;
  } catch (e) {
    console.error("Failed to check translation config:", e);
    // 发生错误时保守返回 false，避免无效请求
    return false;
  }
}
