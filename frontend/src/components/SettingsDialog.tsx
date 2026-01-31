/* eslint-disable @next/next/no-img-element */
"use client";

import React, { useState, useEffect } from 'react';
import { getApiUrl } from '../lib/api';
// type definition to match partial update
interface Supplier {
  type: string;
  name: string;
  description: string;
  configured: boolean;
  is_active?: boolean; // Make optional if backend doesn't always send
  model?: string;
  custom_model?: string;
  api_endpoint?: string;
  requires_endpoint: boolean;
  api_key_url?: string;
  default_api_endpoint?: string;
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface SupplierModels {
  [key: string]: Array<{ id: string; name: string; description: string; context_length: number }>;
}

interface SupplierState {
  apiKey: string;
  model: string;
  customModel: string;
  apiEndpoint: string;
}

export default function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierModels, setSupplierModels] = useState<SupplierModels>({});
  
  // Data for all suppliers
  const [supplierStates, setSupplierStates] = useState<{ [key: string]: SupplierState }>({});
  
  // Currently selected supplier type in the dropdown
  const [selectedSupplierType, setSelectedSupplierType] = useState<string>('');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load data when dialog opens
  useEffect(() => {
    const init = async () => {
      if (isOpen) {
        const allSuppliers = await loadSuppliers();
        await loadSupplierStatus(allSuppliers);
      }
    };
    init();
  }, [isOpen]);

  // Set default selected supplier and initial endpoint if not set
  useEffect(() => {
    if (!selectedSupplierType && suppliers.length > 0) {
      const active = suppliers.find(s => s.is_active) || suppliers[0];
      setSelectedSupplierType(active.type);
      
      // Auto-fill initial endpoint
      if (active.default_api_endpoint) {
        setSupplierStates(prev => ({
          ...prev,
          [active.type]: {
            ...prev[active.type],
            apiEndpoint: prev[active.type]?.apiEndpoint || active.default_api_endpoint || ""
          }
        }));
      }
    }
  }, [suppliers, selectedSupplierType]);

  const loadSuppliers = async () => {
    try {
      const response = await fetch(`${getApiUrl()}/api/config/suppliers`);
      if (response.ok) {
        const data = await response.json();
        setSuppliers(data.suppliers);

        // Load models for each supplier
        const models: SupplierModels = {};
        for (const supplier of data.suppliers) {
          try {
            const modelResponse = await fetch(`${getApiUrl()}/api/config/suppliers/${supplier.type}/models`);
            if (modelResponse.ok) {
              const modelData = await modelResponse.json();
              models[supplier.type] = modelData.models;
            }
          } catch (error) {
            console.error(`Failed to load models for ${supplier.type}:`, error);
          }
        }
        setSupplierModels(models);
        return data.suppliers as Supplier[];
      }
    } catch (error) {
      console.error('Failed to load suppliers:', error);
    }
    return [];
  };

  const loadSupplierStatus = async (allSuppliers?: Supplier[]) => {
    try {
      const response = await fetch(`${getApiUrl()}/api/config/suppliers-status`);
      if (response.ok) {
        const data = await response.json();
        // Update suppliers list (might have active status updates)
        setSuppliers(data.suppliers);

        const currentAllSuppliers = allSuppliers || suppliers;

        // Initialize states
        const states: { [key: string]: SupplierState } = {};
        for (const supplier of data.suppliers) {
          // Find matching supplier to get default_api_endpoint if needed
          const preset = currentAllSuppliers.find(s => s.type === supplier.type);
          
          states[supplier.type] = {
            apiKey: '', 
            model: supplier.model || '',
            customModel: supplier.custom_model || '',
            apiEndpoint: supplier.api_endpoint || (supplier.type !== 'custom' ? (preset?.default_api_endpoint || supplier.api_endpoint) : '') || '',
          };
        }
        setSupplierStates(states);
      }
    } catch (error) {
      console.error('Failed to load supplier status:', error);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedSupplierType) return;
    
    const state = supplierStates[selectedSupplierType];
    const supplier = suppliers.find(s => s.type === selectedSupplierType);
    
    if (!state.apiKey && !supplier?.configured) {
       // If not configured and no key entered, warn
       setTestResult({ success: false, message: '请先输入 API Key' });
       return;
    }

    setTesting(true);
    setTestResult(null);

    // If apiKey is empty but it's configured, the backend might use the stored one?
    // The previous implementation required entering the key to test.
    // "please input API Key" check suggests we need it in state.
    // However, for a better UX, if it's already configured, we should be able to test without re-entering.
    // But the backend test-connection endpoint takes `api_key` param.
    // If the backend supports testing with stored key if parameter is empty, we'd do that.
    // Let's assume for now we send what's in the state. 
    
    try {
        const response = await fetch(`${getApiUrl()}/api/config/test-connection`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                supplier_type: selectedSupplierType,
                api_key: state.apiKey, // If empty, backend might fail if it doesn't look up stored one.
                api_endpoint: state.apiEndpoint,
                model: state.customModel || state.model,
            }),
        });

        const result = await response.json();
        setTestResult(result);
    } catch (error) {
        setTestResult({ success: false, message: '连接测试失败，请检查网络' });
    } finally {
        setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!selectedSupplierType) return;
    const state = supplierStates[selectedSupplierType];
    
    // Basic validation
    // If we are updating, we might allow empty key if we just want to change model?
    // But usually saving overwrites.
    
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch(`${getApiUrl()}/api/config/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_type: selectedSupplierType,
          api_key: state.apiKey,
          model: state.model,
          custom_model: state.customModel,
          api_endpoint: state.apiEndpoint,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        // setMessage({ type: 'success', text: data.message || '配置已保存' });
        // Close on success or show success? Screenshot shows "Save Config" button.
        // Maybe close after short delay or just show success message.
        // Let's just close to be efficient or keep open.
        // User might want to configure others.
        onClose(); // As per screenshot, usually "Save" implies done. 
        // Or we can just refresh status.
        // await loadSupplierStatus();
      } else {
        const error = await response.json();
        setMessage({ type: 'error', text: error.detail || '保存失败' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: '保存失败，请检查网络连接' });
    } finally {
        setLoading(false);
    }
  };

  const currentSupplier = suppliers.find(s => s.type === selectedSupplierType);
  const currentState = selectedSupplierType ? supplierStates[selectedSupplierType] : null;
  const currentModels = selectedSupplierType ? supplierModels[selectedSupplierType] || [] : [];

  const updateState = (key: keyof SupplierState, value: string) => {
    if (!selectedSupplierType) return;
    setSupplierStates(prev => ({
      ...prev,
      [selectedSupplierType]: {
        ...prev[selectedSupplierType],
        [key]: value
      }
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-200" 
           style={{ boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)" }}>
        
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 002.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            配置接口
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-full hover:bg-gray-100"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
           
           {/* Global Message */}
           {message && (
             <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
               message.type === 'success' 
                 ? 'bg-green-50 text-green-700 border border-green-200' 
                 : 'bg-red-50 text-red-700 border border-red-200'
             }`}>
               {message.type === 'success' ? '✅' : '⚠️'} {message.text}
             </div>
           )}

           {/* Supplier Provider */}
           <div className="space-y-2">
             <label className="block text-sm font-bold text-gray-400 flex items-center gap-2">
               🏢 模型提供商
             </label>
             <div className="relative">
               <select
                 value={selectedSupplierType}
                 onChange={(e) => {
                    const type = e.target.value;
                    setSelectedSupplierType(type);
                    setMessage(null);
                    setTestResult(null);
                    
                    // Auto-fill default endpoint if state is empty
                    const supplier = suppliers.find(s => s.type === type);
                    if (supplier && supplier.default_api_endpoint) {
                        setSupplierStates(prev => ({
                            ...prev,
                            [type]: {
                                ...prev[type],
                                apiEndpoint: prev[type]?.apiEndpoint || supplier.default_api_endpoint || ""
                            }
                        }));
                    }
                 }}
                 className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-black focus:border-transparent outline-none appearance-none cursor-pointer transition-all hover:bg-gray-100"
               >
                 {suppliers.map(s => (
                   <option key={s.type} value={s.type}>{s.name}</option>
                 ))}
               </select>
               <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                 </svg>
               </div>
             </div>
           </div>

           <div className="space-y-2">
             <label className="block text-sm font-bold text-gray-400 flex items-center gap-2">
               🔗 地址 (基本网址)
             </label>
             <input
               type="text"
               value={currentState?.apiEndpoint || ""}
               onChange={(e) => updateState('apiEndpoint', e.target.value)}
               placeholder={currentSupplier?.api_endpoint || currentSupplier?.default_api_endpoint || "https://..."}
               className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-black focus:border-transparent outline-none transition-all"
             />
           </div>

           {/* API Key */}
           <div className="space-y-1">
             <label className="block text-sm font-bold text-gray-400 flex items-center gap-2">
               🔑 API密钥
             </label>
             <input
               type="password"
               value={currentState?.apiKey || ''}
               onChange={(e) => updateState('apiKey', e.target.value)}
               placeholder={currentSupplier?.configured ? "已配置 (重新输入以更改)..." : "sk-..."}
               className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-black focus:border-transparent outline-none transition-all"
             />
             <div className="text-xs mt-2 flex items-center gap-1">
                               <span className="text-gray-400 font-medium">获取API密钥:</span> 
               {currentSupplier?.api_key_url ? (
                 <a href={currentSupplier.api_key_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 hover:underline transition-colors break-all">
                   {currentSupplier.api_key_url}
                 </a>
               ) : (
                 <span className="text-gray-400 italic ml-1">该提供商未提供获取链接</span>
               )}
             </div>
           </div>

             <div className="space-y-2">
               <label className="block text-sm font-bold text-gray-400 flex items-center gap-2">
                 🤖 文本模型名称 (TEXT MODEL)
               </label>
               <div className="relative">
                   <select
                     value={currentState?.model === currentState?.customModel && currentState?.customModel ? "__custom__" : (currentState?.model || "")}
                     onChange={(e) => {
                       const val = e.target.value;
                       if (val === "__custom__") {
                         updateState('model', currentState?.customModel || "__typing__");
                         if (!currentState?.customModel) updateState('customModel', "");
                       } else {
                         updateState('model', val);
                         updateState('customModel', "");
                       }
                     }}
                     className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-black focus:border-transparent outline-none appearance-none cursor-pointer transition-all hover:bg-gray-100"
                   >
                     {!currentState?.model && currentModels.length > 0 && <option value="" disabled>请选择模型...</option>}
                     {currentModels.map(m => (
                       <option key={m.id} value={m.id}>{m.name}</option>
                     ))}
                     <option value="__custom__">手动输入模型名称...</option>
                   </select>
                 <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                     </svg>
                 </div>
               </div>
               
               {/* Custom Model Input */}
               {(currentState?.model === "__typing__" || (currentState?.model === currentState?.customModel && currentState?.customModel) || currentModels.length === 0 || selectedSupplierType === 'custom') && (
                 <input
                   type="text"
                   value={currentState?.customModel || ""}
                   onChange={(e) => {
                     updateState('customModel', e.target.value);
                     updateState('model', e.target.value);
                   }}
                   autoFocus={currentState?.model === "__typing__"}
                   placeholder="输入自定义模型名称, 如: gpt-4-turbo"
                   className="w-full px-4 py-3 mt-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-900 text-sm focus:ring-2 focus:ring-black focus:border-transparent outline-none transition-all animate-in slide-in-from-top-2 duration-200"
                 />
               )}
             </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-5 flex items-center justify-between mt-auto">
          
          <div className="flex items-center gap-3">
             <button 
                onClick={handleTestConnection}
                disabled={testing}
                className="flex items-center gap-2 text-gray-400 hover:text-gray-600 text-sm transition-colors"
            >
                {testing ? (
                    <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                ) : (
                    <div className={`w-4 h-4 rounded-full border ${testResult ? (testResult.success ? 'bg-green-500 border-green-500' : 'bg-red-500 border-red-500') : 'border-gray-300'}`}></div>
                )}
                <span>测试连接</span>
             </button>
             {testResult && (
                 <span className={`text-xs ${testResult.success ? 'text-green-600' : 'text-red-500'}`}>
                     {testResult.success ? '成功' : '失败'}
                 </span>
             )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-6 py-2.5 text-gray-500 hover:text-gray-800 bg-white border border-gray-200 hover:border-gray-300 rounded-lg transition-all text-sm font-medium shadow-sm hover:shadow"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={loading}
              className="px-6 py-2.5 text-white bg-black hover:bg-gray-800 rounded-lg transition-all text-sm font-bold shadow-lg hover:shadow-xl disabled:opacity-70 disabled:cursor-not-allowed flex items-center gap-2"
            >
               {loading && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
               保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
