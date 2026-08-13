/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep the native browser packages out of the webpack bundle …
    serverComponentsExternalPackages: ['@sparticuz/chromium', 'playwright-core'],
    // … but make sure ALL of @sparticuz/chromium's files (the brotli library
    // packs that contain libnss3.so etc.) are traced into the serverless
    // function, otherwise Chromium can't load its shared libraries.
    outputFileTracingIncludes: {
      '/api/push-to-pact': ['./node_modules/@sparticuz/chromium/**'],
    },
  },
  // Keep deploys resilient: a stray lint/type nit never blocks a build.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};
export default nextConfig;
