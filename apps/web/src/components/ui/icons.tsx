import * as React from 'react';


/**
 * The icon set.
 *
 * Every glyph in the product is here, drawn as an inline SVG. `lucide-react` is nominally a
 * dependency but is imported nowhere in this application, and one file of hand-drawn strokes is
 * cheaper and more consistent than a tree-shaken crate for six shapes — the strokes are all 1.7px on
 * the same 24-unit grid, so they cannot drift apart the way a mixed set does.
 *
 * All of them inherit `currentColor` and are `aria-hidden`: an icon next to a label is decoration,
 * and an icon that *is* the label belongs on a control that already carries an `aria-label`.
 */
type IconProps = React.SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-2 8-2 8h16s-2-1-2-8" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </Svg>
  );
}

/** The bookmark. Filled when saved, outlined when not — state is a shape, not only a colour. */
export function HeartIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="M12 20.3s-7.6-4.6-7.6-9.6a4.3 4.3 0 0 1 7.6-2.8 4.3 4.3 0 0 1 7.6 2.8c0 5-7.6 9.6-7.6 9.6Z" />
    </svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 13 4.5 4.5L19 7" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/**
 * The wireframe cube.
 *
 * Standing in for the product's subject — a 3D object — wherever an image is missing or an empty
 * state needs a mark. Drawn rather than illustrated for the same reason as the rest: it inherits the
 * text colour and so works on every surface.
 */
export function CubeIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
      aria-hidden
      width="24"
      height="24"
      {...props}
    >
      <path d="M12 2.6 21 7.5v9L12 21.4 3 16.5v-9z" />
      <path d="M3 7.5l9 4.9 9-4.9M12 12.4v9" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </Svg>
  );
}

export function UploadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V4m0 0L7 9m5-5 5 5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </Svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6M17.5 20a5.4 5.4 0 0 0-2-4.2" />
    </Svg>
  );
}
