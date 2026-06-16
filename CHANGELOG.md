# Changelog

All notable changes to Duodushu Desktop will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-06-16

### Added
- 支持韩语词典查询与词干提取
- 动态检测页面文本中的韩语语言用于 TTS
- 优化韩语查询词项优先级排序并添加相关测试

### Fixed
- 修复阅读器底部弹层遮挡问题
- 修复韩语 TTS 回退设置
- 更新测试以反映书籍语言检测逻辑改进（优先文本特征而非 metadata）

### Technical
- 改进书籍语言检测逻辑：优先根据文本特征判断，避免错误的 metadata 误导

## [1.2.2] - Previous Release
- See GitHub release notes for details

---

## Links
- [GitHub Releases](https://github.com/angelwdx/duodushu-desktop/releases)
- [Documentation](./docs/)

[1.2.3]: https://github.com/angelwdx/duodushu-desktop/releases/tag/v1.2.3
[1.2.2]: https://github.com/angelwdx/duodushu-desktop/releases/tag/v1.2.2
