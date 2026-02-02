'use client';

import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';
import SettingsDialog from '../components/SettingsDialog';

// const SettingsDialog = dynamic(() => import('../components/SettingsDialog'), { ssr: false });

interface SettingsContextType {
  openSettings: () => void;
  closeSettings: () => void;
  isSettingsOpen: boolean;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const openSettings = useCallback(() => {
    console.log('[SettingsContext] openSettings called');
    setIsOpen(true);
  }, []);
  
  const closeSettings = useCallback(() => {
     console.log('[SettingsContext] closeSettings called');
     setIsOpen(false);
  }, []);

  useEffect(() => {
    console.log('[SettingsContext] isOpen state:', isOpen);
  }, [isOpen]);

  return (
    <SettingsContext.Provider value={{ openSettings, closeSettings, isSettingsOpen: isOpen }}>
      {children}
      <SettingsDialog isOpen={isOpen} onClose={closeSettings} />
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
