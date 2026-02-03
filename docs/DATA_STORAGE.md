# 数据存储详解

**最后更新**: 2026-01-30

本文档详细说明应用的数据存储机制、三种模式的区别和数据迁移方法。

## 1. 三种存储模式

### 模式 1: 开发模式 (Development)

**使用场景**: 本地开发调试

**数据位置**: `backend/data/`

**特点**:
- 数据存储在项目目录下
- 便于开发和调试
- 不影响系统其他部分
- **支持自定义**: 可通过 `APP_DATA_DIR` 环境变量指定数据目录

**目录结构**:
```
backend/data/
├── app.db              # SQLite 数据库
├── uploads/            # 上传的书籍文件
│   ├── book1.pdf
│   ├── book2.epub
│   └── covers/         # 书籍封面
├── dicts/              # 词典数据
│   ├── ecdict.db
│   └── ...
└── logs/               # 应用日志
```

### 模式 2: 便携模式 (Portable)

**使用场景**: 绿色软件、U 盘运行、跨电脑迁移

**数据位置**: `exe 同级的 data/` 目录

**特点**:
- 应用和数据完全独立
- 可以整体复制到任何地方运行
- 不写入系统注册表或 AppData
- 完全离线运行

**目录结构**:
```
Duodushu/                  # 应用根目录
├── Duodushu.exe
├── resources/
├── ...
└── data/                  # 便携数据目录
    ├── app.db
    ├── uploads/
    └── dicts/
```

**启动逻辑**:
```javascript
// electron/main.ts
const appPath = app.getAppPath();
const localDataPath = path.join(appPath, '..', 'data');

if (fs.existsSync(localDataPath)) {
    // 便携模式：使用 exe 同级的 data 目录
    userDataPath = localDataPath;
} else {
    // 标准模式：使用系统 AppData 目录
    userDataPath = app.getPath('userData');
}
```

### 模式 3: 标准安装模式 (Standard)

**使用场景**: 正式安装、系统集成

**数据位置**: `C:\Users\<username>\AppData\Roaming\duodushu-desktop\`

**特点**:
- 遵循 Windows 应用标准
- 数据与应用分离
- 支持多用户
- 卸载时可选择保留数据

**目录结构**:
```
C:\Users\<username>\AppData\Roaming\duodushu-desktop\
├── app.db
├── uploads/
└── dicts/
```

## 2. 数据库结构

### SQLite 数据库 (app.db)

主要表：

| 表名 | 说明 |
|------|------|
| `books` | 书籍元数据 (标题、作者、路径等) |
| `bookmarks` | 书签 |
| `notes` | 笔记 |
| `vocabulary` | 生词本 (包含复习优先级字段) |
| `reading_progress` | 阅读进度 |
| `settings` | 应用设置 |
| `pages` | 书籍页面文本内容 |
| `pages_fts` | 全文搜索虚拟表 (FTS5) |

**vocabulary 表新增字段**:
- `query_count`: 查询次数 (Integer)
- `last_queried_at`: 最后查询时间 (Timestamp)
- `priority_score`: 复习优先级分数 (Float)
- `learning_status`: 学习状态 (String: 'new', 'learning', 'mastered')

### 全文搜索 (FTS5)

应用使用 SQLite 的 FTS5 扩展实现高性能的本地全文搜索。

- **pages_fts 表**: 这是一个虚拟表，自动与 `pages` 表同步。
- **触发器**: 数据库包含 `INSERT`, `UPDATE`, `DELETE` 触发器，确保 `pages` 表的变更实时反映在 `pages_fts` 中。
- **功能**: 支持快速的关键词搜索、布尔查询和上下文摘录 (Snippet)。

### 文件存储

**uploads/** 目录结构:
```
uploads/
├── book_id_1/
│   ├── content.pdf
│   ├── content.epub
│   └── metadata.json
├── book_id_2/
│   └── ...
└── covers/
    ├── book_id_1.jpg
    ├── book_id_2.jpg
    └── ...
