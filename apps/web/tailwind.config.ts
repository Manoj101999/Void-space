import type { Config } from 'tailwindcss';
import voidSpacePreset from '@void-space/config/tailwind/preset';

/**
 * Tailwind theme for the product.
 *
 * Two rules govern this file:
 *
 *   1. **Tokens are CSS custom properties**, matching the shadcn/ui "CSS variables" convention the
 *      shared preset already establishes (SRS §3.2). The variable values live in `globals.css`; here
 *      they are only named, so a component writes `bg-surface text-ink-dim border-hairline` and the
 *      palette stays a runtime concern.
 *   2. **This file is the vocabulary.** Anything a screen needs that is not a Tailwind utility gets
 *      added here as a theme value — a background image, a shadow, a keyframe — rather than becoming
 *      a bespoke class in the stylesheet. `globals.css` is then left with only what a utility
 *      genuinely cannot express: `@font-face`, base element defaults, pseudo-element art, and masks.
 *
 * The names are deliberately semantic rather than literal (`surface`, not `grey-900`), because the
 * design system documents a light theme that is not implemented yet: when it is, the variables move
 * and no component has to.
 */
const config: Config = {
  presets: [voidSpacePreset as Config],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* Ground and raised surfaces. `base` is the page, `deeper` is a band or a well, `surface`
           is a card. Three steps is the whole elevation scale — depth comes from tone, not glow. */
        base: 'var(--fc-bg)',
        deeper: 'var(--fc-bg-lighter)',
        surface: {
          DEFAULT: 'var(--fc-surface)',
          raised: 'var(--fc-surface-raised)',
        },

        /* Text. `ink` is body and headings, `dim` is secondary, `faint` is metadata. */
        ink: {
          DEFAULT: 'var(--fc-fg)',
          dim: 'var(--vs-fg-dim)',
          faint: 'var(--vs-fg-faint)',
        },

        /* The one accent. `brand` marks the single most important action on a view and nothing else. */
        brand: {
          DEFAULT: 'var(--fc-heat)',
          warm: 'var(--fc-heat-warm)',
          dim: 'var(--fc-heat-dim)',
        },

        /* Heat at fixed opacities.
         *
         * Kept as named values rather than written as Tailwind opacity modifiers (`bg-brand/12`),
         * because the palette lives in CSS custom properties: a modifier on a `var()` colour is
         * silently dropped, and a tint that quietly does nothing is worse than no tint at all. */
        'heat-4': 'var(--fc-heat-4)',
        'heat-8': 'var(--fc-heat-8)',
        'heat-12': 'var(--fc-heat-12)',
        'heat-16': 'var(--fc-heat-16)',
        'heat-20': 'var(--fc-heat-20)',
        'heat-40': 'var(--fc-heat-40)',

        /* Translucent neutrals, for a fill that has to sit on any surface without knowing which. */
        veil: {
          4: 'var(--fc-a-4)',
          6: 'var(--fc-a-6)',
          8: 'var(--fc-a-8)',
          12: 'var(--fc-a-12)',
          16: 'var(--fc-a-16)',
          24: 'var(--fc-a-24)',
        },

        /* Hairlines. Two steps: `hairline` for a border you read, `hairline-strong` for one you look
           for (a hover state, a divider inside a card). */
        hairline: {
          DEFAULT: 'var(--vs-line)',
          strong: 'var(--vs-line-strong)',
        },

        /* Lifecycle states (§5.1). Semantic, not decorative: honey waits, amethyst escalates,
           forest succeeds, crimson fails, heat marks work still to be done. */
        state: {
          draft: 'var(--vs-draft)',
          pending: 'var(--vs-pending)',
          review: 'var(--vs-review)',
          approved: 'var(--vs-approved)',
          published: 'var(--vs-published)',
          rejected: 'var(--vs-rejected)',
          revision: 'var(--vs-revision)',
        },
      },

      /* Firecrawl's shape family: 8 for controls, 12 for cards, 16 for large surfaces. */
      borderRadius: {
        control: '8px',
        card: '12px',
        surface: '16px',
      },

      fontFamily: {
        sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      boxShadow: {
        /* The stacked warm shadow on the primary button, straight from DESIGN.md. */
        heat: 'var(--fc-shadow-heat)',
        panel: 'var(--vs-shadow)',
        float: 'var(--vs-shadow-lg)',
      },

      backgroundImage: {
        /* The hairline grid: a drafted surface, used inside hero bands, card wells and stage
           placeholders. Paired with a mask so it never competes with the content on top of it. */
        'grid-faint':
          'linear-gradient(to right, var(--fc-a-4) 1px, transparent 1px), linear-gradient(to bottom, var(--fc-a-4) 1px, transparent 1px)',
        /* A single soft light source in the top-left, for a hero band that needs warmth without a
           gradient wash. */
        'heat-glow':
          'radial-gradient(120% 100% at 0% 0%, var(--fc-heat-12), transparent 58%)',
        /* The scrim under a card overlay, so a name stays readable over any render. */
        'scrim': 'linear-gradient(to top, rgba(10,10,10,0.94), rgba(10,10,10,0.55) 45%, transparent)',

        /*
         * ⚠ Custom `bg-*` image keys are safe in a plain `className`, and **not** safe inside `cn()`.
         *
         * `tailwind-merge` resolves a `bg-` utility's family from its value, and an unrecognised value
         * like `grid-faint` looks like a colour to it. So `cn('bg-surface', 'bg-grid-faint')` keeps one
         * class and deletes the other, in either direction, and `cn('bg-deeper', 'bg-grid-faint',
         * 'bg-grid-sm')` collapses to `bg-grid-sm` alone — silently, at build time, with no warning and
         * no error.
         *
         * The keys above are therefore used only as literal `className` attributes. Where a background
         * image has to survive a merge with other utilities, declare it as a CSS custom property and read
         * it from a rule in `globals.css` instead — `--vs-select-chevron` is the worked example.
         *
         * Verified with tailwind-merge installed in this repo; if either side is upgraded, re-check
         * before moving any of these into a `cn()` call.
         */
      },

      backgroundSize: {
        grid: '32px 32px',
        'grid-lg': '56px 56px',
        'grid-sm': '24px 24px',
      },

      transitionTimingFunction: {
        /* The standard transition from DESIGN.md, verbatim. */
        standard: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
      },

      keyframes: {
        shimmer: {
          from: { backgroundPosition: '120% 0' },
          to: { backgroundPosition: '-120% 0' },
        },
        rise: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'dot-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },

      animation: {
        shimmer: 'shimmer 1.4s cubic-bezier(0.25, 0.1, 0.25, 1) infinite',
        rise: 'rise 360ms cubic-bezier(0.25, 0.1, 0.25, 1) both',
        'dot-pulse': 'dot-pulse 2.4s cubic-bezier(0.25, 0.1, 0.25, 1) infinite',
      },
    },
  },
};

export default config;

