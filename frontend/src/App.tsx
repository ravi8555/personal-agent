import { useState } from "react";
import { Header } from "./components/Header";
import { Home } from "./pages/Home";
import { CookieBanner } from "./components/CookieBanner";
import { ConsentModal } from "./components/ConsentModal";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { Terms } from "./pages/Terms";
import { LegalModal } from "./components/LegalModal";
import { useConsent } from "./context/ConsentContext";

type LegalPage = "privacy" | "terms" | null;

export default function App() {
  const [legal, setLegal] = useState<LegalPage>(null);
  const { openModal } = useConsent();

  return (
    <div className="app">
      <Header onPrivacy={() => setLegal("privacy")} onTerms={() => setLegal("terms")} onChoices={openModal} />
      <Home />
      <CookieBanner onPrivacy={() => setLegal("privacy")} onTerms={() => setLegal("terms")} onChoices={openModal} />
      <ConsentModal />
      <LegalModal
        open={legal !== null}
        title={legal === "privacy" ? "Privacy Policy" : "Terms of Service"}
        onClose={() => setLegal(null)}
      >
        {legal === "privacy" ? <PrivacyPolicy /> : <Terms />}
      </LegalModal>
    </div>
  );
}