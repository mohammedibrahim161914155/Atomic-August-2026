import React, { useState } from 'react';
import { Eye, EyeOff, Key, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

interface ApiKeyInputProps {
  value: string;
  onChange: (val: string) => void;
  providerName: string;
  placeholder?: string;
  docsUrl?: string;
  onTest?: () => Promise<boolean>;
}

export function ApiKeyInput({ value, onChange, providerName, placeholder = 'sk-...', docsUrl, onTest }: ApiKeyInputProps) {
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');

  const handleTest = async () => {
    if (!onTest) return;
    setTestState('testing');
    try {
      const success = await onTest();
      setTestState(success ? 'success' : 'error');
      setTimeout(() => setTestState('idle'), 3000);
    } catch {
      setTestState('error');
      setTimeout(() => setTestState('idle'), 3000);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="block text-sm font-medium text-gray-700">
          {providerName} API Key
        </label>
        {docsUrl && (
          <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800">
            Get API Key
          </a>
        )}
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Key className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type={showKey ? 'text' : 'password'}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setTestState('idle');
            }}
            className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            placeholder={placeholder}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
          >
            {showKey ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
          </button>
        </div>
        {onTest && (
          <button
            onClick={handleTest}
            disabled={!value || testState === 'testing'}
            className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 min-w-[100px] justify-center"
          >
            {testState === 'testing' && <Loader2 className="w-4 h-4 animate-spin" />}
            {testState === 'success' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
            {testState === 'error' && <XCircle className="w-4 h-4 text-red-600" />}
            {testState === 'idle' && 'Test Key'}
            {testState !== 'idle' && testState !== 'testing' && (testState === 'success' ? 'Valid' : 'Invalid')}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">
        Your key is transmitted to and stored on our server. It is never logged, shared, or used outside of your session.
      </p>
    </div>
  );
}
