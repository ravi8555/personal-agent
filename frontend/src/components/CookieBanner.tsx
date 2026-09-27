import { useConsent } from "../context/ConsentContext";

interface CookieBannerProps {
  onPrivacy: () => void;
  onTerms: () => void;
  onChoices: () => void;
}

/** Small bottom-center toast shown until the visitor records a privacy decision. */
export function CookieBanner({ onPrivacy, onTerms, onChoices }: CookieBannerProps) {
  const { isBannerVisible, acceptAll, rejectAll, dismissBanner } = useConsent();

  if (!isBannerVisible) return null;

  return (
    <section className="cookie-banner" role="region" aria-label="Privacy notice">
      <button type="button" className="cookie-banner__close" onClick={dismissBanner} aria-label="Dismiss">
        ✕
      </button>
      <div className="cookie-banner__content">
        <p className="cookie-banner__title">Data &amp; Privacy Preferences</p>
        <p className="cookie-banner__text">
          NeuroGraph uses local storage and strictly necessary graph memory to preserve your context. No third-party ad trackers.{" "}
          <button type="button" className="cookie-banner__link" onClick={onPrivacy}>
            Privacy Policy
          </button>{" "}
          &middot;{" "}
          <button type="button" className="cookie-banner__link" onClick={onTerms}>
            Terms
          </button>
        </p>
      </div>
      <div className="cookie-banner__actions">
        <button type="button" className="cta-btn cta-btn--secondary cta-btn--sm" onClick={rejectAll}>
          Reject
        </button>
        <button type="button" className="cta-btn cta-btn--secondary cta-btn--sm" onClick={onChoices}>
          Preferences
        </button>
        <button type="button" className="cta-btn cta-btn--primary cta-btn--sm" onClick={acceptAll}>
          Accept All
        </button>
      </div>
    </section>
  );
}
