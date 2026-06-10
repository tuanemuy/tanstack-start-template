type SkeletonProps = {
  className?: string;
};

/**
 * Visual placeholder block for loading states.
 *
 * `aria-hidden` because the surrounding skeleton container owns the single
 * status announcement (`role="status"` + sr-only label); individual bars must
 * not each speak to a screen reader. `motion-reduce:animate-none` respects
 * `prefers-reduced-motion`.
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded bg-neutral-200 motion-reduce:animate-none ${className}`}
    />
  );
}
