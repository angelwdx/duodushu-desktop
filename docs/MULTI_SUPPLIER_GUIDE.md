# 多供应商AI配置指南

## 概述

多读书桌面版现已支持多个AI供应商的配置和使用，包括：

- **Google Gemini** - Gemini 3 Pro, Gemini 2.5 Pro, Gemini 2.0 Flash Thinking
- **OpenAI** - GPT-5, GPT-5.2, GPT-4o
- **Anthropic Claude** - Claude Opus 4.5, Claude Sonnet 4.5
- **DeepSeek** - DeepSeek V3.2, DeepSeek R1
- **Alibaba Qwen (通义千问)** - Qwen3-Max-Thinking, Qwen3-235B-A22B
- **自定义OpenAI兼容** - 任何兼容OpenAI API格式的服务

## 功能特性

### ✅ 已实现功能

1. **多供应商配置**
   - 同时配置多个AI供应商
   - 每个供应商独立的API密钥和模型选择
   - 配置持久化存储

2. **模型选择**
   - 预设最新2-3个模型
   - 支持自定义输入模型名称
   - 显示模型描述和上下文长度

3. **连接测试**
   - 测试API密钥有效性
   - 验证连接状态
   - 显示详细错误信息

4. **活跃供应商管理**
   - 设置默认使用的供应商
   - 快速切换不同供应商

## 使用指南

### 配置步骤

1. **打开设置对话框**
   - 点击首页右上角的设置图标（齿轮）
   - 进入"AI 供应商配置"

2. **选择供应商**
   - 每个供应商都有独立的配置卡片
   - 输入API密钥
   - 选择模型或自定义模型名称

3. **测试连接**
   - 点击"测试连接"按钮
   - 等待测试结果
   - 确认连接成功

4. **保存配置**
   - 点击"保存配置"按钮
   - 配置会自动保存

### 自定义供应商

对于自定义OpenAI兼容服务：

1. 选择"自定义OpenAI兼容"供应商
2. 输入API端点URL（例如：`https://api.example.com/v1`）
3. 输入API密钥
4. 输入模型名称（例如：`gpt-3.5-turbo`）

## API参考

### 后端API端点

#### 获取供应商列表
```
GET /api/config/suppliers
```

#### 获取供应商模型
```
GET /api/config/suppliers/{supplier_type}/models
```

#### 获取供应商配置状态
```
GET /api/config/suppliers-status
```

#### 保存供应商配置
```
POST /api/config/suppliers
Content-Type: application/json

{
  "supplier_type": "gemini",
  "api_key": "your-api-key",
  "model": "gemini-3.0-pro",
  "custom_model": "",
  "api_endpoint": ""
}
```

#### 删除供应商配置
```
DELETE /api/config/suppliers/{supplier_type}
```

#### 测试API连接
```
POST /api/config/test-connection
Content-Type: application/json

{
  "supplier_type": "gemini",
  "api_key": "your-api-key",
  "model": "gemini-3.0-pro"
}
```

#### 设置活跃供应商
```
POST /api/config/set-active-supplier
Content-Type: application/json

{
  "supplier_type": "gemini"
}
```

## 配置文件格式

配置保存在 `backend/data/app_config.json`:

```json
{
  "suppliers": {
    "gemini": {
      "name": "Google Gemini",
      "api_key": "your-api-key",
      "api_endpoint": "https://generativelanguage.googleapis.com",
      "model": "gemini-3.0-pro",
      "custom_model": "",
      "enabled": true,
      "is_active": true
    },
    "deepseek": {
      "name": "DeepSeek",
      "api_key": "your-api-key",
      "api_endpoint": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "custom_model": "",
      "enabled": true,
      "is_active": false
    }
  },
  "active_supplier": "gemini"
}
```

## 模型参考（2026年1月）

### Google Gemini
- `gemini-3.0-pro` - 最新旗舰模型，深度推理能力
- `gemini-2.5-pro` - 高级模型
- `gemini-2.0-flash-thinking` - 快速思考模型

### OpenAI
- `gpt-5` - 开发模型，专为编码优化
- `gpt-5.2` - 企业级模型
- `gpt-4o` - 成熟稳定模型

### Anthropic Claude
- `claude-opus-4.5` - 最强编程模型
- `claude-sonnet-4.5` - 平衡智能和速度

### DeepSeek
- `deepseek-v3.2` - 当前旗舰，671B参数
- `deepseek-r1` - 推理模型
- `deepseek-chat` - 对话模型

### Alibaba Qwen
- `qwen3-max-thinking` - 最新旗舰推理模型
- `qwen3-235b-a22b` - 高性能模型
- `qwen3-coder-480b` - 编码专用模型

## 依赖项

后端需要安装以下Python包：

```bash
pip install google-generativeai
pip install openai
pip install anthropic
pip install httpx
```

## 故障排除

### 常见问题

1. **连接测试失败**
   - 检查API密钥是否正确
   - 确认网络连接正常
   - 验证API端点URL是否正确

2. **模型未显示**
   - 某些供应商可能没有预设模型
   - 使用自定义模型输入

3. **配置未保存**
   - 检查 `backend/data/app_config.json` 文件权限
   - 确保后端服务正在运行

## 参考链接

- [Google AI Studio](https://aistudio.google.com/app/apikey)
- [OpenAI API Keys](https://platform.openai.com/api-keys)
- [Anthropic Console](https://console.anthropic.com/settings/keys)
- [DeepSeek Platform](https://platform.deepseek.com/api_keys)
- [Alibaba Qwen](https://dashscope.aliyun.com/api)
