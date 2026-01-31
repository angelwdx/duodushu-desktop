"use client";

import React, { useState, useEffect } from 'react';

interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
}

interface ModelSelectorProps {
  models: Model[];
  selectedModel: string;
  customModel: string;
  onModelChange: (model: string) => void;
  onCustomModelChange: (model: string) => void;
  disabled?: boolean;
}

export default function ModelSelector({
  models,
  selectedModel,
  customModel,
  onModelChange,
  onCustomModelChange,
  disabled = false,
}: ModelSelectorProps) {
  const [isCustom, setIsCustom] = useState(false);

  useEffect(() => {
    // 如果选中的模型不在预设列表中，则使用自定义模式
    if (selectedModel && !models.find(m => m.id === selectedModel)) {
      setIsCustom(true);
    } else {
      setIsCustom(false);
    }
  }, [selectedModel, models]);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === "__custom__") {
      setIsCustom(true);
      onModelChange("");
    } else {
      setIsCustom(false);
      onModelChange(value);
      onCustomModelChange("");
    }
  };

  const handleCustomInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onCustomModelChange(e.target.value);
    onModelChange(e.target.value);
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        模型选择
      </label>

      {/* 预设模型下拉框 */}
      <select
        value={isCustom ? "__custom__" : selectedModel}
        onChange={handleSelectChange}
        disabled={disabled}
        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
      >
        <option value="">-- 请选择模型 --</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} {model.context_length > 0 && `(${model.context_length.toLocaleString()} 上下文)`}
          </option>
        ))}
        <option value="__custom__">自定义模型...</option>
      </select>

      {/* 自定义模型输入框 */}
      {isCustom && (
        <input
          type="text"
          value={customModel}
          onChange={handleCustomInputChange}
          placeholder="输入自定义模型名称，例如: gpt-4-turbo-preview"
          disabled={disabled}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
        />
      )}

      {/* 模型描述 */}
      {!isCustom && selectedModel && models.find(m => m.id === selectedModel) && (
        <p className="text-xs text-gray-500 mt-1">
          {models.find(m => m.id === selectedModel)?.description}
        </p>
      )}
    </div>
  );
}
