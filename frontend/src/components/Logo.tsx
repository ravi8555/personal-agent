interface LogoProps {
  /** Size of the mark in px. */
  size?: number;
  /** Show the wordmark + tagline next to the mark. */
  withText?: boolean;
  variant?: "default" | "footer";
}

export function Logo({ size = 40, withText = true, variant = "default" }: LogoProps) {
  return (
    <span className={`logo ${variant === "footer" ? "logo--footer" : ""}`}>
      <img
        src="/assets/logo.svg"
        alt="NeuroGraph logo"
        width={size}
        height={size}
        className="logo__mark"
        loading="eager"
      />
      {withText && (
        <span className="logo__text">
          <span className="logo__name">NeuroGraph</span>
          {variant !== "footer" && (
            <span className="logo__tagline">Personal AI Assistant</span>
          )}
        </span>
      )}
    </span>
  );
}