import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

/** Cookie categories the user can opt in/out of. */
export type CookieCategory =
  | "necessary"
  | "functional"
  | "analytics"
  | "marketing";

export type CookieChoices = Record<CookieCategory, boolean>;

export const COOKIE_CATEGORIES: Array<{
  id: CookieCategory;
  title: string;
  description: string;
  required?: boolean;
}> = [
  {
    id: "necessary",
    title: "Strictly Necessary",
    description:
      "Required for the site to function (e.g. remembering your theme and privacy choices). These cannot be switched off.",
    required: true
  },
  {
    id: "functional",
    title: "Functional",
    description:
      "Remembers preferences such as how you like your assistant to behave, so we can personalise your experience."
  },
  {
    id: "analytics",
    title: "Analytics",
    description:
      "Helps us understand how you use NeuroGraph so we can improve features and performance."
  },
  {
    id: "marketing",
    title: "Marketing & Personalisation",
    description:
      "Lets us tailor content and recommendations to your interests. We keep this off by default."
  }
];

const STORAGE_KEY = "neurograph-cookie-consent";

/** Consent has never been recorded → show the banner. */
export type ConsentStatus = "unknown" | "accepted" | "custom" | "rejected";

interface ConsentContextValue {
  status: ConsentStatus;
  choices: CookieChoices;
  isBannerVisible: boolean;
  isModalVisible: boolean;
  acceptAll: () => void;
  rejectAll: () => void;
  saveChoices: (next: CookieChoices) => void;
  openModal: () => void;
  closeModal: () => void;
  dismissBanner: () => void;
  resetConsent: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

const ALL_ON: CookieChoices = {
  necessary: true,
  functional: true,
  analytics: true,
  marketing: true
};

const ALL_OFF: CookieChoices = {
  necessary: true,
  functional: false,
  analytics: false,
  marketing: false
};

function loadStoredChoices(): CookieChoices | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CookieChoices>;
    return {
      necessary: true,
      functional: parsed.functional ?? false,
      analytics: parsed.analytics ?? false,
      marketing: parsed.marketing ?? false
    };
  } catch {
    return null;
  }
}

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [choices, setChoices] = useState<CookieChoices>(() => loadStoredChoices() ?? ALL_OFF);
  const [hasDecision, setHasDecision] = useState<boolean>(() => loadStoredChoices() !== null);
  const [isBannerVisible, setBannerVisible] = useState(false);
  const [isModalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    if (!hasDecision) {
      const id = window.setTimeout(() => setBannerVisible(true), 800);
      return () => window.clearTimeout(id);
    }
  }, [hasDecision]);

  const status: ConsentStatus = useMemo(() => {
    if (!hasDecision) return "unknown";
    if (!choices.functional && !choices.analytics && !choices.marketing) return "rejected";
    if (choices.functional && choices.analytics && choices.marketing) return "accepted";
    return "custom";
  }, [choices, hasDecision]);

  const persist = useCallback((next: CookieChoices) => {
    setChoices(next);
    setHasDecision(true);
    setBannerVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode) — in-memory choice still applies.
    }
  }, []);

  const value = useMemo<ConsentContextValue>(
    () => ({
      status,
      choices,
      isBannerVisible,
      isModalVisible,
      acceptAll: () => persist(ALL_ON),
      rejectAll: () => persist(ALL_OFF),
      saveChoices: (next: CookieChoices) => persist(next),
      openModal: () => setModalVisible(true),
      closeModal: () => setModalVisible(false),
      dismissBanner: () => setBannerVisible(false),
      resetConsent: () => {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* noop */
        }
        setChoices(ALL_OFF);
        setHasDecision(false);
        setBannerVisible(true);
      }
    }),
    [status, choices, isBannerVisible, isModalVisible, persist]
  );

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

export function useConsent(): ConsentContextValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error("useConsent must be used within <ConsentProvider>");
  return ctx;
}