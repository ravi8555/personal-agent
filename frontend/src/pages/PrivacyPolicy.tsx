import { COOKIE_CATEGORIES } from "../context/ConsentContext";

export const PRIVACY_LAST_UPDATED = "August 23, 2026";

/** Content-only — rendered inside the LegalModal popup. */
export function PrivacyPolicy() {
  return (
    <div className="legal-content">
      <p className="legal-updated">Last updated: {PRIVACY_LAST_UPDATED}</p>

      <p>
        NeuroGraph ("we", "our", "the assistant") is a personal AI assistant. This policy explains what
        we store, why we store it, and the choices you have. The short version: <strong>your memory graph
        is yours</strong> — we collect the minimum needed to run the product, and advertising trackers are
        off by default.
      </p>

      <h3>1. Information we process</h3>
      <ul>
        <li>
          <strong>Conversation content:</strong> messages you send so the assistant can respond and maintain
          memory (summaries, facts, relations, feedback).
        </li>
        <li>
          <strong>Derived knowledge:</strong> structured entries extracted from your conversations (e.g. "you
          prefer tea") stored in your personal knowledge graph.
        </li>
        <li>
          <strong>Local preferences:</strong> theme choice and cookie decisions stored in your browser.
        </li>
      </ul>

      <h3>2. Cookies & similar technologies</h3>
      <p>We use first-party browser storage only — no third-party ad trackers. The categories:</p>
      <table className="legal-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Purpose</th>
            <th>Default</th>
          </tr>
        </thead>
        <tbody>
          {COOKIE_CATEGORIES.map(c => (
            <tr key={c.id}>
              <td>{c.title}</td>
              <td>{c.description}</td>
              <td>{c.required ? "Always on" : "Off until you opt in"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>You can review or change your choices anytime via Privacy Choices in the header.</p>

      <h3>3. How your memory graph works</h3>
      <ul>
        <li>New conversation knowledge is processed in periodic background cycles.</li>
        <li>When statements conflict, newer explicit statements supersede older ones.</li>
        <li>Historical feedback may be retained for transparency even after a correction.</li>
      </ul>

      <h3>4. Your rights & controls</h3>
      <ul>
        <li><strong>Access & export:</strong> request a copy of your stored knowledge.</li>
        <li><strong>Rectification:</strong> correct facts by simply telling the assistant.</li>
        <li><strong>Erasure:</strong> request deletion of specific memories or your entire graph.</li>
        <li><strong>Objection:</strong> turn off functional, analytics or marketing storage at any time.</li>
      </ul>

      <h3>5. Data sharing</h3>
      <p>
        We do not sell personal data. Processors (e.g. hosting or model providers) act only on our instructions under contract.
      </p>

      <h3>6. Security</h3>
      <p>
        Data in transit is encrypted (TLS). Access to stored knowledge is restricted to your account and the
        processes that operate it.
      </p>

      <h3>7. Children</h3>
      <p>NeuroGraph is not directed at children under 13, and we do not knowingly collect their data.</p>

      <h3>8. Contact</h3>
      <p>Questions or requests: <a href="mailto:privacy@neurograph.example">privacy@neurograph.example</a></p>
    </div>
  );
}
