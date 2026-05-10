"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { getTTSConfig, streamSpeech, type TTSConfig } from "../../lib/api";
import { createLogger } from "../../lib/logger";
import {
  detectTTSContentLanguage,
  type TTSContentLanguage,
} from "../../lib/ttsText";

interface DJSDictionaryProps {
  word: string;
  htmlContent: string;
}

const log = createLogger("DJSDictionary");
const DJS_AUDIO_IMAGE_PATTERN =
  /<img[^>]*class=["'][^"']*\baudio\b[^"']*["'][^>]*>/gi;

function normalizeSpeakText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[【】〖〗「」]/g, " ")
    .replace(/アクセント/g, " ")
    .replace(/類語/g, " ")
    .replace(/\s+／\s+/g, " ")
    .trim();
}

function extractPlainText(element: Element | null): string {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      "a[href^='sound://'], img, .補足ロゴG, .補足ロゴ, entry-index, header",
    )
    .forEach((node) => node.remove());

  return normalizeSpeakText(clone.innerText || clone.textContent || "");
}

function extractSpeakText(
  audioLink: HTMLAnchorElement,
  fallbackWord: string,
): string {
  const exampleText = extractPlainText(audioLink.closest("exg"));
  if (exampleText) {
    return exampleText;
  }

  const subHeadword = audioLink.closest("subitemh")?.querySelector("headword");
  const subHeadwordText = extractPlainText(subHeadword || null);
  if (subHeadwordText) {
    return subHeadwordText;
  }

  const mainHeadword = audioLink.closest(".見出G")?.querySelector("headword");
  const mainHeadwordText = extractPlainText(mainHeadword || null);
  if (mainHeadwordText) {
    return mainHeadwordText;
  }

  const meaningText = extractPlainText(audioLink.closest("meaning"));
  if (meaningText) {
    return meaningText;
  }

  const parentText = extractPlainText(audioLink.parentElement);
  if (parentText) {
    return parentText;
  }

  return normalizeSpeakText(fallbackWord);
}

function resolveVoice(config: TTSConfig, language: TTSContentLanguage): string {
  if (config.provider === "qwen3") {
    if (language === "ja") {
      return config.qwen3.voice_japanese?.trim() || config.qwen3.voice?.trim() || "塔塔";
    }
    return config.qwen3.voice?.trim() || "塔塔";
  }

  if (config.provider === "openai_api") {
    return config.openai_api.voice?.trim() || "alloy";
  }

  if (language === "ja") {
    return config.edge.voice_japanese?.trim() || "nanami";
  }
  if (language === "zh") {
    return config.edge.voice_chinese?.trim() || "xiaoxiao";
  }
  return config.edge.voice?.trim() || "aria";
}

function resolveSpeed(config: TTSConfig): number {
  if (config.provider === "qwen3") return config.qwen3.speed || 1;
  if (config.provider === "openai_api") return config.openai_api.speed || 1;
  return config.edge.speed || 1;
}

function DJSDictionary({ word, htmlContent }: DJSDictionaryProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const normalizedHtml = useMemo(
    () => htmlContent.replace(DJS_AUDIO_IMAGE_PATTERN, ""),
    [htmlContent],
  );

  const playConfiguredTTS = useCallback(async (text: string) => {
    const trimmedText = normalizeSpeakText(text);
    if (!trimmedText) return;

    try {
      const config = await getTTSConfig();
      const language = detectTTSContentLanguage(trimmedText, "ja");
      const voice = resolveVoice(config, language);
      const speed = resolveSpeed(config);
      const { blobUrl } = await streamSpeech(
        trimmedText,
        voice,
        config.provider,
        speed,
      );
      const audio = new Audio(blobUrl);
      audio.onended = () => URL.revokeObjectURL(blobUrl);
      audio.onerror = () => URL.revokeObjectURL(blobUrl);
      await audio.play();
    } catch (error) {
      log.error("播放大辞泉 TTS 失败", error);
    }
  }, []);

  const handleClick = useCallback((event: Event) => {
    const target = event.target as HTMLElement | null;
    const audioLink = target?.closest("a[href^='sound://']") as HTMLAnchorElement | null;
    if (!audioLink) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const speakText = extractSpeakText(audioLink, word);
    void playConfiguredTTS(speakText);
  }, [playConfiguredTTS, word]);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;

    const appendixElements: HTMLElement[] = [];
    container.querySelectorAll("*").forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      const tagName = element.tagName.toLowerCase();
      if (tagName.startsWith("appendix-")) {
        element.classList.add("djs-appendix-block");
        if (tagName.includes("タイトル")) {
          element.classList.add("djs-appendix-title");
        }
        if (tagName.includes("例")) {
          element.classList.add("djs-appendix-example");
        }
        appendixElements.push(element);
      }
    });

    const images = Array.from(container.querySelectorAll("img"));
    const cleanupImageListeners = images.map((image) => {
      const onError = () => image.classList.add("djs-broken-image");
      image.addEventListener("error", onError);
      return () => image.removeEventListener("error", onError);
    });

    const audioLinks = Array.from(
      container.querySelectorAll("a[href^='sound://']"),
    ) as HTMLAnchorElement[];
    audioLinks.forEach((audioLink) => {
      audioLink.classList.add("djs-audio-link");
      const speakText = extractSpeakText(audioLink, word);
      audioLink.setAttribute(
        "aria-label",
        speakText ? `朗读：${speakText}` : "播放词条读音",
      );
      audioLink.setAttribute("title", speakText || "播放词条读音");
    });

    container.addEventListener("click", handleClick, true);

    return () => {
      container.removeEventListener("click", handleClick, true);
      cleanupImageListeners.forEach((cleanup) => cleanup());
      appendixElements.forEach((element) => {
        element.classList.remove(
          "djs-appendix-block",
          "djs-appendix-title",
          "djs-appendix-example",
        );
      });
    };
  }, [handleClick, normalizedHtml, word]);

  return (
    <div
      ref={contentRef}
      className="dictionary-scope-djs dictionary-container"
      data-dict="djs"
      data-word={word}
    >
      <div dangerouslySetInnerHTML={{ __html: normalizedHtml }} />
    </div>
  );
}

export default memo(DJSDictionary);
