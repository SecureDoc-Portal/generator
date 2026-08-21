/**
 * GitHub Pages serves static files only, so the app is exported as static
 * HTML/JS. There are deliberately no API routes: anything that must run
 * server-side lives in a Supabase Edge Function (see supabase/functions).
 *
 * A project page is served from https://<user>.github.io/<repo>/, so assets
 * need a basePath. The deploy workflow sets NEXT_PUBLIC_BASE_PATH from the
 * repository name; locally it is empty and the app runs at /.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,          // /v/ resolves to /v/index.html on Pages
  images: { unoptimized: true },
  reactStrictMode: true,
};
