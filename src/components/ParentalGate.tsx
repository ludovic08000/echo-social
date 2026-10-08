import { createContext, useCallback, useContext, type ReactNode } from 'react';

interface ParentalContextType {
  isMinor: boolean;
  allowedCategories: string[];
  isUnlocked: boolean;
  requestUnlock: (onSuccess?: () => void) => void;
  isCategoryAllowed: (category?: string | null) => boolean;
}

const disabledParentalContext: ParentalContextType = {
  isMinor: false,
  allowedCategories: [],
  isUnlocked: true,
  requestUnlock: (onSuccess) => onSuccess?.(),
  isCategoryAllowed: () => true,
};

const ParentalContext = createContext<ParentalContextType>(disabledParentalContext);

export function useParentalGate() {
  return useContext(ParentalContext);
}

export function ParentalGateProvider({ children }: { children: ReactNode }) {
  const requestUnlock = useCallback((onSuccess?: () => void) => onSuccess?.(), []);

  return (
    <ParentalContext.Provider value={{ ...disabledParentalContext, requestUnlock }}>
      {children}
    </ParentalContext.Provider>
  );
}
