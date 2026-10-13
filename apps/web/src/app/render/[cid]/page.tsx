'use client';

/**
 * Headless render surface for thumbnail generation.
 *
 * Deliberately outside the authenticated console: it renders one model, full-bleed, with no
 * navigation, no session and no chrome, so a screenshot of it is exactly the asset.
 *
 * `scripts/render-thumbnails.mjs` drives this page with a real browser and saves the canvas, which is
 * how the marketplace gets genuine preview images instead of decorative placeholders. Rendering is a
 * build-time step, not a request-time one: a card must never cost a 13 MB download.
 */
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { ModelViewer } from '../../../components/model-viewer';

function RenderSurface() {
  const params = useParams<{ cid: string }>();
  const search = useSearchParams();
  const format = search.get('format') ?? '.glb';

  return (
    <div className="fixed inset-0">
      <ModelViewer
        cid={params.cid}
        format={format}
        compact
        /*
          `frameFit="box"`, decided by measurement rather than by reasoning.

          This replaced a sphere fit, and the sphere fit was a mistake I could only see by measuring.
          Fitting the *circumscribed sphere* makes the sphere subtend a constant angle, which sounds
          like consistent scale but is not: an elongated subject (the whale skeleton is 13 × 38 × 16)
          has a bounding sphere far larger than the animal, so it renders small, while a compact one
          (the scanned heart) has a sphere that hugs it and renders large. Side by side in a grid, the
          whale looked lost in its tile and the heart looked oversized — the "some are big, some are
          small" complaint, caused by the very setting meant to prevent it.

          Measured on the rendered output (longest on-screen dimension per model, 1200 × 900):
          sphere gave drill 43%, crane 50%, whale 37%, heart 54% — every model small and unrelated to
          the others. Box gave drill 83%, crane 72%, whale 74%, heart 75% — every model about 1.8×
          larger and grouped much more tightly, which is what a catalogue grid needs, because the
          subject now occupies roughly the same share of every tile.

          A third option was implemented and rejected: fitting the projected silhouette exactly. It
          should be better (a bounding box is not a silhouette) but on screen it disagreed with what
          three.js rendered — it predicted a 46%-wide whale where the render was 76% — and the cause
          was never found. Shipping an unexplained discrepancy in the camera would have been worse
          than shipping the simpler fit that measures correctly.

          `fill` is below 1 because a box fit does not guarantee the silhouette is centred inside its
          box. At 0.82 every measured model kept at least 4.6% clearance from the frame edge, so
          nothing is cropped, and it is higher than the interactive viewer's because a thumbnail has
          no chrome to dodge.
        */
        frameFit="box"
        fill={0.82}
        /*
          The readiness signal the renderer waits for.

          "A canvas exists" is not readiness — the canvas mounts long before the model arrives, so a
          slow file produced a screenshot of an empty stage. This fires when the geometry has been
          decoded *and* the camera has framed it, which is the first frame that actually shows the
          asset. Declared on `window` rather than passed any other way because the consumer is a
          Playwright `waitForFunction`, which evaluates in page context.
        */
        onReady={() => {
          (window as unknown as { __voidSpaceRenderReady?: boolean }).__voidSpaceRenderReady = true;
        }}
      />
    </div>
  );
}

export default function RenderPage() {
  return (
    <Suspense fallback={null}>
      <RenderSurface />
    </Suspense>
  );
}
