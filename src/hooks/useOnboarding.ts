import { useState, useCallback } from 'react';

export function useOnboarding() {
  const [shouldShow, setShouldShow] = useState(() => {
    try {
      if (typeof window !== 'undefined') {
        const isComplete = localStorage.getItem('atomic_onboarding_complete');
        return isComplete !== 'true';
      }
      return true;
    } catch {
      return true;
    }
  });

  const complete = useCallback(() => {
    try {
      localStorage.setItem('atomic_onboarding_complete', 'true');
    } catch {
      // Ignore fallback
    }
    setShouldShow(false);
  }, []);

  return { shouldShow, complete };
}
