import React, { useState, useRef, useEffect } from 'react';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import { ProviderInfo } from '../lib/providers';

interface ModelPickerProps {
  provider: ProviderInfo;
  fastModel: string;
  proModel: string;
  onFastModelChange: (val: string) => void;
  onProModelChange: (val: string) => void;
}

export function ModelPicker({ provider, fastModel, proModel, onFastModelChange, onProModelChange }: ModelPickerProps) {
  const [openSlot, setOpenSlot] = useState<'fast' | 'pro' | null>(null);
  const fastRef = useRef<HTMLDivElement>(null);
  const proRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (openSlot === 'fast' && fastRef.current && !fastRef.current.contains(event.target as Node)) {
        setOpenSlot(null);
      }
      if (openSlot === 'pro' && proRef.current && !proRef.current.contains(event.target as Node)) {
        setOpenSlot(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openSlot]);

  const allModels = provider.models;

  const renderDropdown = (
    slot: 'fast' | 'pro',
    models: { id: string; name: string; isPro?: boolean; costPer1M?: number; lastVerified?: string }[],
    selectedValue: string,
    onSelect: (val: string) => void,
    containerRef: React.RefObject<HTMLDivElement | null>
  ) => {
    const isOpen = openSlot === slot;
    const selectedModel = models.find(m => m.id === selectedValue) || models[0];

    return (
      <div className="relative mt-1" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpenSlot(isOpen ? null : slot)}
          className="w-full flex items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2.5 hover:border-gray-400 hover:bg-gray-50 transition-all duration-200"
        >
          <div className="flex items-center space-x-3">
            <span className="font-medium text-gray-900">{selectedModel?.name ?? selectedValue}</span>
            {selectedModel?.isPro && (
              <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider bg-purple-100 text-purple-700 rounded-full">PRO</span>
            )}
            {selectedModel?.costPer1M !== undefined && (
              selectedModel.costPer1M === 0 ? (
                <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider bg-green-100 text-green-700 rounded-full">FREE</span>
              ) : (
                <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">${selectedModel.costPer1M}/1M</span>
              )
            )}
          </div>
          <ChevronDown className={`w-5 h-5 text-gray-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        {isOpen && (
          <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-72 overflow-y-auto p-1.5 flex flex-col gap-1.5">
            {models.map((m, idx) => {
              const isSelected = selectedValue === m.id;
              return (
                <div
                  key={`${m.id}-${idx}`}
                  onClick={() => {
                    onSelect(m.id);
                    setOpenSlot(null);
                  }}
                  className={`flex items-center justify-between p-3 rounded-lg cursor-pointer transition-all duration-200 ${
                    isSelected
                      ? 'bg-blue-50 text-blue-700 font-semibold'
                      : 'hover:bg-gray-50 text-gray-900'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <span>{m.name}</span>
                    {m.isPro && (
                      <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider bg-purple-100 text-purple-700 rounded-full">PRO</span>
                    )}
                    {m.costPer1M !== undefined && (
                      m.costPer1M === 0 ? (
                        <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider bg-green-100 text-green-700 rounded-full">FREE</span>
                      ) : (
                        <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">${m.costPer1M}/1M</span>
                      )
                    )}
                  </div>
                  {isSelected && <CheckCircle2 className="w-5 h-5 text-blue-500" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const fastModels = allModels.filter(m => !m.isPro);
  const proModels = allModels.filter(m => m.isPro);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">
          Fast Model
        </label>
        {renderDropdown('fast', fastModels, fastModel, onFastModelChange, fastRef)}
        <p className="text-xs text-gray-500 mt-2">Used for lightweight, quick tasks.</p>
        {fastModel === 'openrouter/free' && (
          <p className="text-xs italic text-gray-500 mt-1">
            OpenRouter automatically selects the best available free model per request.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">
          Pro Model
        </label>
        {renderDropdown('pro', proModels, proModel, onProModelChange, proRef)}
        <p className="text-xs text-gray-500 mt-2">Used for deep reasoning and generation.</p>
        {proModel === 'openrouter/free' && (
          <p className="text-xs italic text-gray-500 mt-1">
            OpenRouter automatically selects the best available free model per request.
          </p>
        )}
      </div>
    </div>
  );
}
