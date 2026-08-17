import React from 'react';
import { ProviderInfo } from '../lib/providers';

interface CostEstimateProps {
  provider: ProviderInfo;
  fastModelId: string;
  proModelId: string;
}

export function CostEstimate({ provider, fastModelId, proModelId }: CostEstimateProps) {
  const fastModel = provider.models.find(m => m.id === fastModelId);
  const proModel = provider.models.find(m => m.id === proModelId);

  const fastCostPer1M = fastModel?.costPer1M || 0;
  const proCostPer1M = proModel?.costPer1M || 0;

  // Based on avg 50K tokens pro + 5K tokens fast
  const estimatedCost = ((proCostPer1M * 50000) / 1000000) + ((fastCostPer1M * 5000) / 1000000);

  return (
    <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between">
      <div>
        <h4 className="text-sm font-medium text-gray-900">Estimated Cost</h4>
        <p className="text-xs text-gray-500">Based on avg 50K tokens pro + 5K tokens fast</p>
      </div>
      <div className="text-lg font-semibold text-gray-900">
        ~${estimatedCost.toFixed(3)} <span className="text-sm font-normal text-gray-500">per blueprint</span>
      </div>
    </div>
  );
}
