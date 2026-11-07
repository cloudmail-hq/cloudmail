import * as React from "react";
import { cn } from "~/lib/utils";

export interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Shows a pending affordance and blocks input while a write is in flight. */
  busy?: boolean;
}

/**
 * Accessible on/off switch.
 *
 * A native `<button role="switch">` rather than a styled checkbox: buttons are
 * keyboard-operable with Space and Enter for free, and screen readers announce
 * `aria-checked` as on/off without needing a visually hidden input.
 *
 * Pair with `aria-label` or `aria-labelledby` — the control has no text of its
 * own, so it is unlabelled otherwise.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, busy, disabled, className, ...props }, ref) => {
    const inert = disabled || busy;

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-busy={busy || undefined}
        disabled={inert}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5",
          // The track stays 20px; on touch an invisible 44px box around it
          // takes the tap (WCAG 2.5.8), so a switch alone in a row is still
          // easy to hit. Centred, so it doesn't shift the layout.
          "touch:after:absolute touch:after:left-1/2 touch:after:top-1/2 touch:after:h-11 touch:after:w-11 touch:after:-translate-x-1/2 touch:after:-translate-y-1/2 touch:after:content-['']",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          // The off track has its own token: `bg-muted` nearly matched the card.
          checked ? "bg-accent" : "bg-switch-off",
          inert ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          className
        )}
        {...props}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none h-4 w-4 rounded-full bg-white shadow-sm",
            "transition-transform duration-150",
            checked ? "translate-x-4" : "translate-x-0",
            busy && "animate-pulse"
          )}
        />
      </button>
    );
  }
);
Switch.displayName = "Switch";

export { Switch };
