import { useState } from 'react';

interface OnboardingProps {
  onComplete: () => void;
}

const STEPS = [
  {
    label: 'Welcome',
    content: (
      <div className="flex flex-col items-center text-center">
        <div className="text-[10px] uppercase tracking-widest text-gray-400 mb-3">by Kaname Labs</div>
        <h1 className="font-mono text-5xl font-bold text-gray-900 mb-5 tracking-tighter">ATOMIC</h1>
        <p className="text-lg text-gray-600 leading-relaxed max-w-sm">
          Production-grade system blueprints.<br />Generated in minutes, not weeks.
        </p>
        <p className="text-sm text-gray-400 mt-2">Bring your own API key. Your pipeline. Your blueprints.</p>
      </div>
    ),
  },
  {
    label: 'How it works',
    content: (
      <div className="w-full">
        <h2 className="font-mono text-xl font-bold text-gray-900 mb-8 uppercase tracking-wider text-center">
          How it works
        </h2>
        <div className="space-y-6">
          {[
            {
              n: '01',
              title: 'Describe your system',
              desc: 'Tell Atomic what you want to build. Any domain, any scale, any industry.',
            },
            {
              n: '02',
              title: 'Multi-layer analysis',
              desc: 'Your idea goes through a deep review pipeline — architecture, security, edge cases, and more.',
            },
            {
              n: '03',
              title: 'Get a production blueprint',
              desc: 'A complete, implementation-ready specification. Not boilerplate — buildable.',
            },
          ].map(({ n, title, desc }) => (
            <div key={n} className="flex gap-5 items-start">
              <div className="shrink-0 w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 text-gray-400
                              font-mono text-[10px] font-bold flex items-center justify-center mt-0.5">
                {n}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-0.5">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    label: 'Your key',
    content: (
      <div className="w-full">
        <h2 className="font-mono text-xl font-bold text-gray-900 mb-2 uppercase tracking-wider text-center">
          Bring your key
        </h2>
        <p className="text-sm text-gray-500 text-center mb-8">
          Atomic uses your own API key. Your usage, your billing, your data.<br />
          We never store your requests.
        </p>

        <div className="mb-4">
          <label className="block text-xs font-semibold text-gray-700 mb-2 uppercase tracking-wider">
            OpenRouter API Key
          </label>
          <div className="w-full border border-gray-200 rounded-xl px-4 py-3 bg-gray-50 text-gray-400
                          font-mono text-sm opacity-80 cursor-not-allowed select-none">
            sk-or-v1-a1b2c3d4e5f6g7h8i9j0
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Set this in Settings before your first blueprint. Supports OpenRouter, OpenAI, Anthropic, and more.
          </p>
        </div>

        <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-center">
          <p className="text-xs text-gray-500">
            Your key is encrypted (AES-256-GCM) and stored server-side. Never sent to third parties.
          </p>
        </div>
      </div>
    ),
  },
  {
    label: "You're ready",
    content: (
      <div className="flex flex-col items-center text-center">
        <h2 className="font-mono text-xl font-bold text-gray-900 mb-3 uppercase tracking-wider">
          You&apos;re ready
        </h2>
        <p className="text-sm text-gray-500 mb-10 max-w-sm">
          Generate your first blueprint below. Choose Fast Mode for speed or Safe Mode for deeper staged analysis.
        </p>
        <div className="flex gap-3">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                          bg-white border border-gray-200 text-gray-700 shadow-sm">
            <span>⚡</span> Fast Mode
          </div>
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium
                          bg-white border border-gray-200 text-gray-700 shadow-sm">
            <span>🛡</span> Safe Mode
          </div>
        </div>
      </div>
    ),
  },
];

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const total = STEPS.length - 1;

  const next = () => (step < total ? setStep(s => s + 1) : onComplete());
  const back = () => setStep(s => Math.max(0, s - 1));

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-6 selection:bg-rose-900/30"
      style={{ background: '#f5f4f0' }}
    >
      {/* Skip */}
      <button
        onClick={onComplete}
        className={`absolute top-6 right-6 text-xs text-gray-400 hover:text-gray-600 transition-colors
                    ${step === total ? 'invisible' : ''}`}
      >
        Skip
      </button>

      <div className="w-full max-w-lg">
        {/* Step progress — thin lines */}
        <div className="flex items-center gap-1.5 mb-10">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`flex-1 h-0.5 rounded-full transition-all duration-300
                          ${i <= step ? 'bg-gray-900' : 'bg-gray-200'}`}
            />
          ))}
        </div>

        {/* Content card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 mb-8
                        min-h-[320px] flex flex-col items-stretch justify-center">
          <div className="relative overflow-hidden">
            {STEPS.map((s, i) => (
              <div
                key={i}
                className={`transition-all duration-400 ${
                  i === step
                    ? 'opacity-100 translate-x-0 pointer-events-auto'
                    : i < step
                      ? 'opacity-0 -translate-x-4 pointer-events-none absolute inset-0'
                      : 'opacity-0 translate-x-4 pointer-events-none absolute inset-0'
                }`}
              >
                {s.content}
              </div>
            ))}
          </div>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <button
            onClick={back}
            className={`px-5 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600
                        hover:bg-white hover:shadow-sm transition-all
                        ${step === 0 ? 'invisible' : ''}`}
          >
            Back
          </button>
          <button
            onClick={next}
            className="px-6 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold
                       hover:bg-gray-700 transition-colors"
          >
            {step === 0 ? 'Get Started →' : step === total ? 'Open Atomic →' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
