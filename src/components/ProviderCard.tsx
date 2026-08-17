import React from 'react';
import { ProviderInfo } from '../lib/providers';
import { Sparkles, Globe, Brain, Zap, CheckCircle2 } from 'lucide-react';

interface ProviderCardProps {
  provider: ProviderInfo;
  isSelected: boolean;
  onSelect: () => void;
}

const iconMap: Record<string, React.ElementType> = {
  Sparkles,
  Globe,
  Brain,
  Zap
};

export function ProviderCard({ provider, isSelected, onSelect }: ProviderCardProps) {
  const Icon = iconMap[provider.icon] || Globe;

  return (
    <div 
      onClick={onSelect}
      className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 flex items-start gap-4 ${
        isSelected 
          ? 'border-blue-500 bg-blue-50/50 shadow-sm' 
          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
      }`}
    >
      <div className={`p-2 rounded-lg ${isSelected ? 'bg-blue-100 text-blue-600' : 'bg-gray-100 text-gray-600'}`}>
        <Icon className="w-6 h-6" />
      </div>
      
      <div className="flex-1">
        <h3 className="font-semibold text-gray-900">{provider.name}</h3>
        <p className="text-sm text-gray-500 mt-1">{provider.description}</p>
      </div>

      {isSelected && (
        <div className="absolute top-4 right-4 text-blue-500">
          <CheckCircle2 className="w-5 h-5" />
        </div>
      )}
    </div>
  );
}
