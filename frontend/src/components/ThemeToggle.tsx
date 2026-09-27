import { useTheme } from "../context/ThemeContext";

/** Header control that flips between light and dark mode. */
export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="theme-toggle__icon" aria-hidden="true">
        {isDark ? "🌙" : "☀️"}
      </span>
    </button>
  );
}