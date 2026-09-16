import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Marketing-only product viewer host. On this subdomain we serve ONLY the
// self-contained product viewer page and block every dashboard route / API,
// so the marketing team cannot reach the rest of the operations dashboard.
const VIEWER_HOST = 'productviewer.sukhnafoods.com';
const VIEWER_FILE = '/product-viewer/index.html';

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase().split(':')[0];

  // Any other host (the main opsdashboard) is completely unaffected.
  if (host !== VIEWER_HOST) return NextResponse.next();

  const path = req.nextUrl.pathname;

  // Allow the product viewer file itself (it is fully self-contained).
  if (path === VIEWER_FILE || path === '/product-viewer' || path === '/product-viewer/') {
    if (path !== VIEWER_FILE) {
      const url = req.nextUrl.clone();
      url.pathname = VIEWER_FILE;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  // Root of the subdomain -> show the product viewer.
  if (path === '/') {
    const url = req.nextUrl.clone();
    url.pathname = VIEWER_FILE;
    return NextResponse.rewrite(url);
  }

  // Everything else on this subdomain (dashboard pages, /api, etc.) is blocked.
  return new NextResponse('Not found', { status: 404 });
}

export const config = {
  // Run on all routes except Next's internal static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
