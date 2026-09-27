import { PRIVACY_LAST_UPDATED } from "./PrivacyPolicy";

/** Content-only — rendered inside the LegalModal popup. */
export function Terms() {
  return (
    <div className="legal-content">
      <p className="legal-updated">Last updated: {PRIVACY_LAST_UPDATED}</p>

      <p>These terms govern your use of NeuroGraph, the personal AI assistant. By using the service you agree to them.</p>

      <h3>1. The service</h3>
      <p>
        NeuroGraph provides an AI assistant with long-term, graph-based memory. Features evolve over time; we may add,
        change or remove functionality.
      </p>

      <h3>2. Your account & content</h3>
      <ul>
        <li>You keep ownership of the content you submit ("Your Content").</li>
        <li>
          You grant us the limited right to process Your Content to operate the service (e.g. extracting memories, generating replies).
        </li>
        <li>Do not submit content you lack the rights to, or that is unlawful or harmful.</li>
      </ul>

      <h3>3. Acceptable use</h3>
      <ul>
        <li>No reverse engineering, scraping, or disrupting the service.</li>
        <li>No use of the assistant to generate content that violates law or others' rights.</li>
      </ul>

      <h3>4. AI outputs & memory</h3>
      <ul>
        <li>Responses and remembered knowledge are generated automatically and may be inaccurate.</li>
        <li>The assistant self-corrects conflicting knowledge over time, but verify important information.</li>
        <li>Nothing here is professional (medical, legal, financial) advice.</li>
      </ul>

      <h3>5. Privacy</h3>
      <p>
        Our handling of your data — including cookies — is described in the <a href="" onClick={e => e.preventDefault()}>Privacy Policy</a>, which forms part of these terms.
      </p>

      <h3>6. Termination</h3>
      <p>
        You may stop using the service at any time and request deletion of your data. We may suspend accounts that
        violate these terms.
      </p>

      <h3>7. Disclaimers & liability</h3>
      <p>The service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, we are not liable for indirect or consequential damages.</p>

      <h3>8. Changes</h3>
      <p>We may update these terms; material changes will be notified in the product. Continued use after changes take effect constitutes acceptance.</p>

      <h3>9. Contact</h3>
      <p>Legal questions: <a href="mailto:legal@neurograph.example">legal@neurograph.example</a></p>
    </div>
  );
}
