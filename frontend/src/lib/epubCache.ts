"use client";

/**
 * EPUB 文件的 IndexedDB 缓存工具
 * 用于缓存已下载的 EPUB 文件，避免重复下载
 */

import { createLogger } from './logger';

const log = createLogger('EPUBCache');

const DB_NAME = "epub-cache";
const DB_VERSION = 2; // Increment version to add new store
const STORE_NAME = "epubFiles";
const PROGRESS_STORE_NAME = "epubProgress";

interface CacheEntry {
  url: string;
  data: ArrayBuffer;
  timestamp: number;
  size: number;
}

interface EpubSettings {
  fontSize?: number;
  theme?: string;
  fontFamily?: 'serif' | 'sans';
  lineHeight?: number;
  fitMode?: 'page' | 'width';
}

interface ProgressEntry {
  bookId: string;
  cfi?: string; // Optional now because we might save only settings
  percentage?: number;
  settings?: EpubSettings;
  timestamp: number;
}

/**
 * 打开或创建 IndexedDB 数据库
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "url" });
        store.createIndex("timestamp", "timestamp", { unique: false });
      }
      if (!db.objectStoreNames.contains(PROGRESS_STORE_NAME)) {
        const progressStore = db.createObjectStore(PROGRESS_STORE_NAME, {
          keyPath: "bookId",
        });
        progressStore.createIndex("timestamp", "timestamp", { unique: false });
      }
    };
  });
}

/**
 * 从缓存中获取 EPUB 文件
 * @param url EPUB 文件的 URL
 * @returns ArrayBuffer 或 null（如果未缓存）
 */
export async function getCachedEpub(url: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(url);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (entry) {
          log.debug(`Cache hit for ${url}, size: ${(entry.size / 1024 / 1024).toFixed(2)}MB`);
          resolve(entry.data);
        } else {
          log.debug(`Cache miss for ${url}`);
          resolve(null);
        }
      };
    });
  } catch (error) {
    log.warn('Failed to get from cache:', error);
    return null;
  }
}

/**
 * 将 EPUB 文件存储到缓存
 * @param url EPUB 文件的 URL
 * @param data EPUB 文件的 ArrayBuffer
 */
export async function cacheEpub(url: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      const entry: CacheEntry = {
        url,
        data,
        timestamp: Date.now(),
        size: data.byteLength,
      };

      const request = store.put(entry);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        log.debug(`Cached ${url}, size: ${(data.byteLength / 1024 / 1024).toFixed(2)}MB`);
        resolve();
      };
    });
  } catch (error) {
    log.warn('Failed to cache:', error);
  }
}

/**
 * 清除所有缓存
 */
export async function clearEpubCache(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        log.debug('Cache cleared');
        resolve();
      };
    });
  } catch (error) {
    log.warn('Failed to clear cache:', error);
  }
}

/**
 * 获取缓存统计信息
 */
export async function getEpubCacheStats(): Promise<{
  count: number;
  totalSize: number;
}> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const entries = request.result as CacheEntry[];
        const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
        resolve({ count: entries.length, totalSize });
      };
    });
  } catch (error) {
    log.warn('Failed to get stats:', error);
    return { count: 0, totalSize: 0 };
  }
}

/**
 * 保存 EPUB 阅读状态（进度、设置等）
 * 支持部分更新（合并现有状态）
 */
export async function saveEpubState(
  bookId: string,
  state: {
    cfi?: string;
    percentage?: number;
    settings?: EpubSettings;
  }
): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(PROGRESS_STORE_NAME, "readwrite");
      const store = transaction.objectStore(PROGRESS_STORE_NAME);

      // Read existing first to merge
      const getRequest = store.get(bookId);

      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        const existing = getRequest.result as ProgressEntry | undefined;

        // Merge settings specifically
        const newSettings = {
          ...(existing?.settings || {}),
          ...(state.settings || {}),
        };

        const entry: ProgressEntry = {
          bookId,
          timestamp: Date.now(),
          ...existing, // Keep existing data
          ...state, // Overwrite with new data
          settings: newSettings, // Merged settings
        };

        const putRequest = store.put(entry);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => {
          resolve();
        };
      };
    });
  } catch (error) {
    log.warn('Failed to save state:', error);
  }
}

/**
 * 获取 EPUB 阅读进度（优先返回 CFI）
 * @param bookId 书籍 ID
 * @returns 进度信息或 null（如果没有保存的进度）
 */
export async function getEpubState(
  bookId: string
): Promise<ProgressEntry | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(PROGRESS_STORE_NAME, "readonly");
      const store = transaction.objectStore(PROGRESS_STORE_NAME);
      const request = store.get(bookId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const entry = request.result as ProgressEntry | undefined;
        if (entry) {
          log.debug(`Progress found for ${bookId}: ${entry.percentage}%`);
          resolve(entry);
        } else {
          log.debug(`No progress found for ${bookId}`);
          resolve(null);
        }
      };
    });
  } catch (error) {
    log.warn('Failed to get progress:', error);
    return null;
  }
}

/**
 * 删除 EPUB 阅读进度
 * @param bookId 书籍 ID
 */
export async function deleteEpubProgress(bookId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(PROGRESS_STORE_NAME, "readwrite");
      const store = transaction.objectStore(PROGRESS_STORE_NAME);
      const request = store.delete(bookId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        log.debug(`Deleted progress for ${bookId}`);
        resolve();
      };
    });
  } catch (error) {
    log.warn('Failed to delete progress:', error);
  }
}
