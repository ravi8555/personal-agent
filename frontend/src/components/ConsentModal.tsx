import { useEffect, useState } from "react";
import { COOKIE_CATEGORIES, useConsent, type CookieChoices } from "../context/ConsentContext";

/** Per-category cookie preference dialog. */
export function ConsentModal() {
  const { isModalVisible, choices, closeModal, saveChoices, acceptAll, rejectAll } = useConsent();
  const [draft, setDraft] = useState<CookieChoices>(choices);

  // Re-seed the draft each time the modal opens.
  useEffect(() => {
    if (isModalVisible) setDraft(choices);
  }, [isModalVisible, choices]);

  // Close on Escape.
  useEffect(() => {
    if (!isModalVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalVisible, closeModal]);

  if (!isModalVisible) return null;

  const toggle = (id: keyof CookieChoices, required?: boolean) => {
    if (required) return; // Necessary cookies are always on.
    setDraft(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const dirty =
    draft.functional !== choices.functional ||
    draft.analytics !== choices.analytics ||
    draft.marketing !== choices.marketing;

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-wrapper" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className="modal-close-outer"
          onClick={closeModal}
          aria-label="Close dialog"
        >
          ✕
        </button>

        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="consent-modal-title"
        >
          <header className="modal__header">
            <div>
              <span className="modal__eyebrow">Privacy &amp; Data</span>
              <h2 id="consent-modal-title">Cookie &amp; Memory Preferences</h2>
            </div>
          </header>

          <p className="modal__intro">
            Choose which data NeuroGraph may store and process. Changes take effect immediately.
          </p>

          <ul className="cookie-list">
            {COOKIE_CATEGORIES.map(cat => (
              <li key={cat.id} className="cookie-item">
                <label className="switch-row" htmlFor={`cookie-${cat.id}`}>
                  <span className="switch-row__text">
                    <span className="switch-row__title">{cat.title}</span>
                    <span className="switch-row__desc">{cat.description}</span>
                  </span>
                  <span className="switch">
                    <input
                      id={`cookie-${cat.id}`}
                      type="checkbox"
                      checked={draft[cat.id]}
                      disabled={cat.required}
                      onChange={() => toggle(cat.id, cat.required)}
                    />
                    <span className="switch__track" aria-hidden="true">
                      <span className="switch__thumb" />
                    </span>
                  </span>
                </label>
                {cat.required && <p className="cookie-item__always">Always active</p>}
              </li>
            ))}
          </ul>

          <footer className="modal__actions">
            <button type="button" className="cta-btn cta-btn--secondary" onClick={rejectAll}>
              Reject All
            </button>
            <button type="button" className="cta-btn cta-btn--secondary" onClick={acceptAll}>
              Accept All
            </button>
            <button
              type="button"
              className="cta-btn cta-btn--primary"
              disabled={!dirty}
              onClick={() => saveChoices(draft)}
            >
              Save Choices
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}