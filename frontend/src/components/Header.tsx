import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

interface HeaderProps {
  onPrivacy: () => void;
  onTerms: () => void;
  onChoices: () => void;
}

/** Minimal top bar: brand, legal links, theme toggle. Stays pinned, never scrolls. */
export function Header({ onPrivacy, onTerms, onChoices }: HeaderProps) {
  return (
    <header className="header">
      <button type="button" className="header__brand" aria-label="NeuroGraph — home">
        <Logo size={32} withText={false} />
      </button>

      <nav className="header__nav" aria-label="Legal">
        <button type="button" className="header__link" onClick={onPrivacy}>
          Privacy
        </button>
        <button type="button" className="header__link" onClick={onTerms}>
          Terms
        </button>
        <button type="button" className="header__link" onClick={onChoices}>
          Privacy Choices
        </button>
      </nav>

      <ThemeToggle />
    </header>
  );
}