```

**dicts/** 目录结构:
```
dicts/
├── ecdict.db           # 英文词典
├── mdx_index.json      # MDX 词典索引
└── ...
```

## 3. 数据迁移指南

### 场景 1: Web 版 → 桌面版

如果你在 Web 版上有数据，想迁移到桌面版：

1. **导出 Web 版数据**:
   - 从 Web 版的数据目录获取 `app.db`
   - 复制 `uploads/` 目录
   - 复制 `dicts/` 目录

2. **导入到桌面版**:
   ```bash
   # 便携模式
   cp app.db Duodushu/data/
   cp -r uploads/* Duodushu/data/uploads/
   cp -r dicts/* Duodushu/data/dicts/

   # 标准模式
   cp app.db "C:\Users\<username>\AppData\Roaming\duodushu-desktop\"
   cp -r uploads/* "C:\Users\<username>\AppData\Roaming\duodushu-desktop\uploads\"
   cp -r dicts/* "C:\Users\<username>\AppData\Roaming\duodushu-desktop\dicts\"
   ```

3. **重启应用**，数据会自动加载

### 场景 2: 电脑 A → 电脑 B (便携模式)

最简单的迁移方式：

1. 在电脑 A 上使用应用，所有数据存储在 `Duodushu/data/`
2. 将整个 `Duodushu` 文件夹复制到 U 盘或网络存储
3. 在电脑 B 上运行 U 盘中的 `Duodushu.exe`
4. 所有数据自动恢复

### 场景 3: 电脑 A → 电脑 B (标准模式)

1. **在电脑 A 上备份数据**:
   ```bash
   # 复制整个数据目录
   xcopy "C:\Users\<username>\AppData\Roaming\duodushu-desktop" backup\ /E /I
   ```

2. **在电脑 B 上恢复数据**:
   ```bash
   # 粘贴到相同位置
   xcopy backup "C:\Users\<username>\AppData\Roaming\duodushu-desktop" /E /I
   ```

3. **重启应用**

### 场景 4: 便携模式 → 标准模式

1. 复制 `Duodushu/data/` 中的所有文件到系统 AppData 目录
2. 删除 exe 同级的 `data` 目录
3. 重启应用

### 场景 5: 标准模式 → 便携模式

1. 复制系统 AppData 目录中的所有文件到 `Duodushu/data/`
2. 重启应用

## 4. 数据备份

### 自动备份

应用启动时会自动检查数据完整性，但不会自动备份。

### 手动备份

**便携模式**:
```bash
# 复制整个应用目录
xcopy Duodushu backup_Duodushu /E /I
```

**标准模式**:
```bash
# 复制数据目录
xcopy "C:\Users\<username>\AppData\Roaming\duodushu-desktop" backup_duodushu /E /I
```

### 定期备份建议

- 每周备份一次
- 重要数据立即备份
- 保留至少 3 个备份副本

## 5. 数据安全

### 隐私保护

- 所有数据存储在本地，不上传云端
- API Key 使用系统 Keychain 加密存储
- 支持离线运行

### 数据恢复

- 数据库损坏时，应用会自动创建新数据库
- 可以从备份恢复数据
- 书籍文件独立存储，不会因数据库损坏而丢失

## 6. 常见问题

**Q: 便携模式下数据会丢失吗？**
- 不会。只要 `data` 目录存在，数据就会保留。

**Q: 如何清空所有数据？**
- 便携模式：删除 `data` 目录
- 标准模式：删除 `C:\Users\<username>\AppData\Roaming\duodushu-desktop\` 目录

**Q: 数据库损坏了怎么办？**
- 删除 `app.db` 文件，应用会自动创建新数据库
- 书籍文件会保留在 `uploads/` 目录中

**Q: 可以在多台电脑上同时使用同一个数据目录吗？**
- 不建议。这可能导致数据冲突。建议使用便携模式时，一次只在一台电脑上运行。

更多问题见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
