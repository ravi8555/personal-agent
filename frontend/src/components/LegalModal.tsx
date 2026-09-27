import { useEffect } from "react";
import type { ReactNode } from "react";

interface LegalModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Modal popup used for the Privacy Policy and Terms of Service. */
export function LegalModal({ open, title, onClose, children }: LegalModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-wrapper modal-wrapper--legal" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="modal-close-outer"
          onClick={onClose}
          aria-label="Close dialog"
        >
          ✕
        </button>

        <div
          className="legal-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="legal-modal-title"
        >
          <header className="legal-modal__header">
            <div>
              <span className="modal__eyebrow">Legal documentation</span>
              <h2 id="legal-modal-title">{title}</h2>
            </div>
          </header>
          <div className="legal-modal__body">{children}</div>
        </div>
      </div>
    </div>
  );
}
