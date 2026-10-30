/**
 * Brand mark. No official logo is bundled; set VITE_PUBLIC_BRAND_LOGO_URL to an
 * approved asset (e.g. /branding/logo.svg) to display it.
 */
const LOGO_URL = import.meta.env.VITE_PUBLIC_BRAND_LOGO_URL as string | undefined;

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      {LOGO_URL ? (
        <img src={LOGO_URL} alt="Tekpro" className="brand-logo" />
      ) : (
        <span className="brand-mark" aria-hidden="true">
          T
        </span>
      )}
      {!compact && (
        <span className="brand-text">
          <span className="brand-name">Tekpro</span>
          <span className="brand-product">Document Portal</span>
        </span>
      )}
    </span>
  );
}
