/**
 * 统一的日志工具
 * 通过环境变量控制日志级别，生产环境自动关闭所有日志
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

// 从环境变量读取日志级别，默认为 'info'（开发环境）
const LOG_LEVEL: LogLevel =
  (process.env.NEXT_PUBLIC_LOG_LEVEL as LogLevel) ||
  (process.env.NODE_ENV === 'production' ? 'none' : 'info');

// 日志优先级
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 999,
};

// 是否应该输出日志
const shouldLog = (level: LogLevel): boolean => {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[LOG_LEVEL];
};

// 日志前缀生成器
const getPrefix = (module: string): string => {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  return `[${timestamp}] [${module}]`;
};

export const logger = {
  debug: (module: string, message: any, ...args: any[]) => {
    if (shouldLog('debug')) {
      console.log(`${getPrefix(module)} DEBUG:`, message, ...args);
    }
  },

  info: (module: string, message: any, ...args: any[]) => {
    if (shouldLog('info')) {
      console.log(`${getPrefix(module)} INFO:`, message, ...args);
    }
  },

  warn: (module: string, message: any, ...args: any[]) => {
    if (shouldLog('warn')) {
      console.warn(`${getPrefix(module)} WARN:`, message, ...args);
    }
  },

  error: (module: string, message: any, ...args: any[]) => {
    if (shouldLog('error')) {
      console.error(`${getPrefix(module)} ERROR:`, message, ...args);
    }
  },
};

// 快捷方法，用于组件内调用
export const createLogger = (module: string) => ({
  debug: (message: any, ...args: any[]) => logger.debug(module, message, ...args),
  info: (message: any, ...args: any[]) => logger.info(module, message, ...args),
  warn: (message: any, ...args: any[]) => logger.warn(module, message, ...args),
  error: (message: any, ...args: any[]) => logger.error(module, message, ...args),
});
