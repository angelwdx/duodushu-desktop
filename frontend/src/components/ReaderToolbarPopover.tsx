"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type PopoverPlacement = "top" | "bottom";

interface ReaderToolbarPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef?: RefObject<HTMLDivElement | null>;
  popoverWidth: number;
  className: string;
  children: ReactNode;
  offset?: number;
  minHeightToFlip?: number;
}

interface PopoverPosition {
  left: number;
  top: number;
  bottom: number;
  maxHeight: number;
  placement: PopoverPlacement;
}

export default function ReaderToolbarPopover({
  open,
  anchorRef,
  popoverRef,
  popoverWidth,
  className,
  children,
  offset = 12,
  minHeightToFlip = 220,
}: ReaderToolbarPopoverProps) {
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (typeof window === "undefined") return;

    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;

    const viewportPadding = 12;
    const availableAbove = Math.max(0, rect.top - viewportPadding - offset);
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - offset);
    const placement: PopoverPlacement =
      availableAbove >= minHeightToFlip || availableAbove >= availableBelow ? "top" : "bottom";

    const left = Math.min(
      Math.max(viewportPadding, rect.right - popoverWidth),
      Math.max(viewportPadding, window.innerWidth - popoverWidth - viewportPadding),
    );

    setPosition({
      left,
      top: rect.bottom + offset,
      bottom: window.innerHeight - rect.top + offset,
      maxHeight: placement === "top" ? availableAbove : availableBelow,
      placement,
    });
  }, [anchorRef, minHeightToFlip, offset, popoverWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;

    const handlePositionChange = () => updatePosition();
    const frameId = window.requestAnimationFrame(handlePositionChange);

    window.addEventListener("resize", handlePositionChange);
    document.addEventListener("scroll", handlePositionChange, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handlePositionChange);
      document.removeEventListener("scroll", handlePositionChange, true);
    };
  }, [open, updatePosition]);

  if (!open || !position || typeof document === "undefined") return null;

  const style: CSSProperties =
    position.placement === "top"
      ? {
          left: position.left,
          bottom: position.bottom,
          maxHeight: position.maxHeight,
        }
      : {
          left: position.left,
          top: position.top,
          maxHeight: position.maxHeight,
        };

  return createPortal(
    <div
      ref={popoverRef}
      className={`fixed z-[9999] overflow-y-auto overscroll-contain ${position.placement === "top" ? "origin-bottom-right" : "origin-top-right"} ${className}`}
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
