import { useCallback, useRef, useState } from "react";

/**
 * IME-safe inline text input.
 *
 * The bug this exists for: a controlled input that writes to the store on every
 * keystroke fights WKWebView's IME composition. When the store echoes back
 * (rename -> workspace apply -> re-render), the composition is committed and the
 * field loses focus. Chinese input made it obvious, but the same thing happens
 * whenever a re-render lands mid-typing.
 *
 * Rules enforced here:
 * - while composing, only the local draft changes; `onChange` fires once at the
 *   end of the composition;
 * - `Enter` during composition belongs to the IME and is ignored;
 * - `onCommit` runs exactly once (Enter or blur), never twice.
 */
export interface ImeSafeInputOptions {
  initialValue: string;
  /** Fires after composition ends (never mid-composition). */
  onChange?: (value: string) => void;
  /** Enter with no composition active. */
  onCommit: (value: string) => void;
  /** Escape — discard the draft. */
  onCancel?: () => void;
}

export function useImeSafeInput({
  initialValue,
  onChange,
  onCommit,
  onCancel,
}: ImeSafeInputOptions) {
  const [draft, setDraft] = useState(initialValue);
  const composing = useRef(false);
  const committed = useRef(false);
  const latest = useRef(initialValue);
  /** value to fall back to on Escape (the value when editing started) */
  const initial = useRef(initialValue);

  const reset = useCallback((value: string) => {
    initial.current = value;
    latest.current = value;
    committed.current = false;
    setDraft(value);
  }, []);

  const commit = useCallback(() => {
    if (committed.current) return;
    if (composing.current) return;
    committed.current = true;
    onCommit(latest.current);
  }, [onCommit]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      latest.current = value;
      setDraft(value);
      if (!composing.current) onChange?.(value);
    },
    [onChange],
  );

  const handleCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      const value = event.currentTarget.value;
      latest.current = value;
      setDraft(value);
      onChange?.(value);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // 229 = the IME is still composing (Safari/WebKit reports it this way)
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;

      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        committed.current = true;
        latest.current = initial.current;
        setDraft(initial.current);
        onCancel?.();
      }
    },
    [commit, onCancel],
  );

  const handleBlur = useCallback(() => {
    // a blur caused by the IME committing must not write a half-finished name
    if (composing.current) return;
    commit();
  }, [commit]);

  return {
    draft,
    reset,
    commit,
    handleChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
    handleBlur,
  };
}
