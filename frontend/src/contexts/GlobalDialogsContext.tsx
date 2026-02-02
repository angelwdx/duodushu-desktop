'use client';

import React, { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import UploadDialog from '../components/UploadDialog';

interface GlobalDialogsContextType {
  openUpload: () => void;
  closeUpload: () => void;
  isUploadOpen: boolean;
}

const GlobalDialogsContext = createContext<GlobalDialogsContextType | undefined>(undefined);

export function GlobalDialogsProvider({ children }: { children: ReactNode }) {
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const openUpload = useCallback(() => setIsUploadOpen(true), []);
  const closeUpload = useCallback(() => setIsUploadOpen(false), []);

  const handleUploadSuccess = useCallback(() => {
    // Broadcast event for listeners (e.g., Home page to refresh list)
    window.dispatchEvent(new CustomEvent('book-uploaded'));
  }, []);

  return (
    <GlobalDialogsContext.Provider value={{ openUpload, closeUpload, isUploadOpen }}>
      {children}
      <UploadDialog 
        isOpen={isUploadOpen} 
        onClose={closeUpload} 
        onUploadSuccess={handleUploadSuccess} 
      />
    </GlobalDialogsContext.Provider>
  );
}

export function useGlobalDialogs() {
  const context = useContext(GlobalDialogsContext);
  if (context === undefined) {
    throw new Error('useGlobalDialogs must be used within a GlobalDialogsProvider');
  }
  return context;
}
