"use client";

import React, { useState, useEffect } from 'react';
import ModelSelector from './ModelSelector';

export interface Supplier {
  type: string;
  name: string;
  description: string;
  configured: boolean;
  model?: string;
  is_active?: boolean;
  requires_endpoint?: boolean;
}

interface SupplierFormProps {
  supplier: Supplier;
  apiKey: string;
  model: string;
  customModel: string;
  apiEndpoint: string;
  models: Array<{ id: string; name: string; description: string; context_length: number }>;
  testing: boolean;
  testResult: { success?: boolean; message?: string } | null;
  onApiKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  onCustomModelChange: (model: string) => void;
  onApiEndpointChange: (endpoint: string) => void;
  onTestConnection: () => void;
  onSave: () => void;
  onDelete: () => void;
}

export default function SupplierForm({
  supplier,
  apiKey,
  model,
  customModel,
  apiEndpoint,
  models,
  testing,
  testResult,
  onApiKeyChange,
  onModelChange,
  onCustomModelChange,
  onApiEndpointChange,
  onTestConnection,
  onSave,
  onDelete,
}: SupplierFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);

  const canSave = apiKey && (supplier.requires_endpoint ? apiEndpoint : true);
  const hasConfigured = supplier.configured;

  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-4">
      {/* 供应商标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            {supplier.name}
            {hasConfigured && (
              <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                ✓ 已配置
              </span>
            )}
            {supplier.is_active && (
              <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                活跃
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">{supplier.description}</p>
        </div>

        {/* 删除按钮 */}
        {hasConfigured && (
          <button
            onClick={onDelete}
            className="text-red-600 hover:text-red-700 text-sm font-medium transition-colors"
          >
            删除配置
          </button>
        )}
      </div>

      {/* API Key 输入 */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          API Key
        </label>
        <div className="relative">
          <input
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={hasConfigured ? "已配置（留空保持不变）" : "输入你的 API Key"}
            className="w-full px-3 py-2 pr-20 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="text-gray-400 hover:text-gray-600 text-xs px-2 py-1"
            >
              {showApiKey ? "隐藏" : "显示"}
            </button>
          </div>
        </div>
      </div>

      {/* 自定义API端点（仅自定义供应商） */}
      {supplier.requires_endpoint && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            API 端点 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={apiEndpoint}
            onChange={(e) => onApiEndpointChange(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          <p className="mt-1 text-xs text-gray-500">
            支持任何兼容 OpenAI API 格式的服务端点
          </p>
        </div>
      )}

      {/* 模型选择 */}
      {models.length > 0 && (
        <ModelSelector
          models={models}
          selectedModel={model}
          customModel={customModel}
          onModelChange={onModelChange}
          onCustomModelChange={onCustomModelChange}
        />
      )}

      {/* 测试连接和保存按钮 */}
      <div className="flex gap-2 pt-2">
        {/* 测试连接按钮 */}
        <button
          type="button"
          onClick={onTestConnection}
          disabled={!apiKey || testing}
          className="px-3 py-2 text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 disabled:text-gray-400 rounded-md transition-colors text-sm font-medium flex items-center gap-1"
        >
          {testing ? (
            <>
              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              测试中...
            </>
          ) : (
            "测试连接"
          )}
        </button>

        {/* 保存按钮 */}
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className="flex-1 px-3 py-2 bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 rounded-md transition-colors text-sm font-medium"
        >
          {hasConfigured ? "更新配置" : "保存配置"}
        </button>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={`p-3 rounded-md text-sm ${
          testResult.success
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}
