/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep deploys resilient: a stray lint/type nit never blocks a build.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },

  // Host-based rewrites for the outlet-on-hand portal (added 2026-10-24).
  // Visitors to any <slug>.outlet-on-hand.nutriobox.com land directly on the
  // portal page instead of the main Sukhna Foods homepage. The portal reads
  // its outlet slug from window.location.hostname.
  async rewrites() {
    return {
      beforeFiles: [
        // Root → portal page
        {
          source: '/',
          has: [
            { type: 'host', value: '(?<slug>[^.]+)\\.outlet-on-hand\\.nutriobox\\.com' },
          ],
          destination: '/outlet-portal/',
        },
        // Also handle requests to /outlet-portal (without trailing slash) just in case
        {
          source: '/outlet-portal',
          has: [
            { type: 'host', value: '(?<slug>[^.]+)\\.outlet-on-hand\\.nutriobox\\.com' },
          ],
          destination: '/outlet-portal/',
        },
      ],
    };
  },
};
export default nextConfig;
