"use client";

import PDFReader from './PDFReader';
import EPUBReader from './EPUBReader';
import TXTReader from './TXTReader';
 
interface WordData {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ReaderProps {
  fileUrl: string;
  format: 'pdf' | 'epub' | 'txt';
  bookId?: string; // Add bookId for progress tracking
  pageNumber: number;
  totalPages?: number;
  words?: WordData[];
  textContent?: string;
  onWordClick?: (word: string, context?: string) => void;
  onPageChange?: (page: number) => void;
  onTotalPagesChange?: (pages: number) => void;
  onOutlineChange?: (outline: any[]) => void;
  onAskAI?: (text: string) => void;
  onHighlight?: (text: string, source?: string | number) => void;
  onContentChange?: (content: string) => void; // 新增
  jumpRequest?: { dest: string | number; text?: string; word?: string; ts: number } | null;
}

export default function UniversalReader(props: ReaderProps) {
  const format = props.format?.toLowerCase() as 'pdf' | 'epub' | 'txt';

  switch (format) {
    case 'pdf':
      return <PDFReader {...props} onContentChange={props.onContentChange} />;

    case 'epub':
      return (
        <EPUBReader
          fileUrl={props.fileUrl}
          bookId={props.bookId}
          onWordClick={props.onWordClick}
          onOutlineChange={props.onOutlineChange}
          onPageChange={props.onPageChange}
          jumpRequest={props.jumpRequest}
          onAskAI={props.onAskAI}
          onHighlight={props.onHighlight}
          onContentChange={props.onContentChange}
        />
      );

    case 'txt':
      return (
        <TXTReader
          textContent={props.textContent}
          pageNumber={props.pageNumber}
          totalPages={props.totalPages}
          onPageChange={props.onPageChange}
          onWordClick={props.onWordClick}
        />
      );

    default:
      return (
        <div className="flex items-center justify-center h-full text-red-500">
          不支持的格式: {props.format}
        </div>
      );
  }
}
