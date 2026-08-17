import { useState, useEffect, useRef } from 'react';
import {
  ArrowRight, Play, ShieldAlert, Paperclip, Mic, Send, Clock,
  Layers, Puzzle, Wrench, Bot,
} from 'lucide-react';
import {
  SessionMeta, GenerationMode, Blueprint, BlueprintSchema, PipelineType,
} from '../engine/types';

declare global {
  interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }
  interface SpeechRecognitionErrorEvent extends Event {
    error: string;
    message: string;
  }
  interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    abort(): void;
    onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
    onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
    onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null;
    onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  }
  const SpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition; };
  const webkitSpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition; };
  interface Window {
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }
}

// ── Pipeline definitions ───────────────────────────────────────────────────────

interface PipelineDef {
  id:          PipelineType;
  label:       string;
  /** Short verb used in the submit button: "Build <shortLabel>" */
  shortLabel:  string;
  tagline:     string;
  placeholder: string;
  examples:    string[];
  Icon:        React.ComponentType<{ size?: number; className?: string }>;
  accent:      string;  // Tailwind ring/border colour class
  /** Whether this pipeline supports fast/safe mode selection */
  hasModeSelector: boolean;
}

const PIPELINES: PipelineDef[] = [
  {
    id:             'blueprint',
    label:          'Blueprint',
    shortLabel:     'Blueprint',
    tagline:        'Full system architecture',
    hasModeSelector: true,
    placeholder:    'Describe the software system you want to blueprint — include scale, users, and key requirements…',
    examples: [
      'A multi-tenant SaaS for restaurant inventory with real-time alerts',
      'A local-first encrypted personal finance tracker with AI insights',
      'A real-time collaborative whiteboard with offline sync',
    ],
    Icon:   Layers,
    accent: 'border-gray-900 bg-gray-900 text-white',
  },
  {
    id:             'feature-creator',
    label:          'Feature Creator',
    shortLabel:     'Feature',
    tagline:        'Implementation-ready feature plan',
    hasModeSelector: false,
    placeholder:    'Describe the feature to add and your existing stack — e.g. "Add Stripe subscription billing to our Next.js + Prisma app, supporting monthly and annual plans"…',
    examples: [
      'Add real-time notifications to a Django + React app using WebSockets',
      'Implement OAuth2 social login (Google, GitHub) in a Node.js Express API',
      'Add full-text search with filters to a PostgreSQL-backed product catalogue',
    ],
    Icon:   Puzzle,
    accent: 'border-violet-600 bg-violet-600 text-white',
  },
  {
    id:             'tool-builder',
    label:          'Tool Builder',
    shortLabel:     'Tool',
    tagline:        'MCP-compatible tool specification',
    hasModeSelector: false,
    placeholder:    'Describe the tool concept — what it does, which external system it connects to, and which agent will use it…',
    examples: [
      'A tool that searches Linear issues and creates new ones for a coding agent',
      'A tool that reads, creates, and updates Notion pages for a research agent',
      'A tool that queries a PostgreSQL database with safe parameterised queries',
    ],
    Icon:   Wrench,
    accent: 'border-amber-600 bg-amber-600 text-white',
  },
  {
    id:             'agent-builder',
    label:          'Agent Builder',
    shortLabel:     'Agent',
    tagline:        'Full agent spec + system prompt + eval harness',
    hasModeSelector: false,
    placeholder:    'Describe the agent — its role, capabilities it needs, and constraints it must respect…',
    examples: [
      'A code review agent that enforces team conventions and catches security issues',
      'A customer support triage agent that classifies tickets and drafts first responses',
      'An automated PR description writer that reads diffs and generates release notes',
    ],
    Icon:   Bot,
    accent: 'border-emerald-600 bg-emerald-600 text-white',
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function Landing({
  onStart, onResume, onUpload,
}: {
  onStart:  (prompt: string, mode: GenerationMode, pipelineType: PipelineType) => void;
  onResume: (sessionId: string) => void;
  onUpload: (blueprint: Blueprint) => void;
}) {
  const [input,        setInput]       = useState('');
  const [mode,         setMode]        = useState<GenerationMode>('fast');
  const [pipeline,     setPipeline]    = useState<PipelineType>('blueprint');
  const [sessions,     setSessions]    = useState<SessionMeta[]>([]);
  const [uploadError,  setUploadError] = useState('');
  const [isListening,  setIsListening] = useState(false);

  const fileInputRef       = useRef<HTMLInputElement>(null);
  const promptFileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef        = useRef<HTMLTextAreaElement>(null);
  const recognitionRef     = useRef<InstanceType<typeof SpeechRecognition> | null>(null);

  const currentPipeline = PIPELINES.find(p => p.id === pipeline) ?? PIPELINES[0]!;

  useEffect(() => {
    fetch('/api/v1/my-sessions')
      .then(r => (r.ok ? r.json() : { sessions: [] }))
      .then((d: { sessions?: SessionMeta[] }) => setSessions(d.sessions ?? []))
      .catch((err: unknown) => {
        console.warn('[Landing] failed to load recent sessions:', err);
      });
  }, []);

  const autoResize = () => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.max(88, Math.min(t.scrollHeight, window.innerHeight * 0.35))}px`;
  };

  const handlePipelineChange = (id: PipelineType) => {
    setPipeline(id);
    // Reset textarea if empty so placeholder updates immediately
    if (!input.trim()) setInput('');
    setTimeout(autoResize, 0);
  };

  const handlePromptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const content = ev.target?.result as string;
      setInput(prev => (prev ? `${prev}\n\n${content}` : content));
      setTimeout(autoResize, 0);
    };
    reader.readAsText(file);
    if (promptFileInputRef.current) promptFileInputRef.current.value = '';
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = BlueprintSchema.safeParse(JSON.parse(ev.target?.result as string));
        if (!parsed.success) throw new Error();
        onUpload(parsed.data);
      } catch {
        setUploadError('Invalid blueprint JSON. Upload a file previously exported from Atomic.');
      }
    };
    reader.readAsText(file);
  };

  const handleVoiceInput = () => {
    if (isListening) { recognitionRef.current?.stop(); setIsListening(false); return; }
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      alert('Speech recognition is not supported in this browser.'); return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    recognitionRef.current = rec;
    rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
    rec.onstart  = () => setIsListening(true);
    rec.onend    = () => setIsListening(false);
    rec.onerror  = (ev: SpeechRecognitionErrorEvent) => {
      if (ev.error === 'not-allowed') alert('Microphone access was denied.');
      setIsListening(false);
    };
    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let transcript = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i]?.isFinal) transcript += ev.results[i]?.[0]?.transcript ?? '';
      }
      if (transcript) {
        setInput(prev => {
          const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
          return prev + sep + transcript.trim();
        });
        setTimeout(autoResize, 0);
      }
    };
    rec.start();
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (input.trim()) onStart(input.trim(), mode, pipeline);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6"
         style={{ background: '#f5f4f0' }}>
      <div className="w-full max-w-2xl">

        {/* Wordmark */}
        <div className="text-center mb-8">
          <div className="font-mono font-bold text-2xl tracking-tighter text-gray-900 mb-1.5">
            ATOMIC
          </div>
          <p className="text-sm text-gray-500">
            Production-grade AI-generated blueprints. Generated in minutes, not weeks.
          </p>
        </div>

        {/* Pipeline selector */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
          {PIPELINES.map(p => {
            const isActive = pipeline === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePipelineChange(p.id)}
                className={`
                  relative flex flex-col items-start gap-1.5 p-3 rounded-xl border-2 text-left
                  transition-all duration-150 group
                  ${isActive
                    ? `${p.accent} border-transparent shadow-md`
                    : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300 hover:shadow-sm'
                  }
                `}
              >
                <p.Icon
                  size={15}
                  className={isActive ? 'opacity-90' : 'text-gray-400 group-hover:text-gray-600'}
                />
                <div>
                  <p className={`text-[11px] font-semibold leading-none ${isActive ? 'opacity-90' : 'text-gray-800'}`}>
                    {p.label}
                  </p>
                  <p className={`text-[10px] leading-tight mt-0.5 ${isActive ? 'opacity-70' : 'text-gray-400'}`}>
                    {p.tagline}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Input area */}
        <form onSubmit={handleSubmit}>
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm
                          focus-within:border-gray-300 focus-within:shadow-md transition-all">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); autoResize(); }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
              }}
              placeholder={currentPipeline.placeholder}
              className="w-full bg-transparent px-5 pt-5 pb-3 text-[15px] text-gray-900
                         focus:outline-none resize-none placeholder-gray-400 leading-relaxed"
              style={{ minHeight: 88 }}
              rows={3}
            />

            {/* Toolbar */}
            <div className="flex items-center gap-2 px-4 pb-3.5 pt-2 border-t border-gray-100">
              {/* File attach */}
              <button
                type="button"
                onClick={() => promptFileInputRef.current?.click()}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg
                           hover:bg-gray-100 transition-colors"
                title="Attach text file"
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={promptFileInputRef}
                type="file"
                accept=".txt,.md,.json,.csv,.ts,.js,.tsx,.jsx,.html,.css"
                className="hidden"
                onChange={handlePromptFileChange}
              />

              {/* Voice */}
              <button
                type="button"
                onClick={handleVoiceInput}
                className={`p-1.5 rounded-lg transition-colors ${isListening
                  ? 'text-red-500 bg-red-50 animate-pulse'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                title="Voice input"
              >
                <Mic size={15} />
              </button>

              <div className="flex-1" />

              {/* Submit */}
              <button
                type="submit"
                disabled={!input.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-xs
                           font-semibold rounded-xl hover:bg-gray-700 disabled:opacity-30
                           disabled:cursor-not-allowed transition-colors"
              >
                <Send size={13} />
                {currentPipeline.id === 'blueprint'
                  ? 'Generate'
                  : `Build ${currentPipeline.shortLabel}`}
              </button>
            </div>
          </div>
        </form>

        {/* Mode selector — Blueprint only, shown below the input card */}
        {currentPipeline.hasModeSelector && (
          <div className="flex items-center justify-center gap-3 mt-3">
            <span className="text-[11px] text-gray-400 font-medium">Mode</span>
            <div className="flex items-center bg-white border border-gray-200 rounded-lg p-0.5 gap-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setMode('fast')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium
                            transition-all ${mode === 'fast'
                              ? 'bg-gray-900 text-white shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'}`}
              >
                <Play size={10} /> Fast
              </button>
              <button
                type="button"
                onClick={() => setMode('safe')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium
                            transition-all ${mode === 'safe'
                              ? 'bg-gray-900 text-white shadow-sm'
                              : 'text-gray-500 hover:text-gray-700'}`}
              >
                <ShieldAlert size={10} /> Safe
              </button>
            </div>
            <span className="text-[11px] text-gray-400">
              {mode === 'fast' ? 'All pillars run in parallel' : 'Staged with extra checkpointing'}
            </span>
          </div>
        )}

        {/* Smart suggestions — below mode selector */}
        <div className="flex flex-wrap justify-center gap-2 mt-3">
          {currentPipeline.examples.map((ex, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { setInput(ex); setTimeout(autoResize, 0); }}
              className="text-[11px] px-3 py-1.5 rounded-full bg-white border border-gray-200
                         text-gray-500 hover:text-gray-900 hover:border-gray-300 hover:shadow-sm
                         transition-all truncate max-w-[280px]"
            >
              {ex}
            </button>
          ))}
        </div>

        {/* Load blueprint */}
        <div className="flex items-center justify-center mt-4">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Load saved blueprint JSON →
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
        {uploadError && (
          <p className="text-xs text-red-500 text-center mt-2">{uploadError}</p>
        )}

        {/* Recent sessions */}
        {sessions.length > 0 && (
          <div className="mt-12 pt-8 border-t border-gray-200">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-3
                           flex items-center gap-1.5">
              <Clock size={11} /> Recent sessions
            </h3>
            <div className="space-y-2">
              {sessions.slice(0, 4).map(s => (
                <button
                  key={s.id}
                  onClick={() => onResume(s.id)}
                  className="w-full flex items-center justify-between p-4 rounded-xl bg-white
                             border border-gray-200 hover:border-gray-300 hover:shadow-sm
                             transition-all text-left group"
                >
                  <div className="flex-1 truncate min-w-0">
                    <p className="text-sm text-gray-800 truncate">{s.prompt}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      {new Date(s.created_at).toLocaleString()} · {s.mode} mode ·{' '}
                      <span className={
                        s.status === 'complete' ? 'text-emerald-500' :
                        s.status === 'partial'  ? 'text-amber-500'   : 'text-sky-500'
                      }>{s.status}</span>
                    </p>
                  </div>
                  <ArrowRight size={13} className="text-gray-300 group-hover:text-gray-600 ml-3
                                                    shrink-0 transition-colors" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
